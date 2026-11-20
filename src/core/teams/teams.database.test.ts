/**
 * Team management against real PostgreSQL: the rules for creating, renaming,
 * listing, populating and deleting teams, and who may do each. Callers pass an
 * actor (principal id + the wardby roles from Standing); nothing here knows MCP.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { newUserPrincipalData } from "./personal.js";
import {
  addMember,
  createTeam,
  listTeams,
  deleteTeam,
  removeMember,
  renameTeam,
  setTeamRoles,
  TeamError,
} from "./teams.js";

describe.skipIf(!process.env.DATABASE_URL)("team management (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const principalIds: string[] = [];
  const teamIds: string[] = [];
  const name = (n: string) => `tm-${n}-${suffix}`;

  async function actor(n: string, roles: string[]) {
    const row = await db.principal.create({ data: { subject: `tm-actor-${n}-${suffix}` } });
    principalIds.push(row.id);
    return { principalId: row.id, roles: new Set(roles) };
  }
  const admin = () => actor(`admin-${randomUUID()}`, ["admin"]);
  const manager = () => actor(`mgr-${randomUUID()}`, ["team-manager"]);
  const member = () => actor(`mem-${randomUUID()}`, []);

  async function created(by: Awaited<ReturnType<typeof actor>>, n: string) {
    const team = await createTeam(db, by, { name: name(n) });
    teamIds.push(team.id);
    return team;
  }
  async function rejects(p: Promise<unknown>, code: TeamError["code"]) {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TeamError);
    expect((err as TeamError).code).toBe(code);
  }

  afterAll(async () => {
    const teams = await db.team.findMany({ where: { id: { in: teamIds } }, select: { principalId: true } });
    await db.team.deleteMany({ where: { id: { in: teamIds } } });
    await db.principal.deleteMany({ where: { id: { in: [...principalIds, ...teams.map((t) => t.principalId)] } } });
    await db.teamAudit.deleteMany({ where: { teamId: { in: teamIds } } });
    await db.$disconnect();
  });

  it("creating a team gives it a backing principal whose subject no token can carry", async () => {
    const team = await created(await admin(), "create");
    expect(team.name).toBe(name("create"));
    const backing = await db.principal.findUniqueOrThrow({ where: { id: team.principalId } });
    expect(backing.subject).toBe(`team:${team.id}`);
    expect(await db.teamMember.count({ where: { teamId: team.id } })).toBe(0);
  });

  it("an admin and a team-manager may create teams; a plain member may not, and leaves nothing behind", async () => {
    await created(await manager(), "by-manager");
    const before = await db.principal.count({ where: { subject: { startsWith: "team:" } } });
    await rejects(createTeam(db, await member(), { name: name("nope") }), "forbidden");
    expect(await db.principal.count({ where: { subject: { startsWith: "team:" } } })).toBe(before);
  });

  it("names are trimmed, unique, and non-empty", async () => {
    const a = await admin();
    const team = await createTeam(db, a, { name: `  ${name("trim")}  ` });
    teamIds.push(team.id);
    expect(team.name).toBe(name("trim"));
    await rejects(createTeam(db, a, { name: name("trim") }), "conflict");
    await rejects(createTeam(db, a, { name: "   " }), "invalid");
    await rejects(createTeam(db, a, { name: "x".repeat(65) }), "invalid");
  });

  it("renaming needs the manage permission and keeps names unique", async () => {
    const a = await admin();
    const t1 = await created(a, "ren1");
    const t2 = await created(a, "ren2");
    const renamed = await renameTeam(db, a, t1.id, name("ren1b"));
    expect(renamed.name).toBe(name("ren1b"));
    await rejects(renameTeam(db, a, t1.id, t2.name), "conflict");
    await rejects(renameTeam(db, await member(), t1.id, name("x")), "forbidden");
    await rejects(renameTeam(db, a, "no-such-team", name("x")), "not_found");
  });

  it("an admin or team-manager lists every team; a member sees only their own", async () => {
    const a = await admin();
    const mine = await actor(`lister-${randomUUID()}`, []);
    const t1 = await created(a, "list1");
    await created(a, "list2");
    await db.teamMember.create({ data: { teamId: t1.id, principalId: mine.principalId } });
    expect((await listTeams(db, mine)).map((t) => t.id)).toEqual([t1.id]);
    const all = (await listTeams(db, await manager())).map((t) => t.name);
    expect(all).toEqual(expect.arrayContaining([name("list1"), name("list2")]));
  });

  it("members are added and removed by a manager, idempotently; a plain member cannot edit membership", async () => {
    const m = await manager();
    const team = await created(m, "members");
    const user = await member();
    await addMember(db, m, team.id, user.principalId);
    await addMember(db, m, team.id, user.principalId);
    expect(await db.teamMember.count({ where: { teamId: team.id } })).toBe(1);
    await rejects(addMember(db, await member(), team.id, user.principalId), "forbidden");
    await rejects(removeMember(db, await member(), team.id, user.principalId), "forbidden");
    await removeMember(db, m, team.id, user.principalId);
    await removeMember(db, m, team.id, user.principalId);
    expect(await db.teamMember.count({ where: { teamId: team.id } })).toBe(0);
  });

  it("only real users can be members: not unknown principals, and not another team's principal", async () => {
    const a = await admin();
    const team = await created(a, "nest");
    const other = await created(a, "nest-other");
    await rejects(addMember(db, a, team.id, "no-such-principal"), "not_found");
    await rejects(addMember(db, a, "no-such-team", a.principalId), "not_found");
    await rejects(addMember(db, a, team.id, other.principalId), "invalid");
    expect(await db.teamMember.count({ where: { teamId: team.id } })).toBe(0);
  });

  it("team roles are assigned by an admin only, from known role names, replacing the previous set", async () => {
    const a = await admin();
    const team = await created(a, "roles");
    const set = await setTeamRoles(db, a, team.id, ["model-manager", "viewer", "viewer"]);
    expect([...set.roles].sort()).toEqual(["model-manager", "viewer"]);
    await rejects(setTeamRoles(db, await manager(), team.id, ["admin"]), "forbidden");
    await rejects(setTeamRoles(db, a, team.id, ["admin", "not-a-role"]), "invalid");
    expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).roles.sort()).toEqual([
      "model-manager",
      "viewer",
    ]);
    expect((await setTeamRoles(db, a, team.id, [])).roles).toEqual([]);
    await rejects(setTeamRoles(db, a, "no-such-team", []), "not_found");
  });

  it("deleting a team drops its membership, grants and backing principal, for a manager only", async () => {
    const m = await manager();
    const team = await created(m, "delete");
    const user = await member();
    await addMember(db, m, team.id, user.principalId);
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: `tm-agent-${suffix}`,
        granteeKind: "principal",
        granteePrincipalId: team.principalId,
        granteeKey: `principal:${team.principalId}`,
        level: "read",
      },
    });
    await rejects(deleteTeam(db, await member(), team.id), "forbidden");
    await deleteTeam(db, m, team.id);
    expect(await db.team.count({ where: { id: team.id } })).toBe(0);
    expect(await db.teamMember.count({ where: { teamId: team.id } })).toBe(0);
    expect(await db.resourceGrant.count({ where: { granteePrincipalId: team.principalId } })).toBe(0);
    expect(await db.principal.count({ where: { id: team.principalId } })).toBe(0);
    expect(await db.principal.count({ where: { id: user.principalId } })).toBe(1);
    await rejects(deleteTeam(db, m, team.id), "not_found");
  });

  it("a team that owns a resource cannot be deleted, and nothing is lost", async () => {
    const a = await admin();
    const team = await created(a, "owns");
    const user = await member();
    await addMember(db, a, team.id, user.principalId);
    const store = await db.datastore.create({ data: { name: `tm-ds-${suffix}`, ownerId: team.principalId } });
    const err = await deleteTeam(db, a, team.id).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as TeamError).code).toBe("conflict");
    expect((err as TeamError).message).toMatch(/datastore/i);
    expect(await db.team.count({ where: { id: team.id } })).toBe(1);
    expect(await db.teamMember.count({ where: { teamId: team.id } })).toBe(1);
    await db.datastore.delete({ where: { id: store.id } });
    await deleteTeam(db, a, team.id);
    expect(await db.team.count({ where: { id: team.id } })).toBe(0);
  });

  it("every change is audited with the actor, and the trail survives the team", async () => {
    const a = await admin();
    const user = await member();
    const team = await created(a, "audit");
    await renameTeam(db, a, team.id, name("audit2"));
    await addMember(db, a, team.id, user.principalId);
    await addMember(db, a, team.id, user.principalId);
    await setTeamRoles(db, a, team.id, ["viewer"]);
    await removeMember(db, a, team.id, user.principalId);
    await deleteTeam(db, a, team.id);
    const rows = await db.teamAudit.findMany({ where: { teamId: team.id }, orderBy: [{ at: "asc" }, { id: "asc" }] });
    expect(rows.map((r) => r.action).sort()).toEqual(
      ["team.create", "team.delete", "team.member_add", "team.member_remove", "team.rename", "team.roles"].sort(),
    );
    expect(rows.every((r) => r.actorId === a.principalId)).toBe(true);
    expect(rows.find((r) => r.action === "team.member_add")?.detail).toEqual({ principalId: user.principalId });
  });

  describe("a Personal team", () => {
    async function userWithPersonalTeam() {
      const row = await db.principal.create({ data: newUserPrincipalData(`tm-personal-${randomUUID()}-${suffix}`) });
      principalIds.push(row.id);
      const personal = await db.team.findFirstOrThrow({ where: { principalId: row.id } });
      return { user: { principalId: row.id, roles: new Set<string>() }, personal };
    }

    it("cannot be renamed, deleted, given roles, or have its membership edited, even by an admin", async () => {
      const a = await admin();
      const { user, personal } = await userWithPersonalTeam();
      const other = await member();
      await rejects(renameTeam(db, a, personal.id, name("p-rename")), "invalid");
      await rejects(deleteTeam(db, a, personal.id), "invalid");
      await rejects(setTeamRoles(db, a, personal.id, ["viewer"]), "invalid");
      await rejects(addMember(db, a, personal.id, other.principalId), "invalid");
      await rejects(removeMember(db, a, personal.id, user.principalId), "invalid");
      const after = await db.team.findUniqueOrThrow({ where: { id: personal.id }, include: { members: true } });
      expect(after).toMatchObject({ name: personal.name, roles: [], personal: true });
      expect(after.members.map((m) => m.principalId)).toEqual([user.principalId]);
    });

    it("is listed for its user, and no shared team can take the reserved personal: name", async () => {
      const a = await admin();
      const { user, personal } = await userWithPersonalTeam();
      expect((await listTeams(db, user)).map((t) => t.id)).toEqual([personal.id]);
      await rejects(createTeam(db, a, { name: "personal:anything" }), "invalid");
      await rejects(createTeam(db, a, { name: "  personal:x" }), "invalid");
    });
  });
});
