/**
 * Orphan recovery: an executor-managed run whose process died mid-execution
 * stops beating `Run.heartbeatAt` (or never got a chance to create the
 * `Run` at all). Any instance (not gated by the scheduler lease — recovery
 * shouldn't wait on leadership) periodically transitions such runs to a
 * terminal `lost` state.
 *
 * Scoped by `executionManaged`, not trigger. Scheduled, MCP, and webhook
 * runs are detached and managed; an attended `reevo run` is not. Coding
 * jobs with persisted handles are delegated to the executor's recovery
 * path, which must query/stop/collect and must never relaunch.
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

import type { Prisma, PrismaClient } from "@prisma/client";
import type { Executor } from "../providers/executor/types.js";
import { HEARTBEAT_TIMEOUT_MS, RECONCILE_INTERVAL_MS } from "./timing.js";
import { prisma as defaultDb } from "./db.js";
import { logger } from "./logger.js";

const reconcilerLog = logger.child({ module: "reconciler" });

export type ReconcilerDb = Pick<PrismaClient, "run">;

/** Runs one reconciliation pass. Returns the number of runs marked `lost`. */
export async function reconcileOnce(
  db: ReconcilerDb,
  now: Date = new Date(),
  heartbeatTimeoutMs: number = HEARTBEAT_TIMEOUT_MS,
  executor?: Executor,
): Promise<number> {
  const cutoff = new Date(now.getTime() - heartbeatTimeoutMs);
  const stale = {
    executionManaged: true,
    OR: [
      {
        status: "running" as const,
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }],
      },
      { status: "pending" as const, startedAt: { lt: cutoff } },
    ],
  } satisfies Prisma.RunWhereInput;
  const candidates = await db.run.findMany({
    where: stale,
    include: {
      agent: { select: { kind: true } },
      codingRun: { select: { jobBackend: true, jobHandle: true } },
    },
  });

  let lost = 0;
  for (const run of candidates) {
    let reason = `Orphaned: no heartbeat/progress since before ${cutoff.toISOString()}.`;
    if (run.agent.kind === "coding" && run.codingRun?.jobHandle) {
      if (!executor?.recover || !run.codingRun.jobBackend) continue;
      let recovered;
      try {
        recovered = await executor.recover({
          runId: run.id,
          backend: run.codingRun.jobBackend,
          id: run.codingRun.jobHandle,
        });
      } catch (err) {
        reconcilerLog.error({ err, runId: run.id }, "managed run recovery failed");
        continue;
      }
      if (recovered.state === "active") {
        await db.run.updateMany({
          where: { id: run.id, executionManaged: true, status: { in: ["pending", "running"] } },
          data: { heartbeatAt: now },
        });
        continue;
      }
      if (recovered.state === "terminal") continue;
      reason = recovered.reason ?? "Managed coding job was lost after stop and collection attempts.";
    } else if (run.agent.kind === "coding") {
      reason = "Managed coding job became stale before its launcher handle was persisted; it was not relaunched.";
    } else if (run.executionBackend && executor?.recover) {
      // Claim before asking, so two reconciler instances can't both adopt
      // the same orphaned workflow: whichever CAS wins refreshes the
      // heartbeat and takes the run out of the stale set for the other.
      const claimed = await db.run.updateMany({
        where: { id: run.id, ...stale },
        data: { heartbeatAt: now },
      });
      if (claimed.count === 0) continue;
      let recovered;
      try {
        recovered = await executor.recover({ runId: run.id, backend: run.executionBackend, id: run.id });
      } catch (err) {
        reconcilerLog.error({ err, runId: run.id }, "durable run recovery failed");
        continue;
      }
      if (recovered.state === "active" || recovered.state === "terminal") continue;
      reason = recovered.reason ?? "Durable backend reported the run lost.";
      const result = await db.run.updateMany({
        where: { id: run.id, executionManaged: true, status: { in: ["pending", "running"] } },
        data: { status: "lost", error: reason, finishedAt: now },
      });
      lost += result.count;
      continue;
    }

    const result = await db.run.updateMany({
      where: { id: run.id, ...stale },
      data: { status: "lost", error: reason, finishedAt: now },
    });
    lost += result.count;
  }
  return lost;
}

export interface ReconcilerOptions {
  db?: ReconcilerDb;
  intervalMs?: number;
  heartbeatTimeoutMs?: number;
  executor?: Executor;
}

export interface ReconcilerHandle {
  stop(): void;
}

export function startReconciler(options: ReconcilerOptions = {}): ReconcilerHandle {
  const db = options.db ?? defaultDb;
  const intervalMs = options.intervalMs ?? RECONCILE_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  const timer = setInterval(() => {
    reconcileOnce(db, new Date(), heartbeatTimeoutMs, options.executor).catch((err) => {
      reconcilerLog.error({ err }, "reconcile pass failed");
    });
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
