/**
 * Team ownership of agents over MCP, against real PostgreSQL: a Team member acts
 * as an owner of the agents its Team owns (ownerId in actsFor), a stranger does
 * not, removing a member bites on the next request, and a list never contains an
 * agent a fetch would refuse.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal, Team } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { principalGranteeKey } from "../../core/grants.js";
import { addMember, createTeam, removeMember, type TeamActor } from "../../core/teams/teams.js";
import { resolveStanding } from "../../core/teams/standing.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerAgentTools } from "./agents.js";

const db = createPrismaClient();
const CANONICAL = "https://host/mcp";
const agentIds: string[] = [];
const principalIds: string[] = [];
const teamIds: string[] = [];
const suffix = randomUUID();

type Result = { isError?: boolean; content: { text: string }[] };

async function principal(label: string): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `team-agents-${label}-${suffix}` } });
  principalIds.push(p.id);
  return p;
}

async function team(label: string): Promise<Team> {
  const admin: TeamActor = { principalId: (await principal(`${label}-admin`)).id, roles: new Set(["admin"]) };
  const created = await createTeam(db, admin, { name: `ta-${label}-${suffix}` });
  teamIds.push(created.id);
  principalIds.push(created.principalId);
  return created;
}

async function agent(ownerId: string | null) {
  const a = await db.agent.create({
    data: { name: `ta-${randomUUID()}`, systemPrompt: "original", model: "gpt-5.6-luna", budgetUsd: 1, ownerId },
  });
  agentIds.push(a.id);
  return a;
}

async function grant(agentId: string, granteePrincipalId: string, level: string) {
  await db.resourceGrant.create({
    data: {
      resourceType: "agent",
      resourceId: agentId,
      granteeKind: "principal",
      granteePrincipalId,
      granteeKey: principalGranteeKey(granteePrincipalId),
      level,
    },
  });
}

/** A client for `who`, with its standing resolved now, the way each request resolves it. */
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

const text = (r: Result) => r.content[0].text;

describe.skipIf(!process.env.DATABASE_URL)("Team-owned agents over MCP (PostgreSQL)", () => {
  const admin: TeamActor = { principalId: "", roles: new Set(["admin"]) };

  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
    await db.team.deleteMany({ where: { id: { in: teamIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("a Team member reads and writes a Team-owned agent; a non-member cannot", async () => {
    const t = await team("rw");
    const member = await principal("member");
    const stranger = await principal("stranger");
    admin.principalId = member.id;
    await addMember(db, admin, t.id, member.id);
    const owned = await agent(t.principalId);

    const asMember = await connect(member);
    expect((await asMember.call("get_agent", { id: owned.id })).isError).toBeFalsy();
    const edited = await asMember.call("update_agent", { id: owned.id, systemPrompt: "edited by a member" });
    expect(edited.isError).toBeFalsy();
    expect((await db.agent.findUniqueOrThrow({ where: { id: owned.id } })).systemPrompt).toBe("edited by a member");
    await asMember.close();

    const asStranger = await connect(stranger);
    const refused = await asStranger.call("get_agent", { id: owned.id });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("not found");
    await asStranger.close();
  });

  it("removing a member takes the access away on the member's next request", async () => {
    const t = await team("remove");
    const member = await principal("leaver");
    admin.principalId = member.id;
    await addMember(db, admin, t.id, member.id);
    const owned = await agent(t.principalId);

    const before = await connect(member);
    expect((await before.call("get_agent", { id: owned.id })).isError).toBeFalsy();
    await before.close();

    await removeMember(db, admin, t.id, member.id);
    const after = await connect(member);
    expect((await after.call("get_agent", { id: owned.id })).isError).toBe(true);
    await after.close();
  });

  it("a Grant to a Team reaches its members at the granted level, and no further", async () => {
    const t = await team("grant");
    const member = await principal("grantee");
    admin.principalId = member.id;
    await addMember(db, admin, t.id, member.id);
    const someone = await principal("someone");
    const shared = await agent(someone.id);
    await grant(shared.id, t.principalId, "read");

    const asMember = await connect(member);
    expect((await asMember.call("get_agent", { id: shared.id })).isError).toBeFalsy();
    const write = await asMember.call("update_agent", { id: shared.id, systemPrompt: "no" });
    expect(write.isError).toBe(true);
    expect(text(write)).toMatch(/needs write access; you have read access/);
    await asMember.close();
  });

  it("an agent with no owner is reachable only through its Grants", async () => {
    const t = await team("ownerless");
    const member = await principal("ownerless-member");
    admin.principalId = member.id;
    await addMember(db, admin, t.id, member.id);
    const ownerless = await agent(null);

    const asMember = await connect(member);
    expect((await asMember.call("get_agent", { id: ownerless.id })).isError).toBe(true);
    await grant(ownerless.id, t.principalId, "read");
    expect((await asMember.call("get_agent", { id: ownerless.id })).isError).toBeFalsy();
    await asMember.close();
  });

  it("list_agents shows exactly the agents get_agent would allow", async () => {
    const t = await team("parity");
    const other = await team("parity-other");
    const member = await principal("parity-member");
    admin.principalId = member.id;
    await addMember(db, admin, t.id, member.id);
    const mine = await agent(member.id);
    const teams = await agent(t.principalId);
    const granted = await agent(other.principalId);
    await grant(granted.id, t.principalId, "execute");
    const foreign = await agent(other.principalId);

    const asMember = await connect(member);
    const listed = text(await asMember.call("list_agents", {}));
    for (const a of [mine, teams, granted, foreign]) {
      const readable = !(await asMember.call("get_agent", { id: a.id })).isError;
      expect(listed.includes(a.id), `agent ${a.id}`).toBe(readable);
    }
    expect(listed).toContain(teams.id);
    expect(listed).not.toContain(foreign.id);
    await asMember.close();
  });
});
