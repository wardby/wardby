/**
 * Standing reaches the request context (docs/private/adr/0003): authenticate()
 * resolves, on every request, who the caller acts for and which roles it holds
 * through its teams. Real PostgreSQL; the auth provider is a stub.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import type { AuthProvider, VerifiedToken } from "../../providers/auth/types.js";
import { authenticate, requireScope } from "./resource-server.js";

const URI = "https://host/mcp";

describe.skipIf(!process.env.DATABASE_URL)("authenticate resolves team standing (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const subjects: string[] = [];
  const teamIds: string[] = [];
  const provider = (v: VerifiedToken) => ({ verifyBearer: async () => v }) as unknown as AuthProvider;
  const login = (v: VerifiedToken) =>
    authenticate(
      { authorization: "Bearer t" },
      { db, providers: {} as never, canonicalUri: URI, authProvider: provider(v) },
    );
  const subject = (n: string) => {
    const s = `st-${n}-${suffix}`;
    subjects.push(s);
    return s;
  };

  async function sharedTeam(n: string, memberSubject: string, roles: string[]) {
    const backing = await db.principal.create({ data: { subject: `team:st-${n}-${suffix}` } });
    const member = await db.principal.findUniqueOrThrow({ where: { subject: memberSubject } });
    const team = await db.team.create({
      data: {
        name: `st-${n}-${suffix}`,
        principalId: backing.id,
        roles,
        members: { create: { principalId: member.id } },
      },
    });
    teamIds.push(team.id);
    return { team, backing, member };
  }

  afterAll(async () => {
    const teams = await db.team.findMany({ where: { id: { in: teamIds } }, select: { principalId: true } });
    await db.team.deleteMany({ where: { id: { in: teamIds } } });
    await db.principal.deleteMany({ where: { id: { in: teams.map((t) => t.principalId) } } });
    const users = await db.principal.findMany({ where: { subject: { in: subjects } }, select: { id: true } });
    await db.principal.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await db.$disconnect();
  });

  it("a caller in no shared team acts for itself only, with the provider's roles", async () => {
    const s = subject("alone");
    const ctx = await login({ subject: s, scopes: [], wardbyRoles: ["viewer"] });
    expect(ctx.actsFor).toEqual([ctx.principal.id]);
    expect(ctx.roles).toEqual(["viewer"]);
  });

  it("a team member also acts for the team, and holds the union of provider and team roles", async () => {
    const s = subject("member");
    await login({ subject: s, scopes: [] });
    const { backing } = await sharedTeam("a", s, ["model-manager", "not-a-role"]);
    const ctx = await login({ subject: s, scopes: ["agents:read"], wardbyRoles: ["viewer"] });
    expect(ctx.actsFor).toEqual([ctx.principal.id, backing.id]);
    expect([...(ctx.roles ?? [])].sort()).toEqual(["model-manager", "viewer"]);
    expect([...ctx.scopes]).toEqual(["agents:read"]);
  });

  it("a team role grants a privileged scope only together with the token's scope", async () => {
    const s = subject("scope");
    await login({ subject: s, scopes: [] });
    await sharedTeam("b", s, ["model-manager"]);
    const withScope = await login({ subject: s, scopes: ["models:admin"] });
    expect(() => requireScope(withScope, URI, "models:admin")).not.toThrow();
    const withoutScope = await login({ subject: s, scopes: ["agents:read"] });
    expect(() => requireScope(withoutScope, URI, "models:admin")).toThrow();
  });

  it("removing a member takes effect on that caller's very next request", async () => {
    const s = subject("removed");
    await login({ subject: s, scopes: [] });
    const { team, member } = await sharedTeam("c", s, ["model-manager"]);
    expect((await login({ subject: s, scopes: [] })).roles).toContain("model-manager");
    await db.teamMember.delete({ where: { teamId_principalId: { teamId: team.id, principalId: member.id } } });
    const after = await login({ subject: s, scopes: [] });
    expect(after.roles).toEqual([]);
    expect(after.actsFor).toEqual([after.principal.id]);
  });
});
