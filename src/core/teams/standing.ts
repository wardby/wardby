/**
 * Standing: who a caller acts for and which roles it holds.
 *
 * A caller acts for its own principal plus the backing principal of every team
 * it belongs to, so "is this caller the owner" becomes `ownerId in actsFor`
 * (docs/private/adr/0003). Roles are the union of the caller's direct roles
 * (from the auth provider) and the roles its teams carry; unknown names grant
 * nothing.
 */
import type { PrismaClient } from "#prisma";
import { isRoleName } from "../../mcp/auth/resource-server.js";

export type StandingDb = Pick<PrismaClient, "teamMember">;

export interface Standing {
  /** The caller's own principal id first, then each team's backing principal id. */
  actsFor: string[];
  teamIds: string[];
  /** Valid wardby role names only. */
  roles: Set<string>;
}

export async function resolveStanding(
  db: StandingDb,
  principalId: string,
  directRoles: readonly string[] = [],
): Promise<Standing> {
  const memberships = await db.teamMember.findMany({
    where: { principalId },
    select: { team: { select: { id: true, principalId: true, roles: true } } },
    orderBy: { createdAt: "asc" },
  });
  const roles = new Set(directRoles.filter(isRoleName));
  for (const { team } of memberships) for (const role of team.roles) if (isRoleName(role)) roles.add(role);
  return {
    // A Personal team's backing principal is the user's own, so de-duplicate.
    actsFor: [...new Set([principalId, ...memberships.map(({ team }) => team.principalId)])],
    teamIds: memberships.map(({ team }) => team.id),
    roles,
  };
}
