/**
 * Workflow notifications a run's finalizer emits: run_failed for a top-level
 * run that did not succeed, run_blocked for package refusals without changes
 * (children are summarized by their parent), packages_audited when its coding
 * children installed anything under package audit mode, and
 * review_posted when the run published a verdict on its own check. Called
 * only by the finalizer that made the run terminal. Never throws.
 */
import type { PrismaClient } from "#prisma";
import { pullRequestWebUrl } from "../coding/code-host.js";
import { packageAuditDigest } from "../coding/registry/audit-mode.js";
import { blockingRefusals, collectPackageAudit, collectRunOutcome, isBlockedByRefusals } from "./host-status.js";
import { logger } from "./logger.js";
import { dedupeKeys, emitWorkflowEvent, RUN_END_STATUSES, shortReason, type RunEndStatus } from "./workflow-events.js";

const log = logger.child({ module: "workflow-run-events" });
const FAILED = new Set(["failed", "budget_exhausted", "cancelled", "lost", "refused"]);
const VERDICTS = new Set(["APPROVE", "CHANGES_REQUESTED", "COMMENT"]);

export type RunEventsDb = Pick<
  PrismaClient,
  "agent" | "runHostCheck" | "run" | "runBudgetEvent" | "registryFetch" | "registryAuditRecord" | "runHook"
>;

export type RunCompletedDb = Pick<
  PrismaClient,
  "run" | "runHook" | "runBudgetEvent" | "registryFetch" | "registryAuditRecord"
>;

const RUN_END_STATUSES_SET = new Set<string>(RUN_END_STATUSES);

/**
 * run_completed for a finished run, for run hooks only (Slack links never
 * match it). Every terminal status of a top-level run; a child run only when
 * a hook on its agent asks for child runs. The payload is metadata: the final
 * text is read at delivery time, never stored on the event. Recorded only
 * when a hook on the agent wants it. Never throws.
 */
export async function emitRunCompletedEvent(db: RunCompletedDb, runId: string): Promise<void> {
  try {
    const run = await db.run.findUnique({
      where: { id: runId },
      select: {
        id: true,
        agentId: true,
        status: true,
        trigger: true,
        startedAt: true,
        finishedAt: true,
        costUsd: true,
        error: true,
        parentRunId: true,
        agent: { select: { name: true } },
      },
    });
    if (!run || !RUN_END_STATUSES_SET.has(run.status)) return;
    // Only run hooks take run_completed: with none on the agent that wants
    // this run, record nothing and skip the outcome reads (one count query).
    const wanting = await db.runHook.count({
      where: {
        agentId: run.agentId,
        enabled: true,
        ...(run.parentRunId ? { runs: "all" } : {}),
        OR: [{ events: { isEmpty: true } }, { events: { has: "run_completed" } }],
      },
    });
    if (wanting === 0) return;
    let pullRequests: { repository: string; number: number; url: string | null; outcome: string }[] = [];
    try {
      const outcome = await collectRunOutcome(db, { id: run.id, status: run.status, finalText: null });
      pullRequests = outcome.pullRequests.map((pr) => ({
        repository: pr.repository,
        number: pr.pullRequestNumber,
        url: pr.pullRequestUrl ?? pullRequestWebUrl(pr.codeProvider, pr.repository, pr.pullRequestNumber),
        outcome: pr.outcome,
      }));
    } catch {
      // The outcome read is best effort: the event still says how the run ended.
    }
    await emitWorkflowEvent({
      dedupeKey: dedupeKeys.runCompleted(run.id),
      runId: run.id,
      agentId: run.agentId,
      payload: {
        kind: "run_completed",
        agentName: run.agent?.name ?? run.agentId,
        status: run.status as RunEndStatus,
        trigger: String(run.trigger),
        parentRunId: run.parentRunId ?? null,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        costUsd: run.costUsd.toString(),
        reason: shortReason(run.error),
        pullRequests,
      },
    });
  } catch (err) {
    log.warn({ err, runId }, "could not emit run_completed");
  }
}

/** Emits top-level run outcomes and published review verdicts. Never throws. */
export async function emitRunFinishedEvents(
  db: RunEventsDb,
  run: { id: string; agentId: string; status: string; error: string | null; parentRunId: string | null },
): Promise<void> {
  try {
    const agentName =
      (await db.agent.findUnique({ where: { id: run.agentId }, select: { name: true } }))?.name ?? run.agentId;
    if (!run.parentRunId) {
      try {
        // Only a succeeded run can be blocked (isBlockedByRefusals), so only it needs its children read.
        const succeeded = { id: run.id, status: "succeeded" as const, finalText: null };
        const outcome = run.status === "succeeded" ? await collectRunOutcome(db, succeeded) : null;
        if (outcome && isBlockedByRefusals(succeeded, outcome)) {
          await emitWorkflowEvent({
            dedupeKey: dedupeKeys.runBlocked(run.id),
            runId: run.id,
            agentId: run.agentId,
            payload: { kind: "run_blocked", agentName, packageRefusals: blockingRefusals(outcome) },
          });
        }
        // Any terminal status: what audit mode let in is worth knowing whether or not the run succeeded.
        const audit = outcome ? outcome.packageAudit : await collectPackageAudit(db, run.id);
        if (audit && audit.summary.entries.length > 0) {
          await emitWorkflowEvent({
            dedupeKey: dedupeKeys.packagesAudited(run.id),
            runId: run.id,
            agentId: run.agentId,
            payload: {
              kind: "packages_audited",
              agentName,
              mode: audit.mode,
              ...packageAuditDigest(audit.mode, audit.summary),
            },
          });
        }
      } catch {
        // A reporting read failure must not prevent other workflow events.
      }
      if (FAILED.has(run.status)) {
        await emitWorkflowEvent({
          dedupeKey: dedupeKeys.runFailed(run.id),
          runId: run.id,
          agentId: run.agentId,
          payload: { kind: "run_failed", agentName, status: run.status as "failed", reason: shortReason(run.error) },
        });
      }
    }
    const check = await db.runHostCheck.findUnique({ where: { runId: run.id } });
    if (check?.verdict && VERDICTS.has(check.verdict) && check.prNumber !== null) {
      const prLabel = `${check.repository}#${check.prNumber}`;
      await emitWorkflowEvent({
        dedupeKey: dedupeKeys.reviewPosted(run.id),
        runId: run.id,
        agentId: run.agentId,
        pullRequest: { codeProvider: check.provider, repository: check.repository, number: check.prNumber },
        payload: {
          kind: "review_posted",
          agentName,
          verdict: check.verdict as "APPROVE",
          prLabel,
          prUrl: pullRequestWebUrl(check.provider, check.repository, check.prNumber),
          ciPending: check.ciPendingAtReview === true,
        },
      });
    }
  } catch (err) {
    log.warn({ err, runId: run.id }, "could not emit run workflow events");
  }
  await emitRunCompletedEvent(db, run.id);
}
