/**
 * Which router a piece of work belongs to (#646, spec §2–3.3): the nearest run at or above a run, through
 * Run.parentRunId, whose agent is a router; for a review action, the document's recorded router, else its
 * writer's reviewRouter, either only while that agent is still a router its person can run. Ids only; nothing is
 * logged.
 */
import type { PrismaClient } from "#prisma";
import { canExecute, type DocumentDb } from "../documents/access.js";

const MAX_DEPTH = 32;

export async function routerForRun(db: Pick<PrismaClient, "run">, runId: string | null): Promise<string | null> {
  let id = runId;
  for (let i = 0; id && i < MAX_DEPTH; i++) {
    const row = await db.run.findUnique({
      where: { id },
      select: { parentRunId: true, agent: { select: { id: true, router: true } } },
    });
    if (!row) return null;
    if (row.agent.router) return row.agent.id;
    id = row.parentRunId;
  }
  return null;
}

async function stillRouter(
  db: Pick<PrismaClient, "agent">,
  agentId: string | null | undefined,
): Promise<{ id: string; ownerId: string | null } | null> {
  if (!agentId) return null;
  const row = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, ownerId: true, router: true } });
  return row?.router ? { id: row.id, ownerId: row.ownerId } : null;
}

/** Who can execute `router` among the given principal; no principal: nobody. */
async function runnableBy(db: DocumentDb, router: { id: string; ownerId: string | null }, principalId: string | null) {
  return principalId !== null && canExecute(db, router, principalId);
}

/**
 * The router a review action reaches, re-checked at route time (spec §2): the document's (or set's) recorded
 * router, else its writer's reviewRouter, each only while that agent is still a router and still runnable by the
 * person it acts for. A recorded router the document's run tree wrote (`routerForRun(recordedByRunId)`) needs
 * nothing more; one the owner set (link_document) needs the owner's execute; a writer's reviewRouter needs its
 * owner's execute. A source that fails is treated as none, so the next one applies.
 */
export async function resolveRouter(
  db: DocumentDb,
  target: {
    routerAgentId: string | null;
    writerAgentId: string | null;
    /** The document's (or set's) owner. */
    ownerId: string | null;
    /** The run that created the document (its version 1) or the set; null when none did. */
    recordedByRunId: string | null;
  },
): Promise<string | null> {
  const recorded = await stillRouter(db, target.routerAgentId);
  if (
    recorded &&
    ((await runnableBy(db, recorded, target.ownerId)) ||
      (target.recordedByRunId !== null && (await routerForRun(db, target.recordedByRunId)) === recorded.id))
  ) {
    return recorded.id;
  }
  if (!target.writerAgentId) return null;
  const writer = await db.agent.findUnique({
    where: { id: target.writerAgentId },
    select: { reviewRouterId: true, ownerId: true },
  });
  const fallback = await stillRouter(db, writer?.reviewRouterId);
  return fallback && (await runnableBy(db, fallback, writer?.ownerId ?? null)) ? fallback.id : null;
}
