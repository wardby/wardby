/**
 * Pure decision table for reconciling a stale `Run` that a DBOS workflow
 * owns. Kept free of DBOS imports so it is unit-testable without Postgres.
 */

export interface WorkflowStatusLike {
  status: string;
  executorId?: string;
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
