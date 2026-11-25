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
import { Prisma, type PrismaClient } from "#prisma";
import { resolveStanding } from "./teams/standing.js";

export const LEVELS = {
  agent: ["read", "execute", "write"],
  tool: ["read", "use", "write"],
  budget_group: ["read", "use", "write"],
  mcp_server: ["read", "use", "write"],
  document: ["read", "comment", "write"],
  // Metadata only: a grantee sees that the resource exists and its name, never a value, and binds nothing.
  secret: ["read"],
  datastore: ["read"],
  webhook: ["read"],
} as const;

export type ResourceType = keyof typeof LEVELS;
export type Level<T extends ResourceType = ResourceType> = (typeof LEVELS)[T][number];
export type Access<T extends ResourceType = ResourceType> = "none" | Level<T> | "owner";

/**
 * Highest level an "everyone" grant may carry. Agents may be public-write
 * (anyone signed in can edit them) but only while they hold none of their
 * owner's bindings: see agentOwnerBindings and the guard in grant_access and
 * the binding tools. Otherwise anyone could rewrite the prompt of an agent
 * that holds its owner's secrets.
 */
export const EVERYONE_MAX = {
  agent: "write",
  tool: "use",
  budget_group: "use",
  mcp_server: "use",
  document: "comment",
  secret: "read",
  datastore: "read",
  webhook: "read",
} as const satisfies {
  [T in ResourceType]: Level<T>;
};

/** Types grant_access/revoke_access accept today. */
export const SHAREABLE_TYPES: readonly ResourceType[] = [
  "agent",
  "mcp_server",
  "document",
  "budget_group",
  "tool",
  "secret",
  "datastore",
  "webhook",
];

/** Types that cannot be shared with everyone: what they hold is private to their owner and the people named. */
export const NO_EVERYONE_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>(["secret", "datastore", "webhook"]);

export const EVERYONE_KEY = "everyone";

export function principalGranteeKey(principalId: string): string {
  return `principal:${principalId}`;
}

export function agentGranteeKey(agentId: string): string {
  return `agent:${agentId}`;
}

/** Agents never hold write on a document through a grant: write comes from Document.agentId (#625). */
export const AGENT_DOCUMENT_GRANT_MAX = "comment";

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

/**
 * Who a grant lookup is for: one principal id, none (everyone grants only), or
 * every principal id the caller acts for (its own plus its Teams' backing
 * principals, see core/teams/standing.ts).
 */
export type Acting = string | null | readonly string[];

function actingIds(acting: Acting): readonly string[] {
  if (acting === null) return [];
  return typeof acting === "string" ? [acting] : acting;
}

/** True when `ownerId` is one of the principals `acting` stands for. */
export function actsForOwner(acting: Acting, ownerId: string | null): boolean {
  return ownerId !== null && actingIds(acting).includes(ownerId);
}

/**
 * The Prisma filter for "owned by a principal `acting` stands for". One principal keeps the plain equality, so
 * a caller with no Team reads the same query as before; a caller with Teams matches any of them.
 */
export function ownedByWhere(acting: Acting): { ownerId: string } | { ownerId: { in: string[] } } {
  const ids = [...actingIds(acting)];
  return ids.length === 1 ? { ownerId: ids[0] } : { ownerId: { in: ids } };
}

function granteeKeys(acting: Acting): string[] {
  return [...actingIds(acting).map(principalGranteeKey), EVERYONE_KEY];
}

/**
 * max(owner, principal grant, everyone grant). The caller owns the resource when
 * its owner is any principal it acts for, and holds a grant made to any of them.
 * `principal` null (e.g. a legacy webhook with no recorded creator) gets
 * everyone grants only.
 * `operator` is the stdio local operator (McpRequestContext.operator) or an owner-all caller (isOwnerAll),
 * owner of everything for access checks — never for binding rules.
 */
