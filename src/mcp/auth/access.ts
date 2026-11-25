/**
 * The MCP seam for agent access (resource-sharing grants spec §3.3). Every
 * agent tool routes through here instead of ownership.ts's owner-or-public
 * rule, which no longer applies to agents: an owner-less agent is reachable
 * only through its grants (the migration gives everyone execute).
 *
 * - Below read: 404 with the same text as a missing row, so existence never
 *   leaks; except to an admin:view caller, who already sees every agent in
 *   the deployment-wide listing and gets a 403 saying it has no access. At
 *   read or above but below the level required: 403 naming both.
 * - The helpers take a `db` argument so a Serializable transaction reads the
 *   grant rows through `tx`; a concurrent revoke then conflicts instead of
 *   racing.
 * - `ctx.operator` (stdio's local operator, never an HTTP principal) and an
 *   owner-all caller (owner:all scope + wardby_owner role, see isOwnerAll)
 *   are owner of every agent for access checks and see every agent in
 *   listings; only an owner-all caller also passes requireBindingOwner.
 */
import type { Prisma, PrismaClient } from "#prisma";
import {
  actsForOwner,
  atLeast,
  accessFor,
  grantedAccessMap,
  grantedIds,
  isPublicWritable,
  ownedByWhere,
  type Access,
  type Level,
} from "../../core/grants.js";
import { check } from "../../authz/index.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import { isOwnerAll } from "./resource-server.js";

export type AgentLevel = Level<"agent">;
export type AgentAccess = Access<"agent">;
type AgentRef = { id: string; ownerId: string | null };
type GrantDb = Pick<PrismaClient, "resourceGrant">;

/** The principal ids the caller acts for: its own, then its Teams' (McpRequestContext.actsFor). */
export function actsForOf(ctx: Pick<McpRequestContext, "principal" | "actsFor">): readonly string[] {
  return ctx.actsFor ?? [ctx.principal.id];
}

/** True when the caller owns a resource: its owner is the caller or a Team the caller belongs to. */
export function ownsResource(ctx: Pick<McpRequestContext, "principal" | "actsFor">, ownerId: string | null): boolean {
  return actsForOwner(actsForOf(ctx), ownerId);
}

/** True when the caller owns an agent: its owner is the caller or a Team the caller belongs to. */
export function ownsAgent(ctx: Pick<McpRequestContext, "principal" | "actsFor">, agent: AgentRef): boolean {
  return actsForOwner(actsForOf(ctx), agent.ownerId);
}

export function agentNotFound(id: string): McpError {
  return new McpError(404, `Agent "${id}" not found.`);
}

/** For a caller who can see the agent through admin:view but has no grant on it. */
export function noAgentAccess(id: string): McpError {
  return new McpError(
    403,
    `Agent "${id}": you have no access to this agent (access: none). You can see it in the deployment-wide ` +
      "listing (admin:view), but reading or running it needs a grant from its owner. See help article " +
      '"identity-and-access".',
  );
}

function describeLevel(level: AgentLevel | "owner"): string {
  return level === "owner" ? "the agent's owner" : `${level} access`;
}

export function insufficientAgentAccess(id: string, required: AgentLevel | "owner", held: AgentAccess): McpError {
  return new McpError(
    403,
    `Agent "${id}": this needs ${describeLevel(required)}; you have ${held === "owner" ? "owner" : held} access.`,
  );
}

/** The caller's access to an agent row already read. */
export function agentAccess(ctx: McpRequestContext, agent: AgentRef, db: GrantDb = ctx.db): Promise<AgentAccess> {
  return accessFor(db, "agent", agent, actsForOf(ctx), { operator: ctx.operator === true || isOwnerAll(ctx) });
}

/** For a row already read (inside a transaction, or with includes): 404 below read, 403 below `required`. */
export async function assertAgentAccess<A extends AgentRef>(
  ctx: McpRequestContext,
  agent: A | null,
  id: string,
  required: AgentLevel | "owner",
  db: GrantDb = ctx.db,
): Promise<{ agent: A; access: AgentAccess }> {
  if (!agent) throw agentNotFound(id);
  const access = await agentAccess(ctx, agent, db);
  if (!atLeast("agent", access, "read")) {
    // An admin:view caller already sees every agent in list_agents { all: true }, so saying it exists
    // leaks nothing; "not found" would contradict that listing.
    if (check(ctx, ["admin:view"]) === null) throw noAgentAccess(id);
    throw agentNotFound(id);
  }
  if (!atLeast("agent", access, required)) throw insufficientAgentAccess(id, required, access);
  return { agent, access };
}

/** 404 if missing or access < read; 403 if read <= access < required. Returns row + access. */
export async function requireAgentAccess(
  ctx: McpRequestContext,
  id: string,
  required: AgentLevel | "owner",
  db: Pick<PrismaClient, "agent" | "resourceGrant"> = ctx.db,
) {
  const agent = await db.agent.findUnique({ where: { id } });
  return assertAgentAccess(ctx, agent, id, required, db);
}

/**
 * Bindings (secrets, datastores, repositories, capability grants): strict
 * ownership, whatever the grants. The stdio operator does NOT bypass this:
 * it can adopt the agent first (make_owner / grants adopt-public). An
 * owner-all caller (owner:all + wardby_owner) does bypass it: it may bind its
 * own secrets and datastores to any agent.
 */
export function requireBindingOwner(ctx: McpRequestContext, agent: AgentRef): void {
  if (isOwnerAll(ctx)) return;
  if (agent.ownerId === null) {
    throw new McpError(
      403,
      `Agent "${agent.id}" has no owner, so nothing can be bound to it; an admin can assign one with make_owner.`,
    );
  }
  if (!ownsAgent(ctx, agent)) {
    throw new McpError(403, `Only the owner of agent "${agent.id}" can change its bindings.`);
  }
}

/**
 * requireBindingOwner, plus: nothing owner-held may be bound to an agent
 * everyone can write (anyone could then rewrite it to use the binding).
 */
export async function requireBindable(ctx: McpRequestContext, agent: AgentRef, db: GrantDb = ctx.db): Promise<void> {
  requireBindingOwner(ctx, agent);
  await requireNotPublicWritable(agent, db);
}

/** The public-write half of requireBindable, for paths that skip the owner check (an admin's adminOverride). */
export async function requireNotPublicWritable(agent: AgentRef, db: GrantDb): Promise<void> {
  if (await isPublicWritable(db, agent.id)) {
    throw new McpError(
      409,
      `Agent "${agent.id}" is writable by everyone, so nothing can be bound to it; revoke or lower the everyone grant first.`,
    );
  }
}

/** Prisma where for agent listings: own rows plus rows granted >= read; the operator sees all. */
export async function readableAgentsWhere(
  ctx: McpRequestContext,
  db: GrantDb = ctx.db,
): Promise<Prisma.AgentWhereInput> {
  if (ctx.operator || isOwnerAll(ctx)) return {};
  const acting = actsForOf(ctx);
  const ids = await grantedIds(db, "agent", acting, "read");
  return { OR: [ownedByWhere(acting), { id: { in: ids } }] };
}

/** One grant lookup for a whole listing: returns agent -> the caller's access. */
export async function agentAccessResolver(
  ctx: McpRequestContext,
  db: GrantDb = ctx.db,
): Promise<(agent: AgentRef) => AgentAccess> {
  if (ctx.operator || isOwnerAll(ctx)) return () => "owner";
  const granted = await grantedAccessMap(db, "agent", actsForOf(ctx));
  return (agent) => (ownsAgent(ctx, agent) ? "owner" : (granted.get(agent.id) ?? "none"));
}
