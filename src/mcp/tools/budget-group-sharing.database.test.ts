/**
 * Sharing budget groups over MCP, against real PostgreSQL: use lets a grantee put
 * their own agents in the group, read only does not, write also lets them change
 * it, only the owner (or a Team it belongs to) grants, and lowering a grant takes
 * the group off agents whose owner can no longer use it.
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
import { registerAgentTools } from "./agents.js";
import { registerBudgetGroupTools } from "./budget-groups.js";
import { registerGrantTools } from "./grants.js";

const db = createPrismaClient();
const CANONICAL = "https://host/mcp";
const suffix = randomUUID();
const principalIds: string[] = [];
const teamIds: string[] = [];
const groupIds: string[] = [];
const agentIds: string[] = [];

type Result = { isError?: boolean; content: { text: string }[] };
const text = (r: Result) => r.content[0].text;

async function principal(label: string): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `bg-share-${label}-${suffix}` } });
  principalIds.push(p.id);
  return p;
}

async function group(ownerId: string | null) {
  const g = await db.budgetGroup.create({ data: { name: `bg-${randomUUID()}`, ownerId } });
  groupIds.push(g.id);
  return g;
}

async function agent(ownerId: string, budgetGroupId?: string) {
  const a = await db.agent.create({
    data: {
      name: `bg-${randomUUID()}`,
      systemPrompt: "x",
      model: "gpt-5.6-luna",
      budgetUsd: 1,
      ownerId,
      budgetGroupId,
    },
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
  registerAgentTools(mcp);
  registerBudgetGroupTools(mcp);
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
  resourceType: "budget_group",
  resourceId,
  grantee: grantee === "everyone" ? "everyone" : { principalId: grantee.id },
  level,
});

describe.skipIf(!process.env.DATABASE_URL)("sharing budget groups (PostgreSQL)", () => {
  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: groupIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.budgetGroup.deleteMany({ where: { id: { in: groupIds } } });
    await db.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
    await db.team.deleteMany({ where: { id: { in: teamIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("a stranger cannot see, grant on or use someone's group", async () => {
    const owner = await principal("owner1");
    const stranger = await principal("stranger1");
    const g = await group(owner.id);
    const mine = await agent(stranger.id);

    const asStranger = await connect(stranger);
    expect((await asStranger.call("get_budget_group", { id: g.id })).isError).toBe(true);
    expect(text(await asStranger.call("list_budget_groups", {}))).not.toContain(g.id);
    expect((await asStranger.call("grant_access", share(g.id, stranger, "use"))).isError).toBe(true);
    expect((await asStranger.call("update_agent", { id: mine.id, budgetGroupId: g.id })).isError).toBe(true);
    await asStranger.close();
  });

  it("use lets a grantee put their own agent in the group; read does not; neither lets them change it", async () => {
    const owner = await principal("owner2");
    const reader = await principal("reader2");
    const user = await principal("user2");
    const g = await group(owner.id);
    const readerAgent = await agent(reader.id);
    const userAgent = await agent(user.id);

    const asOwner = await connect(owner);
    expect((await asOwner.call("grant_access", share(g.id, reader, "read"))).isError).toBeFalsy();
    expect((await asOwner.call("grant_access", share(g.id, user, "use"))).isError).toBeFalsy();
    await asOwner.close();

    const asReader = await connect(reader);
    expect((await asReader.call("get_budget_group", { id: g.id })).isError).toBeFalsy();
    const refused = await asReader.call("update_agent", { id: readerAgent.id, budgetGroupId: g.id });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/agent's owner needs use access/);
    await asReader.close();

    const asUser = await connect(user);
    expect((await asUser.call("update_agent", { id: userAgent.id, budgetGroupId: g.id })).isError).toBeFalsy();
    expect((await db.agent.findUniqueOrThrow({ where: { id: userAgent.id } })).budgetGroupId).toBe(g.id);
    const change = await asUser.call("update_budget_group", { id: g.id, name: `renamed-${suffix}` });
    expect(change.isError).toBe(true);
    expect(text(change)).toMatch(/needs write access; you have use access/);
    expect((await asUser.call("grant_access", share(g.id, reader, "write"))).isError).toBe(true);
    await asUser.close();
  });

  it("a read grantee sees the group's spend but only the member agents they may read", async () => {
    const owner = await principal("owner6");
    const reader = await principal("reader6");
    const other = await principal("other6");
    const g = await group(owner.id);
    const ownersAgent = await agent(owner.id, g.id);
    const othersAgent = await agent(other.id, g.id);
    await db.budgetGroup.update({ where: { id: g.id }, data: { dailyBudgetUsd: 5 } });
    // `other` was granted use earlier, so their agent is legitimately in the group.
    await db.resourceGrant.create({
      data: {
        resourceType: "budget_group",
        resourceId: g.id,
        granteeKind: "principal",
        granteePrincipalId: other.id,
        granteeKey: `principal:${other.id}`,
        level: "use",
      },
    });
    const asOwner = await connect(owner);
    await asOwner.call("grant_access", share(g.id, reader, "read"));
    await asOwner.close();

    const asReader = await connect(reader);
    const view = JSON.parse(text(await asReader.call("get_budget_group", { id: g.id })));
    expect(view.spend).toBeDefined();
    expect(view.agents).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(ownersAgent.id);
    expect(JSON.stringify(view)).not.toContain(othersAgent.id);
    await asReader.close();
  });

  it("a Team member cannot slip a group onto the Team's agent on their own grant", async () => {
    const owner = await principal("owner7");
    const member = await principal("member7");
    const g = await group(owner.id);
    const admin: TeamActor = { principalId: member.id, roles: new Set(["admin"]) };
    const team = await createTeam(db, admin, { name: `bga-${suffix}` });
    teamIds.push(team.id);
    principalIds.push(team.principalId);
    await addMember(db, admin, team.id, member.id);
    const teamsAgent = await agent(team.principalId);
    // The member alone holds use; the Team (the agent's owner, and who is charged) does not.
    await db.resourceGrant.create({
      data: {
        resourceType: "budget_group",
        resourceId: g.id,
        granteeKind: "principal",
        granteePrincipalId: member.id,
        granteeKey: `principal:${member.id}`,
        level: "use",
      },
    });
    const asMember = await connect(member);
    const refused = await asMember.call("update_agent", { id: teamsAgent.id, budgetGroupId: g.id });
    expect(refused.isError).toBe(true);
    expect((await db.agent.findUniqueOrThrow({ where: { id: teamsAgent.id } })).budgetGroupId).toBeNull();
    await asMember.close();
  });

  it("write lets a grantee change the group, but only the owner deletes it", async () => {
    const owner = await principal("owner3");
    const editor = await principal("editor3");
    const g = await group(owner.id);
    const asOwner = await connect(owner);
    await asOwner.call("grant_access", share(g.id, editor, "write"));
    await asOwner.close();

    const asEditor = await connect(editor);
    expect((await asEditor.call("update_budget_group", { id: g.id, name: `edited-${suffix}` })).isError).toBeFalsy();
    expect((await asEditor.call("delete_budget_group", { id: g.id })).isError).toBe(true);
    await asEditor.close();
  });

  it("revoking or lowering a grant takes the group off agents whose owner can no longer use it", async () => {
    const owner = await principal("owner4");
    const user = await principal("user4");
    const g = await group(owner.id);
    const ownersAgent = await agent(owner.id, g.id);
    const usersAgent = await agent(user.id, g.id);

    const asOwner = await connect(owner);
    await asOwner.call("grant_access", share(g.id, user, "use"));
    const lowered = await asOwner.call("grant_access", share(g.id, user, "read"));
    expect(JSON.parse(text(lowered)).attachmentsRemoved).toBe(1);
    expect((await db.agent.findUniqueOrThrow({ where: { id: usersAgent.id } })).budgetGroupId).toBeNull();
    // The owner's own agents are never touched.
    expect((await db.agent.findUniqueOrThrow({ where: { id: ownersAgent.id } })).budgetGroupId).toBe(g.id);

    await asOwner.call("grant_access", share(g.id, user, "use"));
    await db.agent.update({ where: { id: usersAgent.id }, data: { budgetGroupId: g.id } });
    const revoked = await asOwner.call("revoke_access", {
      resourceType: "budget_group",
      resourceId: g.id,
      grantee: { principalId: user.id },
    });
    expect(JSON.parse(text(revoked)).attachmentsRemoved).toBe(1);
    expect((await db.agent.findUniqueOrThrow({ where: { id: usersAgent.id } })).budgetGroupId).toBeNull();
    await asOwner.close();
  });

  it("an everyone grant is capped at use; a Team member grants for the Team's group", async () => {
    const owner = await principal("owner5");
    const member = await principal("member5");
    const other = await principal("other5");
    const g = await group(owner.id);
    const asOwner = await connect(owner);
    expect((await asOwner.call("grant_access", share(g.id, "everyone", "write"))).isError).toBe(true);
    expect((await asOwner.call("grant_access", share(g.id, "everyone", "use"))).isError).toBeFalsy();
    await asOwner.close();

    const admin: TeamActor = { principalId: member.id, roles: new Set(["admin"]) };
    const team = await createTeam(db, admin, { name: `bgt-${suffix}` });
    teamIds.push(team.id);
    principalIds.push(team.principalId);
    await addMember(db, admin, team.id, member.id);
    const teamsGroup = await group(team.principalId);
    const asMember = await connect(member);
    expect((await asMember.call("grant_access", share(teamsGroup.id, other, "use"))).isError).toBeFalsy();
    await asMember.close();
  });
});
