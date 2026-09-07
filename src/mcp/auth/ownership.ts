/**
 * Single seam for ownership decisions across Agent/Task (and anything else
 * that gains a nullable owner column later). A null owner means "public":
 * readable by anyone, but never a mutation target for anyone but its real
 * owner. Every tool file routes through this module instead of re-deriving
 * the null-handling itself, so adding real sharing later is a change here,
 * not an N-file sweep.
 */
import type { PrismaClient } from "@prisma/client";
import { McpError } from "../errors.js";

export function canRead(ownerId: string | null, principalId: string): boolean {
  return ownerId === null || ownerId === principalId;
}

export function isOwner(ownerId: string | null, principalId: string): boolean {
  return ownerId === principalId;
}

export function assertCanMutate(ownerId: string | null, principalId: string, notFoundMessage: string): void {
  if (!isOwner(ownerId, principalId)) throw new McpError(403, notFoundMessage);
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
  if (!secret || !isOwner(secret.ownerId, principalId)) {
    throw new McpError(403, `Secret "${id}" is not owned by the caller.`);
  }
}

export async function requireOwnedWebhook(db: PrismaClient, id: string, principalId: string): Promise<void> {
  const webhook = await db.webhook.findUnique({ where: { id } });
  if (!webhook || !isOwner(webhook.ownerId, principalId)) {
    throw new McpError(403, `Webhook "${id}" is not owned by the caller.`);
  }
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
