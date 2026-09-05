/**
 * Orphan recovery: a run whose executor died mid-execution stops beating
 * `Run.heartbeatAt`. Any instance (not gated by the scheduler lease —
 * recovery shouldn't wait on leadership) periodically transitions runs
 * stuck `running` past `HEARTBEAT_TIMEOUT` to a terminal `lost` state.
 *
 * The conditional `updateMany` (`WHERE status = 'running' AND ...`) is what
 * makes two concurrent reconcilers safe: whichever transaction's UPDATE
 * commits first flips the row out of `running`, so the second one's WHERE
 * simply matches zero rows — double-reconcile is a no-op, not a race.
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
      status: "running",
      OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }],
    },
    data: {
      status: "lost",
      error: `Orphaned: no heartbeat since before ${cutoff.toISOString()}.`,
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
