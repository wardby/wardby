/**
 * The MCP seam for agent access (resource-sharing grants spec §3.3). Every
 * agent tool routes through here instead of ownership.ts's owner-or-public
 * rule, which no longer applies to agents: an owner-less agent is reachable
 * only through its grants (the migration gives everyone execute).
 *
 * - Below read: 404 with the same text as a missing row, so existence never
 *   leaks. At read or above but below the level required: 403 naming both.
 * - The helpers take a `db` argument so a Serializable transaction reads the
 *   grant rows through `tx`; a concurrent revoke then conflicts instead of
 *   racing.
 * - `ctx.operator` (stdio's local operator, never an HTTP principal) is
 *   owner of every agent for access checks and sees every agent in
 *   listings, but does NOT bypass requireBindingOwner: one owner's secrets,
 *   datastores and repositories never reach another owner's agent.
 */
import type { Prisma, PrismaClient } from "#prisma";
import { atLeast, effectiveAccess, grantedAccessMap, grantedIds, type Access, type Level } from "../../core/grants.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";

export type AgentLevel = Level<"agent">;
export type AgentAccess = Access<"agent">;
type AgentRef = { id: string; ownerId: string | null };
type GrantDb = Pick<PrismaClient, "resourceGrant">;

export function agentNotFound(id: string): McpError {
  return new McpError(404, `Agent "${id}" not found.`);
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
  return effectiveAccess(db, "agent", agent, ctx.principal.id, { operator: ctx.operator === true });
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
  if (!atLeast("agent", access, "read")) throw agentNotFound(id);
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
 * it can adopt the agent first (make_owner / grants adopt-public).
 */
export function requireBindingOwner(ctx: McpRequestContext, agent: AgentRef): void {
  if (agent.ownerId === null) {
    throw new McpError(
      403,
      `Agent "${agent.id}" has no owner, so nothing can be bound to it; an admin can assign one with make_owner.`,
    );
  }
  if (agent.ownerId !== ctx.principal.id) {
    throw new McpError(403, `Only the owner of agent "${agent.id}" can change its bindings.`);
  }
}

/** Prisma where for agent listings: own rows plus rows granted >= read; the operator sees all. */
export async function readableAgentsWhere(
  ctx: McpRequestContext,
  db: GrantDb = ctx.db,
): Promise<Prisma.AgentWhereInput> {
  if (ctx.operator) return {};
  const ids = await grantedIds(db, "agent", ctx.principal.id, "read");
  return { OR: [{ ownerId: ctx.principal.id }, { id: { in: ids } }] };
}

/** One grant lookup for a whole listing: returns agent -> the caller's access. */
export async function agentAccessResolver(
  ctx: McpRequestContext,
  db: GrantDb = ctx.db,
): Promise<(agent: AgentRef) => AgentAccess> {
  if (ctx.operator) return () => "owner";
  const granted = await grantedAccessMap(db, "agent", ctx.principal.id);
  return (agent) =>
    agent.ownerId !== null && agent.ownerId === ctx.principal.id ? "owner" : (granted.get(agent.id) ?? "none");
}
