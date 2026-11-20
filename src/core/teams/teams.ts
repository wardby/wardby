/**
 * Team management: the rules for creating, renaming, populating and deleting
 * teams, and who may. Callers pass an actor (their principal id plus the wardby
 * roles from Standing); there is no MCP here, so the CLI and the tools share
 * these rules. Every change and its audit row commit together. See
 * docs/private/adr/0001 and 0003.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, Team } from "#prisma";
import { isRoleName, permissionsOf } from "../../mcp/auth/resource-server.js";
import { TEAM_SUBJECT_PREFIX } from "../../providers/auth/subject.js";
import { PERSONAL_TEAM_NAME_PREFIX } from "./personal.js";

export type TeamDb = Pick<
  PrismaClient,
  "team" | "teamMember" | "teamAudit" | "principal" | "resourceGrant" | "$transaction"
>;

export interface TeamActor {
  principalId: string;
  /** wardby role names the actor holds (Standing.roles). */
  roles: ReadonlySet<string>;
}

export type TeamErrorCode = "forbidden" | "not_found" | "conflict" | "invalid";

export class TeamError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeamError";
  }
}

const MAX_NAME_LENGTH = 64;

function canManage(actor: TeamActor): boolean {
  return permissionsOf([...actor.roles]).has("teams:manage");
}

function requireManage(actor: TeamActor): void {
  if (!canManage(actor)) throw new TeamError("forbidden", "Managing teams needs the admin or team-manager role.");
}

function requireAdmin(actor: TeamActor): void {
  if (!actor.roles.has("admin")) throw new TeamError("forbidden", "Assigning a team's roles needs the admin role.");
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > MAX_NAME_LENGTH)
    throw new TeamError("invalid", `A team name is 1 to ${MAX_NAME_LENGTH} characters.`);
  if (name.toLowerCase().startsWith(PERSONAL_TEAM_NAME_PREFIX))
    throw new TeamError(
      "invalid",
      `Team names cannot start with "${PERSONAL_TEAM_NAME_PREFIX}"; that prefix is reserved.`,
    );
  return name;
}

function prismaCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

const notFound = (teamId: string) => new TeamError("not_found", `Team "${teamId}" not found.`);
const nameTaken = (name: string) => new TeamError("conflict", `A team named "${name}" already exists.`);

type Tx = Prisma.TransactionClient;

/** A Personal team is fixed: one member, no roles, never renamed or deleted. Call inside the change's transaction. */
async function assertShared(tx: Tx, teamId: string): Promise<void> {
  const team = await tx.team.findUnique({ where: { id: teamId }, select: { personal: true } });
  if (team?.personal) throw new TeamError("invalid", "A personal team cannot be changed.");
}

/** Appends the audit row in the change's own transaction. `detail` must never hold secret values. */
function audit(tx: Tx, actor: TeamActor, action: string, teamId: string, detail?: Prisma.InputJsonValue) {
  return tx.teamAudit.create({ data: { actorId: actor.principalId, action, teamId, detail } });
}

export async function createTeam(db: TeamDb, actor: TeamActor, input: { name: string }) {
  requireManage(actor);
  const name = cleanName(input.name);
  const id = randomUUID();
  try {
    return await db.$transaction(async (tx) => {
      const principal = await tx.principal.create({ data: { subject: `${TEAM_SUBJECT_PREFIX}${id}` } });
      const team = await tx.team.create({ data: { id, name, principalId: principal.id } });
      await audit(tx, actor, "team.create", id, { name });
      return team;
    });
  } catch (err) {
    if (prismaCode(err) === "P2002") throw nameTaken(name);
    throw err;
  }
}

export async function renameTeam(db: TeamDb, actor: TeamActor, teamId: string, rawName: string) {
  requireManage(actor);
  const name = cleanName(rawName);
  try {
    return await db.$transaction(async (tx) => {
      await assertShared(tx, teamId);
      const before = await tx.team.findUnique({ where: { id: teamId }, select: { name: true } });
      if (!before) throw notFound(teamId);
      const team = await tx.team.update({ where: { id: teamId }, data: { name } });
      await audit(tx, actor, "team.rename", teamId, { from: before.name, to: name });
      return team;
    });
  } catch (err) {
    if (prismaCode(err) === "P2002") throw nameTaken(name);
    throw err;
  }
}

export type ListedTeam = Team & { members?: { subject: string }[] };

/**
 * Every team for a manager, each with its members (by subject); only the teams
 * the actor belongs to, without member lists, otherwise.
 */
