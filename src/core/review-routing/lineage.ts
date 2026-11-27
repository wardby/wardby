/**
 * Which router a piece of work belongs to (#646, spec §2–3.3): the nearest run at or above a run, through
 * Run.parentRunId, whose agent is a router; for a review action, the document's recorded router, else its
 * writer's reviewRouter, either only while that agent is still a router. Ids only; nothing is logged.
 */
import type { PrismaClient } from "#prisma";

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
): Promise<string | null> {
  if (!agentId) return null;
  const row = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, router: true } });
  return row?.router ? row.id : null;
}

/** Turning `router` off stops routing to an agent; whether it can be run is checked when its run starts. */
export async function resolveRouter(
  db: Pick<PrismaClient, "agent">,
  target: { routerAgentId: string | null; writerAgentId: string | null },
): Promise<string | null> {
  const recorded = await stillRouter(db, target.routerAgentId);
  if (recorded) return recorded;
  if (!target.writerAgentId) return null;
  const writer = await db.agent.findUnique({ where: { id: target.writerAgentId }, select: { reviewRouterId: true } });
  return stillRouter(db, writer?.reviewRouterId);
}
