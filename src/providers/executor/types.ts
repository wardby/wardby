/**
 * Executor seam — how the scheduler durably runs a `Run` to a terminal
 * state.
 *
 * Phase 2's default (`InProcessExecutor`) provides durability via a
 * heartbeat plus an external reconciler. Phase 3 can add a `DbosExecutor`
 * backed by durable workflow steps with no scheduler or CLI change — the
 * scheduler only ever calls `start(runId)` and never sees the mechanism.
 */
export interface Executor {
  start(runId: string): Promise<void>;
}
