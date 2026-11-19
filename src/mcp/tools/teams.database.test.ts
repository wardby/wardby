/**
 * The team tools over MCP, against real PostgreSQL: the scope-and-role gating
 * (teams:manage is privileged; set_team_roles is admin only), the TeamError ->
 * HTTP status mapping, and what list_teams shows each kind of caller.
 */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { newUserPrincipalData } from "../../core/teams/personal.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import { buildMcpServer, type WardbyMcpServer } from "../server.js";
import { registerTeamTools } from "./teams.js";

const CANONICAL_URI = "https://host/mcp";

describe.skipIf(!process.env.DATABASE_URL)("team tools (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const subjects: string[] = [];
  const teamIds: string[] = [];
  const name = (n: string) => `tt-${n}-${suffix}`;

  async function user(n: string) {
    const subject = `tt-${n}-${suffix}`;
    subjects.push(subject);
    const principal = await db.principal.create({ data: newUserPrincipalData(subject) });
    return principal;
  }
  async function ctxFor(n: string, scopes: string[], roles: string[]): Promise<McpRequestContext> {
    const principal = await user(`${n}-${randomUUID()}`);
    const teams = await db.teamMember.findMany({ where: { principalId: principal.id }, select: { teamId: true } });
    return {
      principal,
      scopes: new Set(scopes),
      roles,
      actsFor: [principal.id],
      teamIds: teams.map((t) => t.teamId),
      canonicalUri: CANONICAL_URI,
      providers: {} as McpRequestContext["providers"],
      db,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    };
  }
  const ADMIN = () => ctxFor("admin", ["agents:read", "teams:manage"], ["admin"]);
  const MANAGER = () => ctxFor("mgr", ["agents:read", "teams:manage"], ["team-manager"]);
  const PLAIN = () => ctxFor("plain", ["agents:read"], []);

  async function connect(ctx: McpRequestContext) {
    const mcp = buildMcpServer({ providers: ctx.providers, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(ctx);
    registerTeamTools(mcp);
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }
  const text = (result: { content: unknown }) => (result.content as { text: string }[])[0].text;
  async function call(ctx: McpRequestContext, tool: string, args: Record<string, unknown>) {
    const client = await connect(ctx);
    const result = await client.callTool({ name: tool, arguments: args });
    await client.close();
    return result;
  }
  /** The registered handler itself, to see the McpError status a client only sees as text. */
  function handlerOf(tool: string) {
    const handlers = new Map<string, (args: unknown, ctx: McpRequestContext) => Promise<unknown>>();
    registerTeamTools({
      registerTool: (spec: { name: string; handler: (args: unknown, ctx: McpRequestContext) => Promise<unknown> }) =>
        handlers.set(spec.name, spec.handler),
    } as unknown as WardbyMcpServer);
    return handlers.get(tool)!;
  }
  async function statusOf(tool: string, ctx: McpRequestContext, args: unknown): Promise<number | undefined> {
    const err = await handlerOf(tool)(args, ctx).then(
      () => undefined,
      (e: unknown) => e,
    );
    return err instanceof McpError ? err.httpStatus : undefined;
  }
  async function createdTeam(ctx: McpRequestContext, n: string) {
    const result = await call(ctx, "create_team", { name: name(n) });
    const team = JSON.parse(text(result)) as { id: string };
    teamIds.push(team.id);
    return team;
  }

  afterAll(async () => {
    const teams = await db.team.findMany({ where: { id: { in: teamIds } }, select: { principalId: true } });
    await db.team.deleteMany({ where: { id: { in: teamIds } } });
    await db.principal.deleteMany({ where: { id: { in: teams.map((t) => t.principalId) } } });
    const users = await db.principal.findMany({
      where: { subject: { startsWith: "tt-" }, AND: { subject: { endsWith: suffix } } },
      select: { id: true },
    });
    await db.principal.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await db.teamAudit.deleteMany({ where: { teamId: { in: teamIds } } });
    await db.$disconnect();
  });

  it("registers every team tool, the managing ones describing teams:manage", async () => {
    const client = await connect(await ADMIN());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of ["create_team", "rename_team", "delete_team", "add_team_member", "remove_team_member"])
      expect(byName.get(n)?.description, n).toMatch(/^Admins and team-managers \(teams:manage\): /);
    expect(byName.get("set_team_roles")?.description).toMatch(/^Admins \(teams:manage\): /);
    expect(byName.has("list_teams")).toBe(true);
    await client.close();
  });

  it("managing tools need a role granting teams:manage AND the scope; a plain caller gets neither through", async () => {
    const unroled = await ctxFor("unroled", ["agents:read", "teams:manage"], []);
    const noScope = await ctxFor("noscope", ["agents:read"], ["admin"]);
    for (const who of [unroled, noScope, await PLAIN()]) {
      const r = await call(who, "create_team", { name: name("denied") });
      expect(r.isError).toBe(true);
    }
    expect(await db.team.count({ where: { name: name("denied") } })).toBe(0);
    expect(text(await call(unroled, "create_team", { name: name("denied") }))).toMatch(
      /requires a role that grants it/,
    );
  });

  it("a team-manager manages teams and members but cannot assign roles; an admin can", async () => {
    const mgr = await MANAGER();
    const admin = await ADMIN();
    const team = await createdTeam(mgr, "managed");
    const target = await user("target");
    expect((await call(mgr, "add_team_member", { teamId: team.id, subject: target.subject })).isError).toBeFalsy();
    expect(await db.teamMember.count({ where: { teamId: team.id, principalId: target.id } })).toBe(1);
    expect((await call(mgr, "rename_team", { id: team.id, name: name("managed2") })).isError).toBeFalsy();
    expect(await statusOf("set_team_roles", mgr, { id: team.id, roles: ["viewer"] })).toBe(403);
    const set = await call(admin, "set_team_roles", { id: team.id, roles: ["viewer"] });
    expect(JSON.parse(text(set)).roles).toEqual(["viewer"]);
    expect((await call(mgr, "remove_team_member", { teamId: team.id, subject: target.subject })).isError).toBeFalsy();
    expect(await db.teamMember.count({ where: { teamId: team.id, principalId: target.id } })).toBe(0);
  });

  it("maps failures to statuses: 409 duplicate, 400 invalid or personal, 404 unknown", async () => {
    const admin = await ADMIN();
    const team = await createdTeam(admin, "status");
    expect(await statusOf("create_team", admin, { name: name("status") })).toBe(409);
    expect(await statusOf("create_team", admin, { name: "   " })).toBe(400);
    expect(await statusOf("create_team", admin, { name: "personal:x" })).toBe(400);
    expect(await statusOf("create_team", admin, { name: name("x"), extra: 1 })).toBe(400);
    expect(await statusOf("rename_team", admin, { id: "no-such-team", name: name("y") })).toBe(404);
    expect(await statusOf("delete_team", admin, { id: "no-such-team" })).toBe(404);
    expect(await statusOf("add_team_member", admin, { teamId: team.id, subject: "team:forged" })).toBe(400);
    const personal = await db.team.findFirstOrThrow({ where: { principalId: admin.principal.id } });
    expect(await statusOf("delete_team", admin, { id: personal.id })).toBe(400);
  });

  it("adding an unseen subject pre-creates that user, with their own personal team", async () => {
    const admin = await ADMIN();
    const team = await createdTeam(admin, "preadd");
    const subject = `tt-unseen-${suffix}`;
    subjects.push(subject);
    await call(admin, "add_team_member", { teamId: team.id, subject });
    const principal = await db.principal.findUniqueOrThrow({ where: { subject } });
    expect(await db.team.count({ where: { principalId: principal.id, personal: true } })).toBe(1);
    expect(await db.teamMember.count({ where: { teamId: team.id, principalId: principal.id } })).toBe(1);
  });

  it("list_teams: a plain caller sees only their own teams; a manager with the scope sees all, with members", async () => {
    const admin = await ADMIN();
    const team = await createdTeam(admin, "visible");
    const member = await user("lister");
    await call(admin, "add_team_member", { teamId: team.id, subject: member.subject });
    const memberCtx = await ctxFor("lister-ctx", ["agents:read"], []);
    await db.teamMember.create({ data: { teamId: team.id, principalId: memberCtx.principal.id } });
    const own = JSON.parse(text(await call(memberCtx, "list_teams", {}))) as { id: string; members?: unknown }[];
    expect(own.map((t) => t.id)).toContain(team.id);
    expect(own.every((t) => t.members === undefined)).toBe(true);
    const all = JSON.parse(text(await call(admin, "list_teams", {}))) as {
      id: string;
      members: { subject: string }[];
    }[];
    expect(all.find((t) => t.id === team.id)?.members.map((m) => m.subject)).toContain(member.subject);
    // A role without the scope is delegation-free: the admin's token lacking teams:manage sees only its own.
    const adminNoScope = await ctxFor("admin-noscope", ["agents:read"], ["admin"]);
    const mine = JSON.parse(text(await call(adminNoScope, "list_teams", {}))) as { id: string }[];
    expect(mine.map((t) => t.id)).not.toContain(team.id);
  });
});
