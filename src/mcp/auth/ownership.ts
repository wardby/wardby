/**
 * Single seam for ownership decisions across Agent/BudgetGroup/Tool/Secret/
 * Webhook/Task (and anything else that gains a nullable owner column
 * later). A null owner means "public": readable AND mutable by anyone —
 * there is no gatekeeper, so no principal is turned away. `isOwner` stays
 * available (strict, no null-passthrough) for checks that must stay
 * owner-only regardless of publicness — e.g. a future claim-on-edit
 * feature would use it to tell "already owned" apart from "public" before
 * deciding whether to stamp a new owner. Every tool file routes through
 * this module instead of re-deriving the null-handling itself, so changing
 * the policy again later is a change here, not an N-file sweep.
 */
import type { PrismaClient, Tool } from "#prisma";
import { McpError } from "../errors.js";

export function canRead(ownerId: string | null, principalId: string): boolean {
  return ownerId === null || ownerId === principalId;
}

export function isOwner(ownerId: string | null, principalId: string): boolean {
  return ownerId === principalId;
}

/** Same rule as canRead: a null owner is a mutation target for anyone, same as it's a read target for anyone. */
export function canMutate(ownerId: string | null, principalId: string): boolean {
  return ownerId === null || ownerId === principalId;
}

export function assertCanMutate(ownerId: string | null, principalId: string, notFoundMessage: string): void {
  if (!canMutate(ownerId, principalId)) throw new McpError(403, notFoundMessage);
}

/** Prisma where-clause fragment: rows owned by the caller, plus public (null-owner) rows. */
export function visibleToPrincipal(principalId: string) {
  return { OR: [{ ownerId: principalId }, { ownerId: null }] };
}

export async function requireOwnedAgent(db: PrismaClient, id: string, principalId: string) {
  const agent = await db.agent.findUnique({ where: { id } });
  if (!agent) throw new McpError(404, `Agent "${id}" not found.`);
  assertCanMutate(agent.ownerId, principalId, `Agent "${id}" is not owned by the caller.`);
  return agent;
}

export async function requireReadableAgent(db: PrismaClient, id: string, principalId: string) {
  const agent = await db.agent.findUnique({ where: { id } });
  if (!agent || !canRead(agent.ownerId, principalId)) {
    throw new McpError(404, `Agent "${id}" not found.`);
  }
  return agent;
}

export async function requireOwnedBudgetGroup(db: PrismaClient, id: string, principalId: string) {
  const group = await db.budgetGroup.findUnique({ where: { id } });
  if (!group) throw new McpError(404, `Budget group "${id}" not found.`);
  assertCanMutate(group.ownerId, principalId, `Budget group "${id}" is not owned by the caller.`);
  return group;
}

export async function requireReadableBudgetGroup(db: PrismaClient, id: string, principalId: string) {
  const group = await db.budgetGroup.findUnique({ where: { id } });
  if (!group || !canRead(group.ownerId, principalId)) {
    throw new McpError(404, `Budget group "${id}" not found.`);
  }
  return group;
}

export async function requireOwnedSecret(db: PrismaClient, id: string, principalId: string): Promise<void> {
  const secret = await db.secret.findUnique({ where: { id } });
  if (!secret) throw new McpError(403, `Secret "${id}" is not owned by the caller.`);
  assertCanMutate(secret.ownerId, principalId, `Secret "${id}" is not owned by the caller.`);
}

export async function requireOwnedWebhook(db: PrismaClient, id: string, principalId: string): Promise<void> {
  const webhook = await db.webhook.findUnique({ where: { id } });
  if (!webhook) throw new McpError(403, `Webhook "${id}" is not owned by the caller.`);
  assertCanMutate(webhook.ownerId, principalId, `Webhook "${id}" is not owned by the caller.`);
}

export async function requireOwnedDatastore(db: PrismaClient, id: string, principalId: string) {
  const datastore = await db.datastore.findUnique({ where: { id } });
  if (!datastore) throw new McpError(403, `Datastore "${id}" is not owned by the caller.`);
  assertCanMutate(datastore.ownerId, principalId, `Datastore "${id}" is not owned by the caller.`);
  return datastore;
}

export async function requireOwnedTool(db: Pick<PrismaClient, "tool">, id: string, principalId: string): Promise<Tool> {
  const tool = await db.tool.findUnique({ where: { id } });
  if (!tool) throw new McpError(404, `Tool "${id}" not found.`);
  assertCanMutate(tool.ownerId, principalId, `Tool "${id}" is not owned by the caller.`);
  return tool;
}

/**
 * Owner-only, with no null-is-public passthrough: for changing or removing
 * a tool's code (update_tool/delete_tool), where requireOwnedTool's rule
 * would let anyone rewrite a public tool. A public tool is readable but
 * immutable over MCP (403) -- only an operator can change one, via the CLI.
 * A tool the caller can't read is 404, the same as a missing one.
 */
export async function requireStrictlyOwnedTool(
  db: Pick<PrismaClient, "tool">,
  id: string,
  principalId: string,
): Promise<Tool> {
  return assertStrictlyOwnedTool(await db.tool.findUnique({ where: { id } }), id, principalId);
}

/** requireStrictlyOwnedTool's rule for a row already read (e.g. inside core/tool-admin.ts's transaction). */
export function assertStrictlyOwnedTool(tool: Tool | null, id: string, principalId: string): Tool {
  if (!tool || !canRead(tool.ownerId, principalId)) throw new McpError(404, `Tool "${id}" not found.`);
  if (!isOwner(tool.ownerId, principalId)) {
    throw new McpError(403, `Tool "${id}" is public; public tools can't be changed or deleted over MCP.`);
  }
  return tool;
}

/**
 * A Task's principalId is the caller who triggered it, not the underlying
 * agent's owner — a public agent's runs are still private to whoever
 * triggered them. No canRead/null=public path exists here on purpose.
 */
export async function requireOwnedTask(db: PrismaClient, taskId: string, principalId: string) {
  const task = await db.task.findUnique({ where: { id: taskId } });
  // 404, not 403: confirming a taskId exists at all to a non-owner is
  // itself a small information leak — same reasoning as agent reads.
  if (!task || !isOwner(task.principalId, principalId)) {
    throw new McpError(404, `Task "${taskId}" not found.`);
  }
  return task;
}