export async function listTeams(db: TeamDb, actor: TeamActor): Promise<ListedTeam[]> {
  if (!canManage(actor)) {
    return db.team.findMany({
      where: { members: { some: { principalId: actor.principalId } } },
      orderBy: { name: "asc" },
    });
  }
  const rows = await db.team.findMany({
    orderBy: { name: "asc" },
    include: { members: { select: { principal: { select: { subject: true } } } } },
  });
  return rows.map(({ members, ...team }) => ({
    ...team,
    members: members.map((m) => ({ subject: m.principal.subject })),
  }));
}

/** Adds a user to a team; a no-op (and no audit row) if already a member. Team principals cannot be members. */
export async function addMember(db: TeamDb, actor: TeamActor, teamId: string, principalId: string): Promise<void> {
  requireManage(actor);
  await db.$transaction(async (tx) => {
    await assertShared(tx, teamId);
    const [team, principal] = await Promise.all([
      tx.team.findUnique({ where: { id: teamId }, select: { id: true } }),
      tx.principal.findUnique({ where: { id: principalId }, select: { id: true, subject: true } }),
    ]);
    if (!team) throw notFound(teamId);
    if (!principal) throw new TeamError("not_found", `Principal "${principalId}" not found.`);
    if (principal.subject.startsWith(TEAM_SUBJECT_PREFIX))
      throw new TeamError("invalid", "A team cannot be a member of a team.");
    const { count } = await tx.teamMember.createMany({ data: [{ teamId, principalId }], skipDuplicates: true });
    if (count > 0) await audit(tx, actor, "team.member_add", teamId, { principalId });
  });
}

/** Removes a user from a team; a no-op (and no audit row) if not a member. */
export async function removeMember(db: TeamDb, actor: TeamActor, teamId: string, principalId: string): Promise<void> {
  requireManage(actor);
  await db.$transaction(async (tx) => {
    await assertShared(tx, teamId);
    const { count } = await tx.teamMember.deleteMany({ where: { teamId, principalId } });
    if (count > 0) await audit(tx, actor, "team.member_remove", teamId, { principalId });
  });
}

/** Replaces the wardby roles the team carries. Admin only, so a team-manager cannot escalate. */
export async function setTeamRoles(db: TeamDb, actor: TeamActor, teamId: string, roles: readonly string[]) {
  requireAdmin(actor);
  const unknown = roles.filter((role) => !isRoleName(role));
  if (unknown.length > 0) throw new TeamError("invalid", `Unknown role(s): ${unknown.join(", ")}.`);
  const next = [...new Set(roles)];
  return db.$transaction(async (tx) => {
    await assertShared(tx, teamId);
    const before = await tx.team.findUnique({ where: { id: teamId }, select: { roles: true } });
    if (!before) throw notFound(teamId);
    const team = await tx.team.update({ where: { id: teamId }, data: { roles: next } });
    await audit(tx, actor, "team.roles", teamId, { from: before.roles, to: next });
    return team;
  });
}

/**
 * Deletes a team, its membership and its grants, and frees its backing
 * principal. Refused while the team owns any resource: transfer those first.
 */
export async function deleteTeam(db: TeamDb, actor: TeamActor, teamId: string): Promise<void> {
  requireManage(actor);
  try {
    await db.$transaction(async (tx) => {
      await assertShared(tx, teamId);
      const team = await tx.team.findUnique({
        where: { id: teamId },
        select: {
          id: true,
          name: true,
          principalId: true,
          principal: {
            select: {
              _count: {
                select: {
                  agents: true,
                  tools: true,
                  secrets: true,
                  datastores: true,
                  webhooks: true,
                  budgetGroups: true,
                  mcpServers: true,
                },
              },
            },
          },
        },
      });
      if (!team) throw notFound(teamId);
      const owned = Object.entries(team.principal._count).filter(([, count]) => count > 0);
      if (owned.length > 0) {
        const what = owned.map(([kind, count]) => `${count} ${kind}`).join(", ");
        throw new TeamError("conflict", `Team "${team.name}" still owns ${what}; transfer them before deleting it.`);
      }
      const grants = await tx.resourceGrant.deleteMany({ where: { granteePrincipalId: team.principalId } });
      await tx.team.delete({ where: { id: teamId } });
      await tx.principal.delete({ where: { id: team.principalId } });
      await audit(tx, actor, "team.delete", teamId, { name: team.name, grantsRemoved: grants.count });
    });
  } catch (err) {
    // A resource created for the team after the check above: the owner foreign key blocks the delete.
    if (prismaCode(err) === "P2003")
      throw new TeamError("conflict", "The team gained a resource while being deleted; try again.");
    throw err;
  }
}
