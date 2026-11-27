/**
 * Review jobs (#646, spec §2, §3.4–3.5, §4): one per review action that reached a router (the event id is the
 * claim); a job for an agent's own action points at the person's job it continues (rootJobId). Ids only.
 */
import { Prisma, type PrismaClient } from "#prisma";

const MAX_DEPTH = 32;

export interface JobRef {
  id: string;
  routerAgentId: string;
  rootJobId: string | null;
}

/** Claims the job for a review event: null when the event already has one (a repeated click, a retried hook). */
export async function claimJob(
  db: Pick<PrismaClient, "reviewJob">,
  input: {
    reviewEventId: string;
    documentId: string | null;
    setId: string | null;
    routerAgentId: string;
    startedById: string | null;
    rootJobId: string | null;
  },
): Promise<{ id: string } | null> {
  try {
    return await db.reviewJob.create({ data: input, select: { id: true } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
}

/** The job a run belongs to: the one whose router run is this run or the nearest run above it. */
export async function jobForRun(db: Pick<PrismaClient, "run" | "reviewJob">, runId: string): Promise<JobRef | null> {
  let id: string | null = runId;
  for (let i = 0; id && i < MAX_DEPTH; i++) {
    const job = await db.reviewJob.findFirst({
      where: { routerRunId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true, routerAgentId: true, rootJobId: true },
    });
    if (job) return job;
    const row: { parentRunId: string | null } | null = await db.run.findUnique({
      where: { id },
      select: { parentRunId: true },
    });
    id = row?.parentRunId ?? null;
  }
  return null;
}

/** The job an agent's own action continues; null for a person's (or guest's) action. */
export async function continuedJob(
  db: Pick<PrismaClient, "run" | "reviewJob" | "documentReviewEvent">,
  reviewEventId: string,
): Promise<JobRef | null> {
  const event = await db.documentReviewEvent.findUnique({ where: { id: reviewEventId }, select: { actorRunId: true } });
  return event?.actorRunId ? jobForRun(db, event.actorRunId) : null;
}
