import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { PrismaClient } from "#prisma";
import { canDelegate } from "../../core/grants.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";
import type { McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerGrantTools } from "./grants.js";
import { registerTriggerTool } from "./trigger.js";

const URI = "https://host/mcp";

interface Row {
  id: string;
  name: string;
  ownerId: string | null;
}

function fakeDb(agents: Row[], principals: string[], grants: FakeGrantSeed[] = []) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const people = principals.map((id) => ({ id, subject: `sub-${id}`, createdAt: new Date() }));
  const db: any = {
    resourceGrant: fakeResourceGrants(grants),
    agent: {
      findMany: async () => [],
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = byId.get(where.id);
        return row ? { kind: "native", codingProfile: null, budgetUsd: 1, model: "m", ...row } : null;
      },
    },
    principal: {
      findUnique: async ({ where }: { where: { id?: string; subject?: string } }) =>
        people.find((p) => (where.id !== undefined ? p.id === where.id : p.subject === where.subject)) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        people.filter((p) => where.id.in.includes(p.id)),
    },
    run: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "run_1", status: "pending", ...data }),
      updateMany: async () => ({ count: 1 }),
    },
    codingRun: { create: async ({ data }: { data: unknown }) => data },
    task: { create: async ({ data }: { data: unknown }) => data },
    webhook: {},
    $queryRaw: async () => [],
  };
  db.isolationLevels = [];
  db.$transaction = async (fn: (tx: unknown) => unknown, options?: { isolationLevel?: string }) => {
    db.isolationLevels.push(options?.isolationLevel);
    return fn(db);
  };
  return db as PrismaClient & { resourceGrant: ReturnType<typeof fakeResourceGrants> };
}

function ctx(
  db: PrismaClient,
  principalId: string,
  extra: Partial<McpRequestContext> = {},
  scopes = ["agents:read", "agents:write", "runs:trigger"],
): McpRequestContext {
  return {
    principal: { id: principalId, subject: `sub-${principalId}`, createdAt: new Date() },
    scopes: new Set(scopes),
    roles: [],
    canonicalUri: URI,
    providers: { executor: { start: async () => {}, stop: async () => {} } } as never,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
    ...extra,
  };
}

