/**
 * Executor seam — how the scheduler durably runs a `Run` to a terminal
 * state.
 *
 * Phase 2's default (`InProcessExecutor`) provides durability via a
 * heartbeat plus an external reconciler. Phase 3 can add a `DbosExecutor`
 * backed by durable workflow steps with no scheduler or CLI change — the
 * scheduler only ever calls `start(runId)` and never sees the mechanism.
 */
export interface PersistedExecutionHandle {
  runId: string;
  backend: string;
  id: string;
}

export type ExecutionRecoveryResult =
  | { state: "active" }
  | { state: "terminal" }
  | { state: "lost"; reason?: string };

export interface Executor {
  start: (runId: string) => Promise<void>;
  stop: (runId: string, reason?: string) => Promise<void>;
  /**
   * Implementations must query the persisted handle and, before returning
   * `lost`, best-effort stop and collect it. `terminal` means collection and
   * terminal Run persistence completed. Recovery must never relaunch a job.
   */
  recover?: (handle: PersistedExecutionHandle) => Promise<ExecutionRecoveryResult>;
}
