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
  /** The router run the job's documents were granted to (RunDocumentGrant). */
  routerRunId: string | null;
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
      select: { id: true, routerAgentId: true, rootJobId: true, routerRunId: true },
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

/** The refusal of a start past the router's maxStartsPerDecision (fixed text: never a caller's value). */
export const REVIEW_ROUTE_LIMIT_REFUSAL = JSON.stringify({
  error: "review_route_limit",
  message:
    "This decision has already started the most agents its router allows (maxStartsPerDecision). A person's next review action starts a new count.",
});

/** The refusal of a native agent without documentTools as the target of routed work. */
export const REVIEW_ROUTE_TARGET_NO_DOCUMENTS_REFUSAL = JSON.stringify({
  error: "review_route_target_no_documents",
  message:
    "This agent cannot read documents (it has no documentTools), so it cannot take work routed from a review. Give it documentTools or start another agent.",
});

/**
 * Counts one start against the decision's limit (spec §4): on the root job (`rootJobId ?? id`), atomically, only
 * while under the router's maxStartsPerDecision. Past it, the start is refused and the job records it.
 */
export async function countJobStart(
  db: Pick<PrismaClient, "reviewJob" | "$queryRaw">,
  job: JobRef,
): Promise<{ refusal: string } | null> {
  const rootId = job.rootJobId ?? job.id;
  const counted = await db.$queryRaw<{ id: string }[]>`
    UPDATE "ReviewJob" j SET "startsUsed" = j."startsUsed" + 1, "updatedAt" = now()
    FROM "Agent" a WHERE j."id" = ${rootId} AND a."id" = j."routerAgentId" AND j."startsUsed" < a."maxStartsPerDecision"
    RETURNING j."id"`;
  if (counted.length > 0) return null;
  await db.reviewJob.updateMany({ where: { id: job.id, outcome: "started" }, data: { outcome: "review_route_limit" } });
  return { refusal: REVIEW_ROUTE_LIMIT_REFUSAL };
}

/** A start from a run: null when the run belongs to no job (no limit), else as countJobStart. */
export async function countRoutedStart(
  db: Pick<PrismaClient, "run" | "reviewJob" | "$queryRaw">,
  parentRunId: string,
): Promise<{ refusal: string } | null> {
  const job = await jobForRun(db, parentRunId);
  return job ? countJobStart(db, job) : null;
}
