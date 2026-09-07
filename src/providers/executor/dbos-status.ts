/**
 * Pure decision table for reconciling a stale `Run` that a DBOS workflow
 * owns. Kept free of DBOS imports so it is unit-testable without Postgres.
 */

export interface WorkflowStatusLike {
  status: string;
  executorId?: string;
  applicationVersion?: string;
}

/**
 * How many times the reconciler will try to adopt (resume) one orphaned
 * workflow before declaring the run lost.
 *
 * DBOS gates both recovery and dequeue on `application_version`: a workflow
 * recorded under an older version is re-`resume`d on every reconciler pass
 * and never dequeued, so without a bound the run sits `running` forever and
 * the reconciler re-drives it every pass. `recover()` also short-circuits an
 * outright version mismatch (see `versionMismatchReason`); this bound is the
 * catch-all for every other reason a resume can fail to take.
 */
export const MAX_RESUME_ATTEMPTS = 3;

export const ADOPTION_EXHAUSTED_REASON = `Durable workflow could not be re-driven after ${MAX_RESUME_ATTEMPTS} adoption attempts (executor/version mismatch).`;

/**
 * Given the number of adoption attempts already made for a run, should the
 * reconciler stop trying and declare it lost? The counter lives in the
 * executor (in memory, per process) — this is just the bound, kept pure so
 * it can be tested without Postgres.
 */
export function shouldGiveUpAdoption(attemptsAlreadyMade: number): boolean {
  return attemptsAlreadyMade >= MAX_RESUME_ATTEMPTS;
}

/**
 * Reason to give up immediately when the recorded workflow belongs to a
 * different application version than this process runs — DBOS will never
 * dequeue it here, so resuming it is pure churn. `undefined` when the two
 * agree, or when either version is unknown (nothing to compare).
 */
export function versionMismatchReason(
  workflowVersion: string | undefined,
  processVersion: string | undefined,
): string | undefined {
  if (!workflowVersion || !processVersion || workflowVersion === processVersion) return undefined;
  return `Durable workflow belongs to application version ${workflowVersion}; this process runs ${processVersion}.`;
}

export type RecoveryDecision =
  | { action: "active" }
  | { action: "resume" }
  | { action: "terminal" }
  | { action: "mark-failed"; error: string }
  | { action: "lost"; reason: string };

const LIVE = new Set(["PENDING", "ENQUEUED", "DELAYED"]);
const FINISHED = new Set(["SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"]);

export function decideRecovery(
  status: WorkflowStatusLike | null,
  runIsTerminal: boolean,
  selfExecutorId: string,
): RecoveryDecision {
  if (!status) {
    return {
      action: "lost",
      reason: "Durable workflow record not found; the run was never started or its record was purged.",
    };
  }
  if (LIVE.has(status.status)) {
    // A live workflow this process owns is simply still running (its
    // heartbeat lapsed under load). One owned by another executor id whose
    // heartbeat lapsed is orphaned — that executor died — so adopt it.
    return status.status === "PENDING" && status.executorId === selfExecutorId
      ? { action: "active" }
      : { action: "resume" };
  }
  if (FINISHED.has(status.status)) {
    return runIsTerminal
      ? { action: "terminal" }
      : {
          action: "mark-failed",
          error: `Durable workflow finished (${status.status}) without persisting a terminal run state.`,
        };
  }
  return { action: "lost", reason: `Durable workflow is in unrecognised status "${status.status}".` };
}
