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

export type ExecutionRecoveryResult = { state: "active" } | { state: "terminal" } | { state: "lost"; reason?: string };

export interface CodingImageSelector {
  toolchain: string;
  toolchainVersion: string | null;
  workerImageRef: string | null;
}

export interface Executor {
  start: (runId: string) => Promise<void>;
  stop: (runId: string, reason?: string) => Promise<void>;
  /**
   * Implementations must query the persisted handle and, before returning
   * `lost`, best-effort stop and collect it. `terminal` means collection and
   * terminal Run persistence completed. Recovery must never relaunch a job.
   */
  recover?: (handle: PersistedExecutionHandle) => Promise<ExecutionRecoveryResult>;
  /**
   * Optional one-time startup. A durable backend connects and re-drives the
   * workflows it owned before the last restart. Composition roots call it
   * before starting the scheduler or MCP server.
   */
  launch?: () => Promise<void>;
  /** Optional graceful shutdown counterpart to `launch`. */
  close?: () => Promise<void>;
  /**
   * Resolves a coding agent's profile selection to an immutable worker
   * image digest, once, at dispatch time (src/core/dispatch.ts) — never
   * called from the hot path. Must throw on an unresolvable
   * (toolchain, toolchainVersion) pair, fail-closed, same convention as
   * the LLM pricing tables' unknown-model throw.
   */
  resolveCodingWorkerImage?(selector: CodingImageSelector): string;
}
