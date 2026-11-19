/**
 * Every user has a Personal team the moment their principal exists
 * (docs/private/adr/0004): a Team of one whose backing principal is the user's
 * own principal, so ownership and grants need no rewriting.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { resolvePrincipal } from "./principal.js";
import { IdentityService } from "./self-hosted/credentials.js";

describe.skipIf(!process.env.DATABASE_URL)("personal team on principal creation (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const subjects: string[] = [];
  const subject = (n: string) => {
    const s = `pt-${n}-${suffix}`;
    subjects.push(s);
    return s;
  };

  afterAll(async () => {
    const principals = await db.principal.findMany({ where: { subject: { in: subjects } }, select: { id: true } });
    const ids = principals.map((p) => p.id);
    await db.authUser.deleteMany({ where: { principalId: { in: ids } } });
    await db.team.deleteMany({ where: { principalId: { in: ids } } });
    await db.principal.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  it("a new principal gets exactly one Personal team: itself as the only member, no roles", async () => {
    const principal = await resolvePrincipal(subject("new"), db);
    const teams = await db.team.findMany({ where: { principalId: principal.id }, include: { members: true } });
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({ personal: true, roles: [], name: `personal:${principal.id}` });
    expect(teams[0].members.map((m) => m.principalId)).toEqual([principal.id]);
  });

  it("resolving the same subject again creates no second team", async () => {
    const s = subject("again");
    const first = await resolvePrincipal(s, db);
    const second = await resolvePrincipal(s, db);
    expect(second.id).toBe(first.id);
    expect(await db.team.count({ where: { principalId: first.id } })).toBe(1);
  });

  it("a self-hosted user created through the identity service gets one too, and resolving them later adds none", async () => {
    const s = subject("self-hosted");
    await new IdentityService(db, "c3".repeat(32)).createUser(s);
    const principal = await db.principal.findUniqueOrThrow({ where: { subject: s } });
    expect(await db.team.count({ where: { principalId: principal.id, personal: true } })).toBe(1);
    await resolvePrincipal(s, db);
    expect(await db.team.count({ where: { principalId: principal.id } })).toBe(1);
  });
});
