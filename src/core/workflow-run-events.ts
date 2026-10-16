/**
 * Workflow notifications a run's finalizer emits: run_failed for a top-level
 * run that did not succeed, run_blocked for package refusals without changes
 * (children are summarized by their parent), packages_audited when its coding
 * children installed anything under package audit mode, and
 * review_posted when the run published a verdict on its own check. Called
 * only by the finalizer that made the run terminal. Never throws.
 */
import type { PrismaClient } from "#prisma";
import { packageAuditDigest } from "../coding/registry/audit-mode.js";
import { collectPackageAudit, collectRunOutcome, isBlockedByRefusals } from "./host-status.js";
import { logger } from "./logger.js";
import { dedupeKeys, emitWorkflowEvent, shortReason } from "./workflow-events.js";

const log = logger.child({ module: "workflow-run-events" });
const FAILED = new Set(["failed", "budget_exhausted", "cancelled", "lost", "refused"]);
const VERDICTS = new Set(["APPROVE", "CHANGES_REQUESTED", "COMMENT"]);

export type RunEventsDb = Pick<
  PrismaClient,
  "agent" | "runHostCheck" | "run" | "runBudgetEvent" | "registryFetch" | "registryAuditRecord"
>;

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
            payload: { kind: "run_blocked", agentName, packageRefusals: outcome.packageRefusals },
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
          prUrl: check.provider === "github" ? `https://github.com/${check.repository}/pull/${check.prNumber}` : null,
          ciPending: check.ciPendingAtReview === true,
        },
      });
    }
  } catch (err) {
    log.warn({ err, runId: run.id }, "could not emit run workflow events");
  }
}
