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
 *    queue owns their timeout. A native run in that state has not started:
 *    no execution backend holds it, so no step ran. It is restarted through
 *    the executor (a start on a started run attaches), at most
 *    MAX_START_RESTARTS times, and only then marked `lost`.
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
 * of those paths instead of patching each. Mention status comments, and the
 * status comments of runs started by Jira issue events, get the same sweep:
 * it also catches a run that ended before its comment was posted.
 *
 * Given host-event deps, each pass also starts reviews deferred until CI
 * finished (waitForCi links) whose CI has not finished in time, releases
 * reviews that waited for a delegating run that ended without its finalizer
 * (lost, including leads this pass just marked lost), and drops deferred
 * reviews that are too old (host-events.ts startDeferredReviews).
 *
 * Given document deps, each pass also answers comment threads sent to runs
 * that ended without an answer: lost (including runs this pass marked lost),
 * failed to start, or whose completion hook never ran
 * (documents/agent-loop.ts sweepUnansweredDocumentRuns; claimed once per run),
 * and deletes expired document-page sessions and rate-limit windows
 * (documents/sweep.ts).
 */

import type { Prisma, PrismaClient } from "#prisma";
import type { Executor } from "../providers/executor/types.js";
import type { ReviewHostProvider, ReviewHostRegistry } from "../providers/review-host/types.js";
import type { IssueTrackerRegistry } from "../providers/issue-tracker/types.js";
import { startInterval } from "./interval.js";
import { HEARTBEAT_TIMEOUT_MS, LOOP_TICK_TIMEOUT_MS, RECONCILE_INTERVAL_MS } from "./timing.js";
import { prisma as defaultDb } from "./db.js";
import { logger } from "./logger.js";
import { closeOpenHostCheck } from "./review-host-checks.js";
import { completeHostStatus, type HostStatusDb } from "./host-status.js";
import { closeOrphanedIssueStatuses } from "./issue-status.js";
import { enqueueLostRunFollowUps } from "./run-follow-up-handlers.js";
import { syncOpenPullRequestStates } from "./pull-request-state-sync.js";
import { sweepMergeOrderChecks } from "./merge-order-check.js";
import { startDeferredReviews, type ReviewStartDeps } from "./host-events.js";
import { markRunFailedFromExecutorError } from "./dispatch.js";
import { sweepUnansweredDocumentRuns, type DocumentSweepDeps } from "./documents/agent-loop.js";
import { sweepExpiredDocumentRows } from "./documents/sweep.js";

const reconcilerLog = logger.child({ module: "reconciler" });
/**
 * How many times a pending run with no execution backend is restarted (nothing had run it)
 * before the reconciler gives up and marks it `lost`.
 */
export const MAX_START_RESTARTS = 3;

export type ReconcilerDb = Pick<
  PrismaClient,
  | "run"
  | "codingRunRepository"
  | "runHook"
  | "runHostCheck"
  | "runBudgetEvent"
  | "runHostStatus"
  | "runIssueStatus"
  | "runFollowUp"
  | "agentIssueProject"
  | "issuePullRequest"
  | "codingRun"
  | "registryFetch"
  | "registryAuditRecord"
  | "agent"
  | "agentRepository"
  // The plan build chain, from the run-end event and the PR state sync (plans/chain-hook.ts).
  | "planSet"
  | "principal"
  | "resourceGrant"
  | "$transaction"
  | "$queryRaw"
>;

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
 * Completes (as a failure) open host checks whose run reached a terminal status
 * at least ORPHANED_CHECK_GRACE_MS and at most ORPHANED_CHECK_MAX_AGE_MS
 * ago. Newest-finished first, so old checks the host keeps refusing cannot
 * starve newer ones. A check the host still refuses after the max age (the
 * check was deleted, the App was uninstalled, ...) is left as it is rather
 * than retried forever; its Re-run button still works. Never queries when
 * no host is configured. `closeOpenHostCheck` is best-effort and never throws.
 */
export async function closeOrphanedHostChecks(
  db: Pick<PrismaClient, "runHostCheck" | "run" | "runBudgetEvent">,
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
  db: HostStatusDb,
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
  // postIfMissing: by now the dispatching instance's follow-up has had its
  // chance; a run that ended with no comment (it died first) gets one here.
  for (const { run } of orphans) await completeHostStatus(db, run, hosts, { postIfMissing: true });
}

/**
 * Marks a run lost and queues its chores (stop its children, file its self-defect, emit its finished
 * events) in the same transaction, so a pod that dies right after the write cannot lose them: the
 * scheduler leader drains them (run-follow-ups.ts). Returns 1 when this call made the row lost, else 0.
 */
async function markLost(
  db: ReconcilerDb,
  runId: string,
  where: Prisma.RunWhereInput,
  reason: string,
  now: Date,
): Promise<number> {
  return db.$transaction(async (tx) => {
    const result = await tx.run.updateMany({ where, data: { status: "lost", error: reason, finishedAt: now } });
    if (result.count > 0) await enqueueLostRunFollowUps(tx, runId);
    return result.count;
  });
}

