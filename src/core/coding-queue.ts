/**
 * The coding concurrency queue's driver. claimProvisioning (container.ts)
 * refuses a slot and sets CodingRun.queuedAt when CODING_MAX_CONCURRENT
 * coding runs already hold one; this module later:
 *
 *  1. fails queued runs that waited longer than CODING_QUEUE_TIMEOUT_SEC
 *     (coding_queue_timeout), with a conditional update so concurrent
 *     drains never double-fail a run;
 *  2. starts the oldest queued runs, at most as many as there are free
 *     slots, so order stays FIFO in practice. Starting is fire-and-forget,
 *     like dispatchRun: Executor.start resolves only when the run ends.
 *     A run that loses a slot race is simply re-queued by claimProvisioning.
 *
 * Called on the scheduler leader's tick and immediately in any process
 * whose coding run just finished (ContainerExecutor onSlotReleased).
 */
import type { PrismaClient } from "@prisma/client";
import type { Executor } from "../providers/executor/types.js";
import { markRunFailedFromExecutorError } from "./dispatch.js";
import { logger } from "./logger.js";

const queueLog = logger.child({ module: "coding-queue" });

export const CODING_QUEUE_TIMEOUT_ERROR = "coding_queue_timeout";

export type CodingQueueDb = Pick<PrismaClient, "run" | "codingRun" | "$transaction">;

export interface DrainCodingQueueOptions {
  db: CodingQueueDb;
  executor: Executor;
  maxConcurrent: number;
  queueTimeoutSec: number;
  now?: () => Date;
}

export interface DrainCodingQueueResult {
  timedOut: number;
  started: string[];
}

export async function drainCodingQueue(options: DrainCodingQueueOptions): Promise<DrainCodingQueueResult> {
  const { db, executor } = options;
  const now = options.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - options.queueTimeoutSec * 1000);

  let timedOut = 0;
  const expired = await db.codingRun.findMany({
    where: { queuedAt: { lt: cutoff }, run: { status: "pending" } },
    select: { runId: true },
  });
  for (const { runId } of expired) {
    // Both writes commit together: a run is only ever observed with
    // status=failed/error=coding_queue_timeout and no matching
    // failureCategory, never one without the other.
    const didTimeOut = await db.$transaction(async (tx) => {
      const failed = await tx.run.updateMany({
        where: { id: runId, status: "pending" },
        data: { status: "failed", error: CODING_QUEUE_TIMEOUT_ERROR, finishedAt: now },
      });
      if (failed.count !== 1) return false;
      await tx.codingRun.update({ where: { runId }, data: { failureCategory: CODING_QUEUE_TIMEOUT_ERROR } });
      return true;
    });
    if (didTimeOut) timedOut += 1;
  }

  const active = await db.codingRun.count({
    where: { jobBackend: { not: null }, run: { status: { in: ["pending", "running"] } } },
  });
  const free = options.maxConcurrent - active;
  if (free <= 0) return { timedOut, started: [] };

  const next = await db.codingRun.findMany({
    where: { queuedAt: { not: null }, jobBackend: null, run: { status: "pending" } },
    // runId breaks queuedAt ties, matching claimProvisioning's queue order.
    orderBy: [{ queuedAt: "asc" }, { runId: "asc" }],
    take: free,
    select: { runId: true },
  });
  for (const { runId } of next) {
    // Promise.resolve().then(...) defers executor.start's call itself into
    // the microtask queue, so even a synchronous throw from a misbehaving
    // Executor implementation lands in this .catch instead of escaping
    // drainCodingQueue's own call stack.
    void Promise.resolve()
      .then(() => executor.start(runId))
      .catch((err) =>
        markRunFailedFromExecutorError(db, runId, err).catch((err2) =>
          queueLog.error({ err: err2, runId }, "failed to persist queued-run start failure"),
        ),
      );
  }
  return { timedOut, started: next.map((row) => row.runId) };
}
