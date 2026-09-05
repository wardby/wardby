/**
 * Orphan recovery: an executor-managed run whose process died mid-execution
 * stops beating `Run.heartbeatAt` (or never got a chance to create the
 * `Run` at all). Any instance (not gated by the scheduler lease — recovery
 * shouldn't wait on leadership) periodically transitions such runs to a
 * terminal `lost` state.
 *
 * Scoped to `trigger: "scheduled"` only. An attended `reevo run` (trigger
 * "manual") intentionally has no heartbeat — nothing is watching it but the
 * human running it — so treating a plain `heartbeatAt IS NULL` as orphaned
 * would reap any manual run that simply streams for longer than
 * `HEARTBEAT_TIMEOUT`. That's the bug this scoping fixes: without it, a
 * long-running `reevo run` gets flipped to `lost` out from under a human
 * still watching it complete.
 *
 * Two states get reclaimed:
 *  - `running` past the heartbeat timeout (the executor died mid-run). The
 *    `heartbeatAt IS NULL` arm is a defensive fallback for a future
 *    executor that doesn't beat before flipping to `running` —
 *    `InProcessExecutor` always beats first, so a live scheduled run is
 *    never actually in `running` with a null heartbeat.
 *  - `pending` past the timeout (the process died between `claimDueRun`
 *    committing the `Run` and the executor ever starting it — or the
 *    executor's `start()` call itself failed before persisting anything).
 *
 * The conditional `updateMany` (`WHERE ... AND status IN (...) AND ...`) is
 * what makes two concurrent reconcilers safe: whichever transaction's
 * UPDATE commits first flips the row out of the matched status, so the
 * second one's WHERE simply matches zero rows — double-reconcile is a
 * no-op, not a race.
 */

import type { PrismaClient } from "@prisma/client";
import { HEARTBEAT_TIMEOUT_MS, RECONCILE_INTERVAL_MS } from "./timing.js";
import { prisma as defaultDb } from "./db.js";

export type ReconcilerDb = Pick<PrismaClient, "run">;

/** Runs one reconciliation pass. Returns the number of runs marked `lost`. */
export async function reconcileOnce(
  db: ReconcilerDb,
  now: Date = new Date(),
  heartbeatTimeoutMs: number = HEARTBEAT_TIMEOUT_MS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - heartbeatTimeoutMs);
  const result = await db.run.updateMany({
    where: {
      trigger: "scheduled",
      OR: [
        {
          status: "running",
          OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }],
        },
        { status: "pending", startedAt: { lt: cutoff } },
      ],
    },
    data: {
      status: "lost",
      error: `Orphaned: no heartbeat/progress since before ${cutoff.toISOString()}.`,
      finishedAt: now,
    },
  });
  return result.count;
}

export interface ReconcilerOptions {
  db?: ReconcilerDb;
  intervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface ReconcilerHandle {
  stop(): void;
}

export function startReconciler(options: ReconcilerOptions = {}): ReconcilerHandle {
  const db = options.db ?? defaultDb;
  const intervalMs = options.intervalMs ?? RECONCILE_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  const timer = setInterval(() => {
    reconcileOnce(db, new Date(), heartbeatTimeoutMs).catch((err) => {
      console.error("[reconciler] error:", err);
    });
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
