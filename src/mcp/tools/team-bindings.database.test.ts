/**
 * Bindings on a Team-owned agent over MCP, against real PostgreSQL: a Team member
 * binds the Team's own datastores and grants capabilities as the Team (the consent
 * is stamped with the Team's principal), a personal resource is refused, and a
 * stranger cannot touch the agent.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal, Team } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { resolveStanding } from "../../core/teams/standing.js";
import { addMember, createTeam, type TeamActor } from "../../core/teams/teams.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerAgentTools } from "./agents.js";
import { registerDatastoreTools } from "./datastore.js";
import { registerToolAuthoringTools } from "./tools.js";

const db = createPrismaClient();
const CANONICAL = "https://host/mcp";
const suffix = randomUUID();
const principalIds: string[] = [];
const teamIds: string[] = [];
const agentIds: string[] = [];
const datastoreIds: string[] = [];
const toolIds: string[] = [];

type Result = { isError?: boolean; content: { text: string }[] };
const text = (r: Result) => r.content[0].text;

async function principal(label: string): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `team-bind-${label}-${suffix}` } });
  principalIds.push(p.id);
  return p;
}

async function team(label: string, member: Principal): Promise<Team> {
  const admin: TeamActor = { principalId: member.id, roles: new Set(["admin"]) };
  const created = await createTeam(db, admin, { name: `tb-${label}-${suffix}` });
  teamIds.push(created.id);
  principalIds.push(created.principalId);
  await addMember(db, admin, created.id, member.id);
  return created;
}

async function agent(ownerId: string) {
  const a = await db.agent.create({
    data: { name: `tb-${randomUUID()}`, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1, ownerId },
  });
  agentIds.push(a.id);
  return a;
}

async function datastore(ownerId: string) {
  const d = await db.datastore.create({ data: { name: `tb-${randomUUID()}`, ownerId } });
  datastoreIds.push(d.id);
  return d;
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
  registerDatastoreTools(mcp);
  registerToolAuthoringTools(mcp);
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

describe.skipIf(!process.env.DATABASE_URL)("bindings on a Team-owned agent (PostgreSQL)", () => {
  afterAll(async () => {
    await db.agentDatastore.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agentTool.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.datastore.deleteMany({ where: { id: { in: datastoreIds } } });
    await db.tool.deleteMany({ where: { id: { in: toolIds } } });
    await db.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
    await db.team.deleteMany({ where: { id: { in: teamIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("a Team member binds the Team's datastore, not a personal one, and a stranger binds nothing", async () => {
    const member = await principal("member1");
    const stranger = await principal("stranger1");
    const t = await team("ds", member);
    const teamsAgent = await agent(t.principalId);
    const teamsStore = await datastore(t.principalId);
    const personalStore = await datastore(member.id);

    const asMember = await connect(member);
    expect(
      (await asMember.call("attach_datastore", { agentId: teamsAgent.id, datastoreId: teamsStore.id })).isError,
    ).toBeFalsy();
    const refused = await asMember.call("attach_datastore", { agentId: teamsAgent.id, datastoreId: personalStore.id });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/owned by the agent's owner/);
    expect(
      (await asMember.call("detach_datastore", { agentId: teamsAgent.id, boundName: teamsStore.name })).isError,
    ).toBeFalsy();
    await asMember.close();

    const asStranger = await connect(stranger);
    const denied = await asStranger.call("attach_datastore", { agentId: teamsAgent.id, datastoreId: teamsStore.id });
    expect(denied.isError).toBe(true);
    expect(await db.agentDatastore.count({ where: { agentId: teamsAgent.id } })).toBe(0);
    await asStranger.close();
  });

  it("capabilities a member grants carry the Team's consent, not the member's", async () => {
    const member = await principal("member2");
    const t = await team("cap", member);
    const teamsAgent = await agent(t.principalId);
    const publicTool = await db.tool.create({
      data: {
        name: `tb-tool-${randomUUID()}`,
        description: "d",
        paramsZod: "z.object({})",
        jsonSchema: {},
        code: "return 1;",
        ownerId: null,
      },
    });
    toolIds.push(publicTool.id);

    const asMember = await connect(member);
    const attached = await asMember.call("attach_tool", {
      agentId: teamsAgent.id,
      toolId: publicTool.id,
      allowedHosts: ["example.com"],
    });
    expect(attached.isError, attached.content[0].text).toBeFalsy();
    const row = await db.agentTool.findUniqueOrThrow({
      where: { agentId_toolId: { agentId: teamsAgent.id, toolId: publicTool.id } },
    });
    // The runner honours capabilities only while this equals the agent's current owner: the Team.
    expect(row.capabilitiesGrantedById).toBe(t.principalId);
    await asMember.close();
  });
});