/** Runs one reconciliation pass. Returns the number of runs marked `lost`. */
export async function reconcileOnce(
  db: ReconcilerDb,
  now: Date = new Date(),
  heartbeatTimeoutMs: number = HEARTBEAT_TIMEOUT_MS,
  executor?: Executor,
  reviewHosts?: ReviewHostRegistry,
  issueTrackers?: IssueTrackerRegistry,
  /** What starting a deferred review needs; absent = no deferred-review sweep. */
  deferredReviews?: ReviewStartDeps,
  /** What answering document comment runs needs; absent = no document sweep. */
  documentRuns?: DocumentSweepDeps,
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
    } else if (run.status === "pending" && !run.executionBackend && executor) {
      // Never started: no backend holds it and no step ran, so start it rather than lose it.
      // The claim is a compare-and-set on the attempt count, so one instance restarts it per
      // attempt and the count bounds the restarts.
      const claimed = await db.run.updateMany({
        where: { id: run.id, ...stale, executionBackend: null, startAttempts: run.startAttempts },
        data: { startAttempts: { increment: 1 }, startDeferredAt: null, startClaimedAt: null },
      });
      if (claimed.count === 0) continue;
      if (run.startAttempts < MAX_START_RESTARTS) {
        reconcilerLog.warn({ runId: run.id, attempt: run.startAttempts + 1 }, "restarting a run that never started");
        // Not awaited: an in-process executor's start runs the whole run.
        void executor
          .start(run.id)
          .catch((err: unknown) =>
            markRunFailedFromExecutorError(db, run.id, err, { db, issueTrackers }).catch((err2: unknown) =>
              reconcilerLog.error({ err: err2, runId: run.id }, "failed to persist executor start failure"),
            ),
          );
        continue;
      }
      reason = `Never started: still pending with nothing running it after ${MAX_START_RESTARTS} restarts.`;
      lost += await markLost(db, run.id, { id: run.id, executionManaged: true, status: "pending" }, reason, now);
      continue;
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
        recovered = await executor.recover({
          runId: run.id,
          backend: run.executionBackend,
          id: run.executionWorkflowId ?? run.id,
        });
      } catch (err) {
        reconcilerLog.error({ err, runId: run.id }, "durable run recovery failed");
        continue;
      }
      if (recovered.state === "active" || recovered.state === "terminal") continue;
      reason = recovered.reason ?? "Durable backend reported the run lost.";
      lost += await markLost(
        db,
        run.id,
        { id: run.id, executionManaged: true, status: { in: ["pending", "running"] } },
        reason,
        now,
      );
      continue;
    }

    // Only the pass that made the row lost queues its chores (not when another instance won the race).
    lost += await markLost(db, run.id, { id: run.id, ...stale }, reason, now);
  }
  await closeOrphanedHostChecks(db, reviewHosts, now);
  await closeOrphanedHostStatuses(db, reviewHosts, now);
  await closeOrphanedIssueStatuses(db, issueTrackers, now);
  // Settle stored pull requests whose merge/close webhook was missed; bounded per pass, never throws.
  await syncOpenPullRequestStates(db, reviewHosts, issueTrackers, now);
  // Start reviews whose head's CI never finished (waitForCi links), and reviews whose delegating run
  // ended without releasing them (after the lost marking above); bounded per pass, never throws.
  if (deferredReviews) await startDeferredReviews(deferredReviews, now);
  // Re-post `wardby merge order` checks whose pr_closed or new-head event was missed; after the
  // deferred-review start, so no review waits on it. Throttled and bounded per pass, never throws.
  await sweepMergeOrderChecks({ db, hosts: reviewHosts }, now);
  // Answer comment threads sent to runs that ended without an answer (lost, including runs this pass
  // just marked lost; failed to start; a missed completion hook). Claimed once per run; bounded, never throws.
  if (documentRuns) {
    await sweepUnansweredDocumentRuns(documentRuns, now);
    // Expired document-page sessions and rate-limit windows; never throws.
    await sweepExpiredDocumentRows(documentRuns.db, now);
  }
  return lost;
}

export interface ReconcilerOptions {
  db?: ReconcilerDb;
  intervalMs?: number;
  heartbeatTimeoutMs?: number;
  executor?: Executor;
  /** Hosts used to complete checks orphaned by runs that ended abnormally; none configured = no sweep. */
  reviewHosts?: ReviewHostRegistry;
  /** Trackers used to complete issue status comments orphaned the same way; none configured = no sweep. */
  issueTrackers?: IssueTrackerRegistry;
  /** Host-event deps for starting deferred reviews (waitForCi) whose CI never finished; absent = no sweep. */
  deferredReviews?: ReviewStartDeps;
  /** Deps for answering comment threads sent to runs that ended unanswered; absent = no sweep. */
  documentRuns?: DocumentSweepDeps;
}

export interface ReconcilerHandle {
  /** Resolves once a pass already in flight has finished or timed out; no pass starts after. */
  stop(): Promise<void>;
}

export function startReconciler(options: ReconcilerOptions = {}): ReconcilerHandle {
  const db = options.db ?? defaultDb;
  const intervalMs = options.intervalMs ?? RECONCILE_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  const loop = startInterval({
    name: "reconciler",
    everyMs: intervalMs,
    timeoutMs: LOOP_TICK_TIMEOUT_MS,
    tick: async () => {
      await reconcileOnce(
        db,
        new Date(),
        heartbeatTimeoutMs,
        options.executor,
        options.reviewHosts,
        options.issueTrackers,
        options.deferredReviews,
        options.documentRuns,
      );
    },
  });

  return { stop: () => loop.stop() };
}
