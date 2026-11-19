/**
 * The outbox for chores that follow a run's terminal status (stopping child runs, notifications, a PR
 * comment). A caller used to write the status and then do the chores in memory in the same process;
 * a crash between the two lost them for good, because the reconciler only looks at runs that are
 * still pending or running. Now the caller enqueues the chore in the same transaction as the status
 * (`enqueueRunFollowUp`), and the scheduler leader drains the due rows (`drainRunFollowUps`).
 *
 * Rules:
 * - One row per (run, kind): enqueueing twice is a no-op.
 * - A claim is one statement under `FOR UPDATE SKIP LOCKED` that also pushes `nextAttemptAt` out by
 *   CLAIM_TTL_MS, so two replicas never run the same row at once, even if leadership overlaps. A
 *   process that dies mid-handler leaves a row that comes due again after the TTL.
 * - A handler can therefore run more than once (a crash after its work, before the row is marked
 *   done): handlers must be idempotent.
 * - A failing handler backs off exponentially and keeps being retried; it never blocks the rows
 *   after it. A handler still running after HANDLER_TIMEOUT_MS is abandoned and counts as a failure.
 * - A row with no registered handler fails and backs off the same way, so a rolled-back deploy
 *   neither loses nor spins on it.
 * - Secrets: a payload holds ids, never content, and is capped in size. Only an error's name is
 *   stored or logged, never its message, which could carry a secret.
 */
import type { Prisma, PrismaClient } from "#prisma";
import { logger } from "./logger.js";

const log = logger.child({ module: "run-follow-ups" });

/** How long a claim keeps other replicas off a row. Longer than HANDLER_TIMEOUT_MS. */
export const CLAIM_TTL_MS = 5 * 60_000;
/** A handler still running after this long is abandoned. */
export const HANDLER_TIMEOUT_MS = 2 * 60_000;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
/** Rows claimed per pass; the rest wait for the next one. */
const DRAIN_BATCH = 20;
/** A payload names a run's chore by ids; a bigger one is most likely content. */
export const MAX_PAYLOAD_BYTES = 2048;

/** How long a failed row waits before its next attempt: 5s, 10s, 20s ... capped at 10 minutes. */
export function followUpBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

export interface RunFollowUpInput {
  runId: string;
  /** Names the handler that does the chore. */
  kind: string;
  /** Ids the handler needs. Never content or secret values. */
  payload?: Prisma.InputJsonObject;
  /**
   * The row is not drained before this. For a caller that does the chore itself right after the commit
   * and marks the row done (`completeRunFollowUp`): the drain then only picks it up when that caller died.
   */
  notBefore?: Date;
}

/**
 * Queues a chore for a run. Call it with the transaction client of the status write, so the chore
 * exists exactly when the status does.
 */
export async function enqueueRunFollowUp(
  tx: Pick<Prisma.TransactionClient, "runFollowUp">,
  input: RunFollowUpInput,
): Promise<void> {
  const payload = input.payload ?? {};
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    throw new Error(`A run follow-up payload is limited to ${MAX_PAYLOAD_BYTES} bytes: pass ids, not content.`);
  }
  await tx.runFollowUp.createMany({
    data: [
      {
        runId: input.runId,
        kind: input.kind,
        payload,
        ...(input.notBefore ? { nextAttemptAt: input.notBefore } : {}),
      },
    ],
    skipDuplicates: true,
  });
}

/** Marks a run's chore done, for a caller that did it itself. A chore already done or never queued is a no-op. */
export async function completeRunFollowUp(
  db: Pick<PrismaClient, "runFollowUp">,
  runId: string,
  kind: string,
): Promise<void> {
  await db.runFollowUp.updateMany({
    where: { runId, kind, doneAt: null },
    data: { doneAt: new Date(), lastError: null },
  });
}

export interface RunFollowUpContext {
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
  /** 1 on the first try. */
  attempt: number;
  /** Aborts when the handler is abandoned for running too long: pass it to anything that can cancel. */
  signal: AbortSignal;
}

/** Does one chore. Must be idempotent, and must not put secret values in what it throws. */
export type RunFollowUpHandler = (context: RunFollowUpContext) => Promise<void>;
export type RunFollowUpHandlers = Record<string, RunFollowUpHandler>;

