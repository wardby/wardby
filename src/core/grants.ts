/**
 * Resource sharing grants: the rules, as pure data and database lookups.
 * No McpError here, so the runner and the CLI use the same rules as the MCP
 * tools (the MCP seam is src/mcp/auth/access.ts). See
 * docs/private/2026-09-26-resource-sharing-grants-spec-and-plan.md §3.
 *
 * A grant is (resourceType, resourceId, grantee, level); the grantee is one
 * principal or everyone. Each type has ordered levels, read first; the
 * owner is above every level. Owner-less rows (ownerId null) are a
 * transition state: nobody is their owner, so access comes from grants only.
 */
import type { PrismaClient } from "#prisma";

export const LEVELS = {
  agent: ["read", "execute", "write"],
  tool: ["read", "use", "write"],
  budget_group: ["read", "use", "write"],
} as const;

export type ResourceType = keyof typeof LEVELS;
export type Level<T extends ResourceType = ResourceType> = (typeof LEVELS)[T][number];
export type Access<T extends ResourceType = ResourceType> = "none" | Level<T> | "owner";

/**
 * Highest level an "everyone" grant may carry: never write. Everyone-write
 * on an agent would bring back the old public-mutable model (anyone
 * rewriting the prompt of an agent that holds its owner's tools and
 * secrets). Also applied when a stored everyone row is read, so a row
 * written around grant_access can't exceed it either.
 */
export const EVERYONE_MAX = { agent: "execute", tool: "use", budget_group: "use" } as const satisfies {
  [T in ResourceType]: Level<T>;
};

/** Types grant_access/revoke_access accept today (Phase 1: agents only). */
export const SHAREABLE_TYPES: readonly ResourceType[] = ["agent"];

export const EVERYONE_KEY = "everyone";

export function principalGranteeKey(principalId: string): string {
  return `principal:${principalId}`;
}

export function isResourceType(value: string): value is ResourceType {
  return Object.hasOwn(LEVELS, value);
}

export function isLevel<T extends ResourceType>(type: T, value: string): value is Level<T> {
  return (LEVELS[type] as readonly string[]).includes(value);
}

/** none = 0, levels 1..n in order, owner = n + 1. Anything unknown ranks as none. */
export function accessRank(type: ResourceType, access: string): number {
  if (access === "owner") return LEVELS[type].length + 1;
  const index = (LEVELS[type] as readonly string[]).indexOf(access);
  return index + 1;
}

export function atLeast(type: ResourceType, access: string, required: string): boolean {
  const need = accessRank(type, required);
  return need > 0 && accessRank(type, access) >= need;
}

function capEveryone(type: ResourceType, level: string): string {
  const cap = EVERYONE_MAX[type];
  return accessRank(type, level) > accessRank(type, cap) ? cap : level;
}

type GrantRow = { granteeKey: string; level: string };

/** The level a stored row actually confers: unknown levels are none, everyone rows are capped. */
function rowLevel(type: ResourceType, row: GrantRow): string {
  if (!isLevel(type, row.level)) return "none";
  return row.granteeKey === EVERYONE_KEY ? capEveryone(type, row.level) : row.level;
}

function best(type: ResourceType, a: string, b: string): string {
  return accessRank(type, b) > accessRank(type, a) ? b : a;
}

export type GrantDb = Pick<PrismaClient, "resourceGrant">;

function granteeKeys(principalId: string | null): string[] {
  return principalId ? [principalGranteeKey(principalId), EVERYONE_KEY] : [EVERYONE_KEY];
}

/**
 * max(owner, principal grant, everyone grant). `principalId` null (e.g. a
 * legacy webhook with no recorded creator) gets everyone grants only.
 * `operator` is the stdio local operator (McpRequestContext.operator),
 * owner of everything for access checks — never for binding rules.
 */
export async function effectiveAccess<T extends ResourceType>(
  db: GrantDb,
  type: T,
  resource: { id: string; ownerId: string | null },
  principalId: string | null,
  opts?: { operator?: boolean },
): Promise<Access<T>> {
  if (opts?.operator) return "owner";
  if (principalId !== null && resource.ownerId !== null && resource.ownerId === principalId) return "owner";
  const rows = await db.resourceGrant.findMany({
    where: { resourceType: type, resourceId: resource.id, granteeKey: { in: granteeKeys(principalId) } },
    select: { granteeKey: true, level: true },
  });
  let access = "none";
  for (const row of rows) access = best(type, access, rowLevel(type, row));
  return access as Access<T>;
}

/**
 * resourceId -> best level the principal holds through grants (ownership
 * not included). A null principal gets everyone grants only (e.g. an HTTP
 * connection whose identity isn't known yet).
 */
export async function grantedAccessMap<T extends ResourceType>(
  db: GrantDb,
  type: T,
  principalId: string | null,
): Promise<Map<string, Level<T>>> {
  const rows = await db.resourceGrant.findMany({
    where: { resourceType: type, granteeKey: { in: granteeKeys(principalId) } },
    select: { resourceId: true, granteeKey: true, level: true },
  });
  const map = new Map<string, string>();
  for (const row of rows) {
    const level = rowLevel(type, row);
    if (level === "none") continue;
    map.set(row.resourceId, best(type, map.get(row.resourceId) ?? "none", level));
  }
  return map as Map<string, Level<T>>;
}

/** Ids the principal holds >= minLevel on through grants (own rows come from ownerId). */
export async function grantedIds<T extends ResourceType>(
  db: GrantDb,
  type: T,
  principalId: string | null,
  minLevel: Level<T>,
): Promise<string[]> {
  const map = await grantedAccessMap(db, type, principalId);
  return [...map].filter(([, level]) => atLeast(type, level, minLevel)).map(([id]) => id);
}

/**
 * Sub-agent edge rule (spec §3.4.4), evaluated live at attach time and on
 * every delegation: the child has the parent's owner (owner-less on both
 * sides counts as the same), or the parent's owner holds at least execute
 * on the child. An owner-less parent never reaches an owned child.
 */
export async function canDelegate(
  db: GrantDb,
  parent: { ownerId: string | null },
  child: { id: string; ownerId: string | null },
): Promise<boolean> {
  if (parent.ownerId === child.ownerId) return true;
  if (parent.ownerId === null) return false;
  return atLeast("agent", await effectiveAccess(db, "agent", child, parent.ownerId), "execute");
}

/** The create-data for an everyone grant (migration, import, CLI --public). */
export function everyoneGrantData(type: ResourceType, resourceId: string, level: string, source: string) {
  return {
    resourceType: type,
    resourceId,
    granteeKind: "everyone",
    granteePrincipalId: null,
    granteeKey: EVERYONE_KEY,
    level,
    source,
  };
}

/** Every resource delete path calls this in the same transaction (no FK on resourceId). */
export async function deleteGrantsFor(db: GrantDb, type: ResourceType, resourceId: string): Promise<number> {
  const { count } = await db.resourceGrant.deleteMany({ where: { resourceType: type, resourceId } });
  return count;
}
