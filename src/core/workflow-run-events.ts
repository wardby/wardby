/**
 * Workflow notifications a run's finalizer emits: run_failed for a top-level
 * run that did not succeed (children are summarized by their parent), and
 * review_posted when the run published a verdict on its own check. Called
 * only by the finalizer that made the run terminal. Never throws.
 */
import type { PrismaClient } from "#prisma";
import { logger } from "./logger.js";
import { dedupeKeys, emitWorkflowEvent, shortReason } from "./workflow-events.js";

const log = logger.child({ module: "workflow-run-events" });
const FAILED = new Set(["failed", "budget_exhausted", "cancelled", "lost", "refused"]);
const VERDICTS = new Set(["APPROVE", "CHANGES_REQUESTED", "COMMENT"]);

export type RunEventsDb = Pick<PrismaClient, "agent" | "runHostCheck">;

/** Emits run_failed (top-level, non-success) and review_posted (verdict published). Never throws. */
export async function emitRunFinishedEvents(
  db: RunEventsDb,
  run: { id: string; agentId: string; status: string; error: string | null; parentRunId: string | null },
): Promise<void> {
  try {
    const agentName =
      (await db.agent.findUnique({ where: { id: run.agentId }, select: { name: true } }))?.name ?? run.agentId;
    if (!run.parentRunId && FAILED.has(run.status)) {
      await emitWorkflowEvent({
        dedupeKey: dedupeKeys.runFailed(run.id),
        runId: run.id,
        agentId: run.agentId,
        payload: { kind: "run_failed", agentName, status: run.status as "failed", reason: shortReason(run.error) },
      });
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