async function connect(db: PrismaClient, context: McpRequestContext) {
  const mcp = buildMcpServer({ providers: context.providers, db, config: { canonicalUri: URI } });
  mcp.setFixedContext(context);
  registerGrantTools(mcp);
  registerTriggerTool(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return { mcp, client };
}

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;
const agents: Row[] = [
  { id: "a1", name: "mine", ownerId: "owner" },
  { id: "child", name: "child", ownerId: "owner" },
];
const people = ["owner", "alice", "bob", "admin"];

describe("grant_access / revoke_access / list_access", () => {
  it("the owner grants, downgrades by upsert, lists, and revokes idempotently", async () => {
    const db = fakeDb(agents, people);
    const { client } = await connect(db, ctx(db, "owner"));
    const grant = (level: string) =>
      client.callTool({
        name: "grant_access",
        arguments: { resourceType: "agent", resourceId: "a1", grantee: { subject: "sub-alice" }, level },
      });
    expect((await grant("write")).isError).toBeFalsy();
    expect((await grant("read")).isError).toBeFalsy();
    expect(db.resourceGrant.rows).toHaveLength(1);
    expect(db.resourceGrant.rows[0]).toMatchObject({
      granteeKind: "principal",
      granteePrincipalId: "alice",
      granteeKey: "principal:alice",
      level: "read",
      source: "owner",
      grantedById: "owner",
    });

    const listed = JSON.parse(
      text(await client.callTool({ name: "list_access", arguments: { resourceType: "agent", resourceId: "a1" } })),
    );
    expect(listed.grants).toEqual([
      expect.objectContaining({ grantee: { principalId: "alice", subject: "sub-alice" }, level: "read" }),
    ]);

    for (let i = 0; i < 2; i += 1) {
      const revoked = await client.callTool({
        name: "revoke_access",
        arguments: { resourceType: "agent", resourceId: "a1", grantee: { principalId: "alice" } },
      });
      expect(revoked.isError).toBeFalsy();
    }
    expect(db.resourceGrant.rows).toHaveLength(0);
    await client.close();
  });

  it("M3/M4: grant and revoke run in a Serializable transaction; a principalId grantee's subject isn't echoed", async () => {
    const db = fakeDb(agents, people);
    const { client } = await connect(db, ctx(db, "owner"));
    const granted = await client.callTool({
      name: "grant_access",
      arguments: { resourceType: "agent", resourceId: "a1", grantee: { principalId: "alice" }, level: "read" },
    });
    expect(JSON.parse(text(granted)).grantee).toEqual({ principalId: "alice" });
    expect(text(granted)).not.toContain("sub-alice");
    await client.callTool({
      name: "revoke_access",
      arguments: { resourceType: "agent", resourceId: "a1", grantee: { principalId: "alice" } },
    });
    expect((db as any).isolationLevels).toEqual(["Serializable", "Serializable"]);
    await client.close();
  });

  it("only the owner or the stdio operator can grant or revoke", async () => {
    const db = fakeDb(agents, people, [
      { resourceType: "agent", resourceId: "a1", principalId: "alice", level: "write" },
    ]);
    const writer = await connect(db, ctx(db, "alice"));
    const refused = await writer.client.callTool({
      name: "grant_access",
      arguments: { resourceType: "agent", resourceId: "a1", grantee: { subject: "sub-bob" }, level: "execute" },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/owner/);
    const noRevoke = await writer.client.callTool({
      name: "revoke_access",
      arguments: { resourceType: "agent", resourceId: "a1", grantee: { principalId: "alice" } },
    });
    expect(noRevoke.isError).toBe(true);
    await writer.client.close();

    const stranger = await connect(db, ctx(db, "bob"));
    const hidden = await stranger.client.callTool({
      name: "grant_access",
      arguments: { resourceType: "agent", resourceId: "a1", grantee: { subject: "sub-bob" }, level: "write" },
    });
    expect(text(hidden)).toMatch(/not found/);
    await stranger.client.close();

    const operator = await connect(db, ctx(db, "local", { operator: true }));
    const ok = await operator.client.callTool({
      name: "grant_access",
      arguments: { resourceType: "agent", resourceId: "a1", grantee: { subject: "sub-bob" }, level: "execute" },
    });
    expect(ok.isError).toBeFalsy();
    await operator.client.close();
  });

  it("an admin can list_access on any agent, but can't grant", async () => {
    const db = fakeDb(agents, people, [
      { resourceType: "agent", resourceId: "a1", principalId: "alice", level: "read" },
    ]);
    const admin = await connect(
      db,
      ctx(db, "admin", { roles: ["admin"] }, ["agents:read", "agents:write", "agents:admin"]),
    );
    const listed = await admin.client.callTool({
      name: "list_access",
      arguments: { resourceType: "agent", resourceId: "a1" },
    });
    expect(listed.isError).toBeFalsy();
    expect(JSON.parse(text(listed)).grants).toHaveLength(1);
    const refused = await admin.client.callTool({
      name: "grant_access",
      arguments: { resourceType: "agent", resourceId: "a1", grantee: { subject: "sub-bob" }, level: "read" },
    });
    expect(refused.isError).toBe(true);
    await admin.client.close();

    // A grantee below owner can't list who else has access.
    const grantee = await connect(db, ctx(db, "alice"));
    const denied = await grantee.client.callTool({
      name: "list_access",
      arguments: { resourceType: "agent", resourceId: "a1" },
    });
    expect(denied.isError).toBe(true);
    await grantee.client.close();
  });

  it("refuses self-grants, everyone above execute, unknown subjects, bad levels and other types", async () => {
    const db = fakeDb(agents, people);
    const { client } = await connect(db, ctx(db, "owner"));
    const call = (args: Record<string, unknown>) =>
      client.callTool({ name: "grant_access", arguments: { resourceType: "agent", resourceId: "a1", ...args } });

    const self = await call({ grantee: { principalId: "owner" }, level: "read" });
    expect(text(self)).toMatch(/owner already/i);
    const everyoneWrite = await call({ grantee: "everyone", level: "write" });
    expect(everyoneWrite.isError).toBe(true);
    expect(text(everyoneWrite)).toMatch(/execute/);
    const unknown = await call({ grantee: { subject: "nobody" }, level: "read" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/not found/i);
    const badLevel = await call({ grantee: { subject: "sub-alice" }, level: "use" });
    expect(badLevel.isError).toBe(true);
    const tool = await client.callTool({
      name: "grant_access",
      arguments: { resourceType: "tool", resourceId: "t1", grantee: "everyone", level: "use" },
    });
    expect(tool.isError).toBe(true);
    expect(text(tool)).toMatch(/not shareable yet/);
    expect(db.resourceGrant.rows).toHaveLength(0);

    const everyone = await call({ grantee: "everyone", level: "execute" });
    expect(everyone.isError).toBeFalsy();
    expect(db.resourceGrant.rows[0]).toMatchObject({
      granteeKind: "everyone",
      granteeKey: "everyone",
      level: "execute",
    });
    await client.close();
  });

  it("after revoke: trigger is refused, and the delegation edge is refused at run time", async () => {
    const db = fakeDb(
      [
        { id: "parent", name: "alice-parent", ownerId: "alice" },
        { id: "child", name: "owner-child", ownerId: "owner" },
      ],
      people,
    );
    const owner = await connect(db, ctx(db, "owner"));
    await owner.client.callTool({
      name: "grant_access",
      arguments: { resourceType: "agent", resourceId: "child", grantee: { subject: "sub-alice" }, level: "execute" },
    });
    const alice = await connect(db, ctx(db, "alice"));
    expect(
      (await alice.client.callTool({ name: "trigger_agent", arguments: { agentId: "child" } })).isError,
    ).toBeFalsy();
    expect(await canDelegate(db, { ownerId: "alice" }, { id: "child", ownerId: "owner" })).toBe(true);

    await owner.client.callTool({
      name: "revoke_access",
      arguments: { resourceType: "agent", resourceId: "child", grantee: { subject: "sub-alice" } },
    });
    const refused = await alice.client.callTool({ name: "trigger_agent", arguments: { agentId: "child" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/not found/);
    expect(await canDelegate(db, { ownerId: "alice" }, { id: "child", ownerId: "owner" })).toBe(false);
    await owner.client.close();
    await alice.client.close();
  });
});
