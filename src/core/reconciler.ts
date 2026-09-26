/**
 * Orphan recovery: an executor-managed run whose process died mid-execution
 * stops beating `Run.heartbeatAt` (or never got a chance to create the
 * `Run` at all). Any instance (not gated by the scheduler lease — recovery
 * shouldn't wait on leadership) periodically transitions such runs to a
 * terminal `lost` state.
 *
 * Scoped by `executionManaged`, not trigger. Scheduled, MCP, and webhook
 * runs are detached and managed; an attended `wardby run` is not. Coding
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
 *    Queued coding runs (`CodingRun.queuedAt` set) are excluded; the coding
 *    queue owns their timeout.
 *
 * The conditional `updateMany` (`WHERE ... AND status IN (...) AND ...`) is
 * what makes two concurrent reconcilers safe: whichever transaction's
 * UPDATE commits first flips the row out of the matched status, so the
 * second one's WHERE simply matches zero rows — double-reconcile is a
 * no-op, not a race.
 *
 * Each pass also completes review-host checks left "in progress" by a run
 * that ended without reaching `executeRun`'s own finalizer (reaped here as
 * `lost`, failed to start, failed while loading, ...). One sweep covers all
 * of those paths instead of patching each. Mention status comments get the
 * same sweep: it also catches a run that ended before its comment was posted.
 */

import type { Prisma, PrismaClient } from "#prisma";
import type { Executor } from "../providers/executor/types.js";
import type { ReviewHostProvider, ReviewHostRegistry } from "../providers/review-host/types.js";
import { HEARTBEAT_TIMEOUT_MS, RECONCILE_INTERVAL_MS } from "./timing.js";
import { prisma as defaultDb } from "./db.js";
import { logger } from "./logger.js";
import { closeOpenHostCheck } from "./review-host-checks.js";
import { completeHostStatus } from "./host-status.js";

const reconcilerLog = logger.child({ module: "reconciler" });

export type ReconcilerDb = Pick<PrismaClient, "run" | "runHostCheck" | "runHostStatus">;

/**
 * How long after a run finishes before its still-open check counts as
 * orphaned: long enough that the sweep never races `executeRun`'s own
 * `closeOpenHostCheck` for a run that just ended.
 */
export const ORPHANED_CHECK_GRACE_MS = 60_000;
/** Upper bound on checks completed per pass, so a backlog drains over several passes. */
export const ORPHANED_CHECK_BATCH = 50;
/** How long after a run finishes the sweep keeps trying to complete its check. */
export const ORPHANED_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Completes (neutral) open host checks whose run reached a terminal status
 * at least ORPHANED_CHECK_GRACE_MS and at most ORPHANED_CHECK_MAX_AGE_MS
 * ago. Newest-finished first, so old checks the host keeps refusing cannot
 * starve newer ones. A check the host still refuses after the max age (the
 * check was deleted, the App was uninstalled, ...) is left as it is rather
 * than retried forever; its Re-run button still works. Never queries when
 * no host is configured. `closeOpenHostCheck` is best-effort and never throws.
 */
export async function closeOrphanedHostChecks(
  db: Pick<PrismaClient, "runHostCheck">,
  hosts: ReviewHostRegistry | undefined,
  now: Date = new Date(),
): Promise<void> {
  const providers = Object.keys(hosts ?? {}) as ReviewHostProvider[];
  if (!hosts || providers.length === 0) return;
  const orphans = await db.runHostCheck.findMany({
    where: {
      completedAt: null,
      // A check for a provider that isn't configured could never be completed; keep it out of the batch.
      provider: { in: providers },
      run: {
        status: { notIn: ["pending", "running"] },
        finishedAt: {
          lte: new Date(now.getTime() - ORPHANED_CHECK_GRACE_MS),
          gte: new Date(now.getTime() - ORPHANED_CHECK_MAX_AGE_MS),
        },
      },
    },
    select: { run: { select: { id: true, status: true } } },
    orderBy: { run: { finishedAt: "desc" } },
    take: ORPHANED_CHECK_BATCH,
  });
  for (const { run } of orphans) await closeOpenHostCheck(db, run, hosts);
}

