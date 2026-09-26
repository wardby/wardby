import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { PrismaClient } from "#prisma";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import { localOperatorContext } from "../index.js";
import { buildMcpServer } from "../server.js";
import { assertAgentAccess, readableAgentsWhere, requireAgentAccess, requireBindingOwner } from "./access.js";

type Row = { id: string; ownerId: string | null };

function fakeDb(agents: Row[], grants: FakeGrantSeed[] = []) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return {
    agent: { findUnique: async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null },
    resourceGrant: fakeResourceGrants(grants),
  } as unknown as PrismaClient;
}

function ctx(db: PrismaClient, principalId: string, extra: Partial<McpRequestContext> = {}): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(),
    roles: [],
    canonicalUri: "https://host/mcp",
    providers: {} as never,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
    ...extra,
  };
}

async function failure(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (err) {
    return err as McpError;
  }
  throw new Error("expected a rejection");
}

describe("requireAgentAccess", () => {
  const db = fakeDb(
    [
      { id: "a1", ownerId: "owner" },
      { id: "pub", ownerId: null },
    ],
    [
      { resourceType: "agent", resourceId: "a1", principalId: "reader", level: "read" },
      { resourceType: "agent", resourceId: "a1", principalId: "runner", level: "execute" },
      { resourceType: "agent", resourceId: "a1", principalId: "writer", level: "write" },
      { resourceType: "agent", resourceId: "pub", granteeKind: "everyone", level: "execute" },
    ],
  );

  it("404s below read with text identical to a missing row", async () => {
    const missing = await failure(requireAgentAccess(ctx(db, "stranger"), "nope", "read"));
    const hidden = await failure(requireAgentAccess(ctx(db, "stranger"), "a1", "read"));
    expect(missing.httpStatus).toBe(404);
    expect(hidden.httpStatus).toBe(404);
    expect(hidden.message).toBe(missing.message.replace("nope", "a1"));
  });

  it("403s at read or above but below the required level, naming both levels", async () => {
    const err = await failure(requireAgentAccess(ctx(db, "reader"), "a1", "execute"));
    expect(err.httpStatus).toBe(403);
    expect(err.message).toMatch(/execute/);
    expect(err.message).toMatch(/read/);
    const owner = await failure(requireAgentAccess(ctx(db, "writer"), "a1", "owner"));
    expect(owner.httpStatus).toBe(403);
    expect(owner.message).toMatch(/owner/);
    expect(owner.message).toMatch(/write/);
  });

  it("returns the row and the access held", async () => {
    expect((await requireAgentAccess(ctx(db, "runner"), "a1", "execute")).access).toBe("execute");
    expect((await requireAgentAccess(ctx(db, "owner"), "a1", "owner")).access).toBe("owner");
    expect((await requireAgentAccess(ctx(db, "anyone"), "pub", "execute")).access).toBe("execute");
  });

  it("nobody but the operator reaches write on an owner-less agent", async () => {
    expect((await failure(requireAgentAccess(ctx(db, "anyone"), "pub", "write"))).httpStatus).toBe(403);
    const operator = ctx(db, "local", { operator: true });
    expect((await requireAgentAccess(operator, "pub", "owner")).access).toBe("owner");
  });

  it("assertAgentAccess works on a row already read", async () => {
    const { access } = await assertAgentAccess(ctx(db, "writer"), { id: "a1", ownerId: "owner" }, "a1", "write");
    expect(access).toBe("write");
    expect((await failure(assertAgentAccess(ctx(db, "writer"), null, "a1", "read"))).httpStatus).toBe(404);
  });
});

describe("requireBindingOwner", () => {
  const db = fakeDb([]);

  it("allows only the agent's owner", () => {
    expect(() => requireBindingOwner(ctx(db, "owner"), { id: "a1", ownerId: "owner" })).not.toThrow();
    expect(() => requireBindingOwner(ctx(db, "writer"), { id: "a1", ownerId: "owner" })).toThrow(McpError);
  });

  it("the stdio operator does not bypass it, and an owner-less agent has no binding owner", () => {
    const operator = ctx(db, "local", { operator: true });
    expect(() => requireBindingOwner(operator, { id: "a1", ownerId: "owner" })).toThrow(/owner/);
    expect(() => requireBindingOwner(operator, { id: "pub", ownerId: null })).toThrow(/no owner/);
    expect(() => requireBindingOwner(operator, { id: "mine", ownerId: "local" })).not.toThrow();
  });
});

describe("readableAgentsWhere", () => {
  it("is own rows plus rows granted at least read", async () => {
    const db = fakeDb(
      [],
      [
        { resourceType: "agent", resourceId: "g1", principalId: "p", level: "read" },
        { resourceType: "agent", resourceId: "g2", granteeKind: "everyone", level: "execute" },
      ],
    );
    const where = await readableAgentsWhere(ctx(db, "p"));
    expect(where).toEqual({ OR: [{ ownerId: "p" }, { id: { in: expect.arrayContaining(["g1", "g2"]) as never } }] });
  });

  it("is unfiltered for the operator", async () => {
    expect(await readableAgentsWhere(ctx(fakeDb([]), "local", { operator: true }))).toEqual({});
  });
});

describe("operator flag", () => {
  it("is set by the stdio local operator context", () => {
    const local = localOperatorContext({ id: "p", subject: "local", createdAt: new Date() }, {} as never, fakeDb([]));
    expect(local.operator).toBe(true);
  });

  it("A10: an HTTP principal whose subject equals LOCAL_PRINCIPAL is not an operator", async () => {
    const db = fakeDb([]);
    const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: "https://host/mcp" } });
    // Even with stdio's operator context installed, an authenticated HTTP
    // call resolves its own context, which never carries the flag.
    mcp.setFixedContext(
      localOperatorContext({ id: "p-local", subject: "local", createdAt: new Date() }, {} as never, db),
    );
    mcp.registerTool({
      name: "whoami",
      scope: "agents:read",
      inputSchema: {},
      handler: async (_args: unknown, c: McpRequestContext) => ({
        content: [
          { type: "text", text: JSON.stringify({ subject: c.principal.subject, operator: c.operator ?? false }) },
        ],
      }),
    });
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    const authInfo = {
      token: "t",
      clientId: "c",
      scopes: ["agents:read"],
      extra: { principal: { id: "p-http", subject: "local", createdAt: new Date() }, roles: [] },
    };
    clientTransport.send = (message, options) => send(message, { ...options, authInfo });
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    const body = JSON.parse((result.content as { text: string }[])[0].text);
    expect(body).toEqual({ subject: "local", operator: false });
    await client.close();
  });
});
