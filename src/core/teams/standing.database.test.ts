/**
 * Standing against real PostgreSQL: which principals a caller acts for (itself
 * plus its teams' backing principals) and which wardby roles it holds
 * (direct and team roles, unioned). See docs/private/adr/0003.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { newUserPrincipalData } from "./personal.js";
import { resolveStanding } from "./standing.js";

describe.skipIf(!process.env.DATABASE_URL)("resolveStanding (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const principals: string[] = [];
  const teams: string[] = [];

  async function principal(name: string) {
    const row = await db.principal.create({ data: { subject: `standing-${name}-${suffix}` } });
    principals.push(row.id);
    return row;
  }
  async function team(name: string, members: string[], roles: string[] = []) {
    const backing = await principal(`team-${name}`);
    const row = await db.team.create({
      data: {
        name: `standing-${name}-${suffix}`,
        principalId: backing.id,
        roles,
        members: { create: members.map((principalId) => ({ principalId })) },
      },
    });
    teams.push(row.id);
    return { ...row, principal: backing };
  }

  afterAll(async () => {
    await db.team.deleteMany({ where: { id: { in: teams } } });
    await db.principal.deleteMany({ where: { id: { in: principals } } });
    await db.$disconnect();
  });

  it("a user in no team acts only for itself and holds only its direct roles", async () => {
    const user = await principal("loner");
    const standing = await resolveStanding(db, user.id, ["viewer"]);
    expect(standing).toEqual({ actsFor: [user.id], teamIds: [], roles: new Set(["viewer"]) });
  });

  it("a member acts for itself and for each team's backing principal, in that order", async () => {
    const user = await principal("multi");
    const other = await principal("other");
    const a = await team("a", [user.id]);
    const b = await team("b", [user.id, other.id]);
    const standing = await resolveStanding(db, user.id);
    expect(standing.actsFor[0]).toBe(user.id);
    expect(standing.actsFor.slice(1).sort()).toEqual([a.principal.id, b.principal.id].sort());
    expect(standing.teamIds.sort()).toEqual([a.id, b.id].sort());
    // a teammate's standing is its own: it never inherits another member's teams
    expect((await resolveStanding(db, other.id)).actsFor.sort()).toEqual([other.id, b.principal.id].sort());
  });

  it("roles are the union of direct and team roles; unknown names grant nothing", async () => {
    const user = await principal("roles");
    await team("r1", [user.id], ["model-manager", "not-a-role"]);
    await team("r2", [user.id], ["viewer", "model-manager"]);
    const standing = await resolveStanding(db, user.id, ["host-manager", "also-not-a-role"]);
    expect([...standing.roles].sort()).toEqual(["host-manager", "model-manager", "viewer"]);
  });

  it("a removed member loses the team's standing immediately", async () => {
    const user = await principal("removed");
    const t = await team("gone", [user.id], ["admin"]);
    expect((await resolveStanding(db, user.id)).roles.has("admin")).toBe(true);
    await db.teamMember.delete({ where: { teamId_principalId: { teamId: t.id, principalId: user.id } } });
    const after = await resolveStanding(db, user.id);
    expect(after.actsFor).toEqual([user.id]);
    expect(after.roles.has("admin")).toBe(false);
  });

  it("a Personal team adds no second principal: the user acts for itself once, plus any shared teams", async () => {
    const row = await db.principal.create({ data: newUserPrincipalData(`standing-personal-${suffix}`) });
    principals.push(row.id);
    const personal = await db.team.findFirstOrThrow({ where: { principalId: row.id } });
    const alone = await resolveStanding(db, row.id);
    expect(alone.actsFor).toEqual([row.id]);
    expect(alone.teamIds).toEqual([personal.id]);
    const shared = await team("with-personal", [row.id]);
    const both = await resolveStanding(db, row.id);
    expect(both.actsFor).toEqual([row.id, shared.principal.id]);
    expect(both.teamIds.sort()).toEqual([personal.id, shared.id].sort());
  });
});