/**
 * Completes open mention status comments on the same terms as
 * closeOrphanedHostChecks: the run ended between ORPHANED_CHECK_GRACE_MS and
 * ORPHANED_CHECK_MAX_AGE_MS ago, newest first, at most ORPHANED_CHECK_BATCH per
 * pass. `completeHostStatus` is best-effort and never throws.
 */
export async function closeOrphanedHostStatuses(
  db: Pick<PrismaClient, "runHostStatus" | "run">,
  hosts: ReviewHostRegistry | undefined,
  now: Date = new Date(),
): Promise<void> {
  const providers = Object.keys(hosts ?? {}) as ReviewHostProvider[];
  if (!hosts || providers.length === 0) return;
  const orphans = await db.runHostStatus.findMany({
    where: {
      completedAt: null,
      provider: { in: providers },
      run: {
        status: { notIn: ["pending", "running"] },
        finishedAt: {
          lte: new Date(now.getTime() - ORPHANED_CHECK_GRACE_MS),
          gte: new Date(now.getTime() - ORPHANED_CHECK_MAX_AGE_MS),
        },
      },
    },
    select: { run: { select: { id: true, status: true, finalText: true } } },
    orderBy: { run: { finishedAt: "desc" } },
    take: ORPHANED_CHECK_BATCH,
  });
  for (const { run } of orphans) await completeHostStatus(db, run, hosts);
}

/** Runs one reconciliation pass. Returns the number of runs marked `lost`. */
export async function reconcileOnce(
  db: ReconcilerDb,
  now: Date = new Date(),
  heartbeatTimeoutMs: number = HEARTBEAT_TIMEOUT_MS,
  executor?: Executor,
  reviewHosts?: ReviewHostRegistry,
): Promise<number> {
  const cutoff = new Date(now.getTime() - heartbeatTimeoutMs);
  const stale = {
    executionManaged: true,
    OR: [
      {
        status: "running" as const,
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }],
      },
      {
        status: "pending" as const,
        startedAt: { lt: cutoff },
        // A coding run waiting for a concurrency slot is pending by design;
        // drainCodingQueue times those out (coding_queue_timeout) instead.
        OR: [{ codingRun: { is: null } }, { codingRun: { is: { queuedAt: null } } }],
      },
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
      // Claim before asking. For a `running` row this is a real CAS: the
      // winner's UPDATE refreshes heartbeatAt, which takes the row out of
      // the stale set, so a concurrent reconciler's WHERE matches zero rows
      // and only one instance calls recover() this pass.
      //
      // For a `pending` row it de-duplicates nothing across passes: `pending`
      // is matched on startedAt, not heartbeatAt, so the row stays stale and
      // every later pass calls recover() again. That is accepted rather than
      // fixed: DBOS's dequeue is atomic and `resumeWorkflow` is idempotent
      // (re-enqueueing an already-enqueued workflow does not run it twice),
      // and DbosExecutor bounds the repeats — after MAX_RESUME_ATTEMPTS
      // adoptions of one run it reports `lost` and the run gets reaped.
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
  await closeOrphanedHostChecks(db, reviewHosts, now);
  await closeOrphanedHostStatuses(db, reviewHosts, now);
  return lost;
}

export interface ReconcilerOptions {
  db?: ReconcilerDb;
  intervalMs?: number;
  heartbeatTimeoutMs?: number;
  executor?: Executor;
  /** Hosts used to complete checks orphaned by runs that ended abnormally; none configured = no sweep. */
  reviewHosts?: ReviewHostRegistry;
}

export interface ReconcilerHandle {
  stop(): void;
}

export function startReconciler(options: ReconcilerOptions = {}): ReconcilerHandle {
  const db = options.db ?? defaultDb;
  const intervalMs = options.intervalMs ?? RECONCILE_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  const timer = setInterval(() => {
    reconcileOnce(db, new Date(), heartbeatTimeoutMs, options.executor, options.reviewHosts).catch((err) => {
      reconcilerLog.error({ err }, "reconcile pass failed");
    });
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