export async function accessFor<T extends ResourceType>(
  db: GrantDb,
  type: T,
  resource: { id: string; ownerId: string | null },
  principal: Acting,
  opts?: { operator?: boolean },
): Promise<Access<T>> {
  if (opts?.operator) return "owner";
  if (actsForOwner(principal, resource.ownerId)) return "owner";
  const rows = await db.resourceGrant.findMany({
    where: { resourceType: type, resourceId: resource.id, granteeKey: { in: granteeKeys(principal) } },
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
  principal: Acting,
): Promise<Map<string, Level<T>>> {
  const rows = await db.resourceGrant.findMany({
    where: { resourceType: type, granteeKey: { in: granteeKeys(principal) } },
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
  principal: Acting,
  minLevel: Level<T>,
): Promise<string[]> {
  const map = await grantedAccessMap(db, type, principal);
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
  return atLeast("agent", await accessFor(db, "agent", child, parent.ownerId), "execute");
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

/**
 * True when `ownerId` owns the MCP server or holds use (or higher) on it through a grant. An agent's MCP
 * attachment is legitimate only while its owner can use the server: runs check it on load and on every
 * call, and the cleanup paths (make_owner, adopt-public, prune-bindings, revoke_access and grant_access
 * lowering a level) drop the attachments that fail it.
 */
export async function ownerCanUseMcpServer(
  db: GrantDb,
  ownerId: string | null,
  server: { id: string; ownerId: string | null },
): Promise<boolean> {
  if (ownerId === null) return false;
  return atLeast("mcp_server", await accessFor(db, "mcp_server", server, ownerId), "use");
}

/** Keeps the items whose server the owner cannot use (see ownerCanUseMcpServer). */
export async function filterUnusableMcpServers<T extends { server: { id: string; ownerId: string | null } }>(
  db: GrantDb,
  ownerOf: (item: T) => string | null,
  items: T[],
): Promise<T[]> {
  const unusable: T[] = [];
  for (const item of items) {
    if (!(await ownerCanUseMcpServer(db, ownerOf(item), item.server))) unusable.push(item);
  }
  return unusable;
}

/**
 * After a grant on an MCP server is revoked or lowered: deletes the server's attachments whose agent owner
 * can no longer use it (see ownerCanUseMcpServer), in the caller's transaction. The server owner's own
 * agents are never touched. Returns how many were removed.
 */
export async function pruneUnusableMcpAttachments(
  db: GrantDb & Pick<PrismaClient, "agentMcpServer">,
  serverId: string,
): Promise<number> {
  const rows = await db.agentMcpServer.findMany({
    where: { serverId },
    include: { server: { select: { id: true, ownerId: true } }, agent: { select: { ownerId: true } } },
  });
  const unusable = await filterUnusableMcpServers(db, (row) => row.agent.ownerId, rows);
  if (unusable.length === 0) return 0;
  const { count } = await db.agentMcpServer.deleteMany({
    where: { serverId, agentId: { in: unusable.map((row) => row.agentId) } },
  });
  return count;
}

/**
 * True when an agent owned by `ownerId` may spend against `group`: the group is public (no owner), or the
 * owner owns it or holds use (or higher) through a grant. An owner-less agent only reaches public groups.
 */
export async function ownerCanUseBudgetGroup(
  db: GrantDb,
  ownerId: string | null,
  group: { id: string; ownerId: string | null },
): Promise<boolean> {
  if (group.ownerId === null) return true;
  if (ownerId === null) return false;
  return atLeast("budget_group", await accessFor(db, "budget_group", group, ownerId), "use");
}

/** Remembers the answer per principal, so a prune asks the database once for each distinct owner. */
function once<K, V>(compute: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const seen = new Map<K, Promise<V>>();
  return (key) => {
    let value = seen.get(key);
    if (!value) seen.set(key, (value = compute(key)));
    return value;
  };
}

/**
 * After a grant on a budget group is revoked or lowered: removes the group from the agents whose owner can no
 * longer use it (their budgetGroupId becomes null), in the caller's transaction. The group owner's own agents
 * are never touched. Returns how many agents were ungrouped.
 */
export async function pruneUnusableBudgetGroupMembers(
  db: GrantDb & Pick<PrismaClient, "agent" | "budgetGroup">,
  groupId: string,
): Promise<number> {
  const group = await db.budgetGroup.findUnique({ where: { id: groupId }, select: { id: true, ownerId: true } });
  if (!group) return 0;
  const members = await db.agent.findMany({ where: { budgetGroupId: groupId }, select: { id: true, ownerId: true } });
  const canUse = once((ownerId: string | null) => ownerCanUseBudgetGroup(db, ownerId, group));
  const unusable: string[] = [];
  for (const member of members) {
    if (!(await canUse(member.ownerId))) unusable.push(member.id);
  }
  if (unusable.length === 0) return 0;
  const { count } = await db.agent.updateMany({ where: { id: { in: unusable } }, data: { budgetGroupId: null } });
  return count;
}

/**
 * True when an agent owned by `ownerId` may run `tool`: the tool is public (no owner), or the owner owns it or
 * holds use (or higher) through a grant. An owner-less agent only reaches public tools.
 */
export async function ownerCanUseTool(
  db: GrantDb,
  ownerId: string | null,
  tool: { id: string; ownerId: string | null },
): Promise<boolean> {
  if (tool.ownerId === null) return true;
  if (ownerId === null) return false;
  return atLeast("tool", await accessFor(db, "tool", tool, ownerId), "use");
}

/**
 * After a grant on a tool is revoked or lowered: deletes the attachments and run hooks of the tool that are no
 * longer legitimate, in the caller's transaction. One stays while EITHER the agent's owner can use the tool (a
 * grant to the owner) OR the principal who attached it can (a write-grantee attaching a tool they own or were
 * granted); a row with no recorded attacher is left alone. The attacher is judged with their Teams, as they were
 * when they attached. The tool owner's own agents are never touched. Returns how many were removed.
 */
export async function pruneUnusableToolAttachments(
  db: GrantDb & Pick<PrismaClient, "tool" | "agentTool" | "runHook" | "teamMember">,
  toolId: string,
): Promise<number> {
  const tool = await db.tool.findUnique({ where: { id: toolId }, select: { id: true, ownerId: true } });
  if (!tool) return 0;
  const [attachments, hooks] = await Promise.all([
    db.agentTool.findMany({
      where: { toolId },
      select: { agentId: true, attachedById: true, agent: { select: { ownerId: true } } },
    }),
    db.runHook.findMany({
      where: { toolId },
      select: { id: true, createdById: true, agent: { select: { ownerId: true } } },
    }),
  ]);
  const ownerCanUse = once((ownerId: string | null) => ownerCanUseTool(db, ownerId, tool));
  const attacherCanUse = once(async (principalId: string) => {
    const { actsFor } = await resolveStanding(db, principalId);
    return atLeast("tool", await accessFor(db, "tool", tool, actsFor), "use");
  });
  const legitimate = async (ownerId: string | null, attacherId: string | null) =>
    (await ownerCanUse(ownerId)) || (attacherId !== null && (await attacherCanUse(attacherId)));
  const unusableAgents: string[] = [];
  for (const row of attachments) {
    if (row.attachedById !== null && !(await legitimate(row.agent.ownerId, row.attachedById))) {
      unusableAgents.push(row.agentId);
    }
  }
  const unusableHooks: string[] = [];
  for (const row of hooks) {
    if (!(await legitimate(row.agent.ownerId, row.createdById))) unusableHooks.push(row.id);
  }
  const [removedAttachments, removedHooks] = await Promise.all([
    unusableAgents.length
      ? db.agentTool.deleteMany({ where: { toolId, agentId: { in: unusableAgents } } })
      : { count: 0 },
    unusableHooks.length ? db.runHook.deleteMany({ where: { id: { in: unusableHooks } } }) : { count: 0 },
  ]);
  return removedAttachments.count + removedHooks.count;
}

/** Every resource delete path calls this in the same transaction (no FK on resourceId). */
export async function deleteGrantsFor(db: GrantDb, type: ResourceType, resourceId: string): Promise<number> {
  const { count } = await db.resourceGrant.deleteMany({ where: { resourceType: type, resourceId } });
  return count;
}

type BindingDb = Pick<
  PrismaClient,
  | "agentSecret"
  | "agentDatastore"
  | "agentRepository"
  | "agentSubAgent"
  | "agentTool"
  | "codingAgentProfile"
  | "agentMcpServer"
  | "agent"
>;

/**
 * The owner-only bindings an agent holds, by kind (empty = none). An agent
 * may be public-write only while this is empty; binding a secret, datastore,
 * repository, sub-agent or owner-granted tool capability to a public-write
 * agent is refused for the same reason. A coding profile counts: its
 * repository is the owner's GitHub access, and the prompt is part of every
 * coding task.
 */
export async function agentOwnerBindings(db: BindingDb, agentId: string): Promise<string[]> {
  const [secrets, datastores, repositories, subagents, capabilityTools, codingProfiles, mcpServers, documentTools] =
    await Promise.all([
      db.agentSecret.count({ where: { agentId } }),
      db.agentDatastore.count({ where: { agentId } }),
      db.agentRepository.count({ where: { agentId } }),
      db.agentSubAgent.count({ where: { parentAgentId: agentId } }),
      // The owner's attach_tool stamps its consent even when it grants nothing:
      // only an attachment that carries a capability counts.
      db.agentTool.count({
        where: {
          agentId,
          capabilitiesGrantedById: { not: null },
          NOT: {
            allowedSecrets: { equals: [] },
            allowedDatastorePrefixes: { equals: [] },
            allowedHosts: { equals: [] },
            allowedSharedDatastorePrefixes: { equals: {} },
          },
        },
      }),
      db.codingAgentProfile.count({ where: { agentId } }),
      // A server's brokered secrets act for its owner on every call.
      db.agentMcpServer.count({ where: { agentId } }),
      // The built-in document tools create documents owned by the agent's owner and submit them to the owner's
      // chosen reviewers; they never use the owner's own access to documents.
      db.agent.count({ where: { id: agentId, documentTools: { not: Prisma.DbNull } } }),
    ]);
  return Object.entries({
    secrets,
    datastores,
    repositories,
    "sub-agents": subagents,
    "tool capabilities": capabilityTools,
    "a coding repository": codingProfiles,
    "MCP servers": mcpServers,
    "document tools": documentTools,
  })
    .filter(([, count]) => count > 0)
    .map(([kind]) => kind);
}

/** True when everyone holds write on the agent. */
export async function isPublicWritable(db: GrantDb, agentId: string): Promise<boolean> {
  const row = await db.resourceGrant.findFirst({
    where: { resourceType: "agent", resourceId: agentId, granteeKey: EVERYONE_KEY },
    select: { level: true },
  });
  return row !== null && atLeast("agent", row.level, "write");
}
