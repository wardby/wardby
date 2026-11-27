/**
 * Sharing tools over MCP, against real PostgreSQL: read shows a tool without its
 * code, use lets a grantee attach it to their own agent, write adds nothing beyond
 * use, only the owner (or a Team it belongs to) grants, and lowering a grant detaches
 * the tool from agents whose owner can no longer use it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { resolveStanding } from "../../core/teams/standing.js";
import { addMember, createTeam, type TeamActor } from "../../core/teams/teams.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerGrantTools } from "./grants.js";
import { registerToolAuthoringTools } from "./tools.js";

const db = createPrismaClient();
const CANONICAL = "https://host/mcp";
const suffix = randomUUID();
const CODE = `return "secret-code-${suffix}";`;
const principalIds: string[] = [];
const teamIds: string[] = [];
const toolIds: string[] = [];
const agentIds: string[] = [];

type Result = { isError?: boolean; content: { text: string }[] };
const text = (r: Result) => r.content[0].text;

async function principal(label: string): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `tool-share-${label}-${suffix}` } });
  principalIds.push(p.id);
  return p;
}

async function tool(ownerId: string) {
  const t = await db.tool.create({
    data: {
      name: `tool-${randomUUID()}`,
      description: "shared tool",
      paramsZod: "z.object({})",
      jsonSchema: {},
      code: CODE,
      ownerId,
    },
  });
  toolIds.push(t.id);
  return t;
}

async function agent(ownerId: string) {
  const a = await db.agent.create({
    data: { name: `ts-${randomUUID()}`, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1, ownerId },
  });
  agentIds.push(a.id);
  return a;
}

async function connect(who: Principal) {
  const standing = await resolveStanding(db, who.id);
  const providers = {} as McpProviders;
  const ctx: McpRequestContext = {
    principal: who,
    scopes: new Set(["wardby:write"]),
    roles: [...standing.roles],
    actsFor: standing.actsFor,
    teamIds: standing.teamIds,
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  mcp.setFixedContext(ctx);
  registerToolAuthoringTools(mcp);
  registerGrantTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as Result,
    close: () => client.close(),
  };
}

const share = (resourceId: string, grantee: Principal | "everyone", level: string) => ({
  resourceType: "tool",
  resourceId,
  grantee: grantee === "everyone" ? "everyone" : { principalId: grantee.id },
  level,
});

describe.skipIf(!process.env.DATABASE_URL)("sharing tools (PostgreSQL)", () => {
  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: toolIds } } });
    await db.agentTool.deleteMany({ where: { toolId: { in: toolIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.tool.deleteMany({ where: { id: { in: toolIds } } });
    await db.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
    await db.team.deleteMany({ where: { id: { in: teamIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("a stranger neither sees, attaches nor grants on someone's tool", async () => {
    const owner = await principal("owner1");
    const stranger = await principal("stranger1");
    const t = await tool(owner.id);
    const mine = await agent(stranger.id);

    const asStranger = await connect(stranger);
    expect(text(await asStranger.call("list_tools", {}))).not.toContain(t.id);
    expect((await asStranger.call("attach_tool", { agentId: mine.id, toolId: t.id })).isError).toBe(true);
    expect((await asStranger.call("grant_access", share(t.id, stranger, "use"))).isError).toBe(true);
    await asStranger.close();
  });

  it("read shows the tool without its code; only use attaches it", async () => {
    const owner = await principal("owner2");
    const reader = await principal("reader2");
    const user = await principal("user2");
    const t = await tool(owner.id);
    const readerAgent = await agent(reader.id);
    const userAgent = await agent(user.id);

    const asOwner = await connect(owner);
    expect(text(await asOwner.call("list_tools", {}))).toContain(CODE.slice(8, 30));
    await asOwner.call("grant_access", share(t.id, reader, "read"));
    await asOwner.call("grant_access", share(t.id, user, "use"));
    await asOwner.close();

    const asReader = await connect(reader);
    const listed = text(await asReader.call("list_tools", {}));
    expect(listed).toContain(t.id);
    expect(listed).not.toContain("secret-code");
    const refused = await asReader.call("attach_tool", { agentId: readerAgent.id, toolId: t.id });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/needs use access; you have read access/);
    await asReader.close();

    const asUser = await connect(user);
    expect((await asUser.call("attach_tool", { agentId: userAgent.id, toolId: t.id })).isError).toBeFalsy();
    expect(await db.agentTool.count({ where: { agentId: userAgent.id, toolId: t.id } })).toBe(1);
    // A use grant never lets the grantee change or delete the owner's code, or re-grant it.
    expect((await asUser.call("delete_tool", { toolId: t.id })).isError).toBe(true);
    expect((await asUser.call("grant_access", share(t.id, reader, "use"))).isError).toBe(true);
    await asUser.close();
  });

  it("lowering or revoking a grant detaches the tool from agents whose owner can no longer use it", async () => {
    const owner = await principal("owner3");
    const user = await principal("user3");
    const t = await tool(owner.id);
    const usersAgent = await agent(user.id);
    const ownersAgent = await agent(owner.id);
    await db.agentTool.create({ data: { agentId: ownersAgent.id, toolId: t.id } });

    const asOwner = await connect(owner);
    await asOwner.call("grant_access", share(t.id, user, "use"));
    const asUser = await connect(user);
    await asUser.call("attach_tool", { agentId: usersAgent.id, toolId: t.id });
    await asUser.close();

    const lowered = await asOwner.call("grant_access", share(t.id, user, "read"));
    expect(JSON.parse(text(lowered)).attachmentsRemoved).toBe(1);
    expect(await db.agentTool.count({ where: { agentId: usersAgent.id, toolId: t.id } })).toBe(0);
    // The owner's own attachment is untouched.
    expect(await db.agentTool.count({ where: { agentId: ownersAgent.id, toolId: t.id } })).toBe(1);

    await asOwner.call("grant_access", share(t.id, user, "use"));
    await db.agentTool.create({ data: { agentId: usersAgent.id, toolId: t.id, attachedById: user.id } });
    const revoked = await asOwner.call("revoke_access", {
      resourceType: "tool",
      resourceId: t.id,
      grantee: { principalId: user.id },
    });
    expect(JSON.parse(text(revoked)).attachmentsRemoved).toBe(1);
    expect(await db.agentTool.count({ where: { agentId: usersAgent.id, toolId: t.id } })).toBe(0);
    await asOwner.close();
  });

  it("cleanup keeps an attachment its attacher may still make: a write-grantee's own tool, a Team member's Team tool", async () => {
    const bob = await principal("bob5");
    const carol = await principal("carol5");
    const dave = await principal("dave5");
    const bobsTool = await tool(bob.id);
    const carolsAgent = await agent(carol.id);
    // Bob attached his own tool to Carol's agent (he holds write on it); Carol holds no grant on the tool.
    await db.agentTool.create({ data: { agentId: carolsAgent.id, toolId: bobsTool.id, attachedById: bob.id } });
    const asBob = await connect(bob);
    await asBob.call("grant_access", share(bobsTool.id, dave, "use"));
    const revoked = await asBob.call("revoke_access", {
      resourceType: "tool",
      resourceId: bobsTool.id,
      grantee: { principalId: dave.id },
    });
    expect(JSON.parse(text(revoked)).attachmentsRemoved ?? 0).toBe(0);
    expect(await db.agentTool.count({ where: { agentId: carolsAgent.id, toolId: bobsTool.id } })).toBe(1);
    await asBob.close();

    // A Team member attached the Team's tool to her own agent; the Team's grants changing does not undo it.
    const member = await principal("member5");
    const admin: TeamActor = { principalId: member.id, roles: new Set(["admin"]) };
    const team = await createTeam(db, admin, { name: `tkeep-${suffix}` });
    teamIds.push(team.id);
    principalIds.push(team.principalId);
    await addMember(db, admin, team.id, member.id);
    const teamsTool = await tool(team.principalId);
    const membersAgent = await agent(member.id);
    await db.agentTool.create({ data: { agentId: membersAgent.id, toolId: teamsTool.id, attachedById: member.id } });
    const asMember = await connect(member);
    await asMember.call("grant_access", share(teamsTool.id, dave, "use"));
    await asMember.call("revoke_access", {
      resourceType: "tool",
      resourceId: teamsTool.id,
      grantee: { principalId: dave.id },
    });
    expect(await db.agentTool.count({ where: { agentId: membersAgent.id, toolId: teamsTool.id } })).toBe(1);
    await asMember.close();
  });

  it("an everyone grant is capped at use; a Team member grants for the Team's tool", async () => {
    const owner = await principal("owner4");
    const member = await principal("member4");
    const other = await principal("other4");
    const t = await tool(owner.id);
    const asOwner = await connect(owner);
    expect((await asOwner.call("grant_access", share(t.id, "everyone", "write"))).isError).toBe(true);
    expect((await asOwner.call("grant_access", share(t.id, "everyone", "use"))).isError).toBeFalsy();
    await asOwner.close();

    const admin: TeamActor = { principalId: member.id, roles: new Set(["admin"]) };
    const team = await createTeam(db, admin, { name: `tst-${suffix}` });
    teamIds.push(team.id);
    principalIds.push(team.principalId);
    await addMember(db, admin, team.id, member.id);
    const teamsTool = await tool(team.principalId);
    const asMember = await connect(member);
    expect((await asMember.call("grant_access", share(teamsTool.id, other, "use"))).isError).toBeFalsy();
    // The Team's member sees the tool's code, as its owner.
    expect(text(await asMember.call("list_tools", {}))).toContain("secret-code");
    await asMember.close();
  });
});