/** Where a drain reports (metrics). Neither method may throw; if one does, it is ignored. */
export interface RunFollowUpObserver {
  runFollowUpResult(outcome: "done" | "failed"): void;
  /** After each pass: chores not yet done, and the age in seconds of the oldest. */
  runFollowUpBacklog(stats: { pending: number; oldestAgeSeconds: number }): void;
}

export type RunFollowUpDb = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

export interface DrainRunFollowUpsOptions {
  db: RunFollowUpDb;
  handlers: RunFollowUpHandlers;
  observer?: RunFollowUpObserver;
  batch?: number;
  /** Overridable for tests. */
  handlerTimeoutMs?: number;
}

interface ClaimedRow {
  id: string;
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

class FollowUpTimeout extends Error {
  override readonly name = "FollowUpTimeout";
}

class UnknownFollowUpKind extends Error {
  override readonly name = "UnknownFollowUpKind";
}

/** An error's name, the only part of it that is stored or logged: its message could carry a secret. */
export function errorName(error: unknown): string {
  return (error instanceof Error ? error.name : "UnknownError").slice(0, 100);
}

async function runWithTimeout(handler: RunFollowUpHandler, context: Omit<RunFollowUpContext, "signal">, ms: number) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FollowUpTimeout());
    }, ms);
    timer.unref();
  });
  try {
    await Promise.race([handler({ ...context, signal: controller.signal }), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function notify(call: () => void): void {
  try {
    call();
  } catch {
    // A throwing metrics hook must not break the drain.
  }
}

/**
 * One pass: claims the due rows, runs each one's handler, and marks it done or backs it off. Run it
 * on the scheduler leader. Returns how many rows finished and how many failed.
 */
export async function drainRunFollowUps(options: DrainRunFollowUpsOptions): Promise<{ done: number; failed: number }> {
  const { db, handlers, observer } = options;
  const timeoutMs = options.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS;
  const claimed = await db.$queryRaw<ClaimedRow[]>`
    UPDATE "RunFollowUp"
    SET "attempts" = "attempts" + 1,
        "nextAttemptAt" = CURRENT_TIMESTAMP + ${CLAIM_TTL_MS}::double precision * interval '1 millisecond'
    WHERE "id" IN (
      SELECT "id" FROM "RunFollowUp"
      WHERE "doneAt" IS NULL AND "nextAttemptAt" <= CURRENT_TIMESTAMP
      ORDER BY "nextAttemptAt"
      LIMIT ${options.batch ?? DRAIN_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "runId", "kind", "payload", "attempts"
  `;
  let done = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      const handler = handlers[row.kind];
      if (!handler) throw new UnknownFollowUpKind();
      await runWithTimeout(
        handler,
        { runId: row.runId, kind: row.kind, payload: row.payload, attempt: row.attempts },
        timeoutMs,
      );
      await db.$executeRaw`
        UPDATE "RunFollowUp" SET "doneAt" = CURRENT_TIMESTAMP, "lastError" = NULL
        WHERE "id" = ${row.id} AND "doneAt" IS NULL
      `;
      done += 1;
      notify(() => observer?.runFollowUpResult("done"));
    } catch (error) {
      failed += 1;
      notify(() => observer?.runFollowUpResult("failed"));
      // The name only: a message could carry a secret.
      log.warn(
        {
          event: "run_follow_up.failed",
          runId: row.runId,
          kind: row.kind,
          attempt: row.attempts,
          error: errorName(error),
        },
        "run follow-up failed; it will be retried",
      );
      await db.$executeRaw`
          UPDATE "RunFollowUp"
          SET "nextAttemptAt" = CURRENT_TIMESTAMP + ${followUpBackoffMs(row.attempts)}::double precision * interval '1 millisecond',
              "lastError" = ${errorName(error)}
          WHERE "id" = ${row.id} AND "doneAt" IS NULL
        `.catch((writeError: unknown) =>
        // The claim already pushed the row out, so it still comes due once the TTL passes.
        log.warn(
          { event: "run_follow_up.backoff_not_saved", error: errorName(writeError) },
          "could not save the backoff",
        ),
      );
    }
  }
  if (observer) {
    const [stats] = await db.$queryRaw<{ pending: number; oldestAgeSeconds: number }[]>`
      SELECT COUNT(*)::int AS "pending",
             COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("createdAt"))), 0)::float8 AS "oldestAgeSeconds"
      FROM "RunFollowUp" WHERE "doneAt" IS NULL
    `;
    if (stats) notify(() => observer.runFollowUpBacklog(stats));
  }
  return { done, failed };
}
