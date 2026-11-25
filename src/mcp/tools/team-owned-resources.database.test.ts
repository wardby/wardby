/**
 * Team ownership beyond agents, against real PostgreSQL: a Team member acts as an
 * owner of the budget groups, tools, MCP servers and documents their Team owns; a
 * stranger does not, and leaving the Team takes the access away on the next request.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal, Team } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { documentAccess } from "../../core/documents/access.js";
import { accessFor } from "../../core/grants.js";
import { resolveStanding } from "../../core/teams/standing.js";
import { addMember, createTeam, removeMember, type TeamActor } from "../../core/teams/teams.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerBudgetGroupTools } from "./budget-groups.js";
import { registerToolAuthoringTools } from "./tools.js";

const db = createPrismaClient();
const CANONICAL = "https://host/mcp";
const suffix = randomUUID();
const principalIds: string[] = [];
const teamIds: string[] = [];
const groupIds: string[] = [];
const toolIds: string[] = [];
const serverIds: string[] = [];
const documentIds: string[] = [];

type Result = { isError?: boolean; content: { text: string }[] };
const text = (r: Result) => r.content[0].text;

async function principal(label: string): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `team-res-${label}-${suffix}` } });
  principalIds.push(p.id);
  return p;
}

async function team(label: string, member: Principal): Promise<Team> {
  const admin: TeamActor = { principalId: member.id, roles: new Set(["admin"]) };
  const created = await createTeam(db, admin, { name: `tr-${label}-${suffix}` });
  teamIds.push(created.id);
  principalIds.push(created.principalId);
  await addMember(db, admin, created.id, member.id);
  return created;
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
  registerBudgetGroupTools(mcp);
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

describe.skipIf(!process.env.DATABASE_URL)("Team-owned budget groups, tools, MCP servers and documents", () => {
  afterAll(async () => {
    await db.document.deleteMany({ where: { id: { in: documentIds } } });
    await db.mcpServer.deleteMany({ where: { id: { in: serverIds } } });
    await db.tool.deleteMany({ where: { id: { in: toolIds } } });
    await db.budgetGroup.deleteMany({ where: { id: { in: groupIds } } });
    await db.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
    await db.team.deleteMany({ where: { id: { in: teamIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("a budget group: members read, change and list it; a stranger does not", async () => {
    const member = await principal("bg-member");
    const stranger = await principal("bg-stranger");
    const t = await team("bg", member);
    const group = await db.budgetGroup.create({ data: { name: `bg-${suffix}`, ownerId: t.principalId } });
    groupIds.push(group.id);

    const asMember = await connect(member);
    expect((await asMember.call("get_budget_group", { id: group.id })).isError).toBeFalsy();
    expect(text(await asMember.call("list_budget_groups", {}))).toContain(group.id);
    expect((await asMember.call("update_budget_group", { id: group.id, name: `bg2-${suffix}` })).isError).toBeFalsy();
    await asMember.close();

    const asStranger = await connect(stranger);
    // A group owned by someone else is invisible: not readable, not listed, not changeable.
    expect((await asStranger.call("get_budget_group", { id: group.id })).isError).toBe(true);
    expect(text(await asStranger.call("list_budget_groups", {}))).not.toContain(group.id);
    expect((await asStranger.call("update_budget_group", { id: group.id, name: "x" })).isError).toBe(true);
    await asStranger.close();
  });

  it("a tool: members list and delete it; a stranger neither sees nor deletes it", async () => {
    const member = await principal("tool-member");
    const stranger = await principal("tool-stranger");
    const t = await team("tool", member);
    const tool = await db.tool.create({
      data: {
        name: `tool-${suffix}`,
        description: "d",
        paramsZod: "z.object({})",
        jsonSchema: {},
        code: "return 1;",
        ownerId: t.principalId,
      },
    });
    toolIds.push(tool.id);

    const asStranger = await connect(stranger);
    expect(text(await asStranger.call("list_tools", {}))).not.toContain(tool.id);
    expect((await asStranger.call("delete_tool", { toolId: tool.id })).isError).toBe(true);
    await asStranger.close();

    const asMember = await connect(member);
    expect(text(await asMember.call("list_tools", {}))).toContain(tool.id);
    expect((await asMember.call("delete_tool", { toolId: tool.id })).isError).toBeFalsy();
    expect(await db.tool.count({ where: { id: tool.id } })).toBe(0);
    await asMember.close();
  });

  it("an MCP server: its Team's members own it, a stranger holds nothing", async () => {
    const member = await principal("srv-member");
    const stranger = await principal("srv-stranger");
    const t = await team("srv", member);
    const server = await db.mcpServer.create({
      data: { name: `srv-${suffix}`, url: "https://mcp.example.invalid/", ownerId: t.principalId },
    });
    serverIds.push(server.id);

    const memberStanding = await resolveStanding(db, member.id);
    const strangerStanding = await resolveStanding(db, stranger.id);
    expect(await accessFor(db, "mcp_server", server, memberStanding.actsFor)).toBe("owner");
    expect(await accessFor(db, "mcp_server", server, strangerStanding.actsFor)).toBe("none");
  });

  it("a document: its Team's members own it; leaving the Team takes that away on the next request", async () => {
    const member = await principal("doc-member");
    const stranger = await principal("doc-stranger");
    const t = await team("doc", member);
    const doc = await db.document.create({ data: { title: `doc-${suffix}`, ownerId: t.principalId } });
    documentIds.push(doc.id);

    const access = async (who: Principal) => {
      const standing = await resolveStanding(db, who.id);
      return documentAccess(db, doc.id, { kind: "principal", principalId: who.id, actsFor: standing.actsFor });
    };
    expect(await access(member)).toBe("owner");
    expect(await access(stranger)).toBe("none");

    await removeMember(db, { principalId: member.id, roles: new Set(["admin"]) }, t.id, member.id);
    expect(await access(member)).toBe("none");
  });
});
