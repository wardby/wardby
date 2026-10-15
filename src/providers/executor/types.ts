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
  provider: CodingProvider;
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
   * Fire-and-forget start-up warm-up, called only from a long-running server process's own
   * start-up (`wardby serve`, the MCP server, `wardby scheduler`) — never from a one-shot CLI
   * command. Delegates to the coding job launcher's own `warmUp` (e.g. Kubernetes's memoized
   * cluster preflight); never throws.
   */
  warmUp?: () => Promise<void>;
  /**
   * Resolves a coding agent's profile selection to an immutable worker
   * image digest, once, at dispatch time (src/core/dispatch.ts) — never
   * called from the hot path. Must throw on an unresolvable
   * (provider, toolchain, toolchainVersion) tuple, fail-closed, same convention as
   * the LLM pricing tables' unknown-model throw.
   */
  resolveCodingWorkerImage?(selector: CodingImageSelector): string;
  /**
   * Claude Code's tool-runner image (the container that runs its commands) for the agent's
   * toolchain, resolved and persisted at dispatch alongside the worker image; null for Codex, whose
   * one worker image carries the toolchain. Throws, like resolveCodingWorkerImage, on a toolchain
   * with no image.
   */
  resolveCodingToolImage?(selector: CodingImageSelector): string | null;
  /**
   * Coding-run services (docs/coding-services.md): the raw text of the
   * repository's .wardby/services.yaml at `baseRef`, or null when it has none.
   * Called by dispatch before its transaction (it is a network call). An
   * executor without it gives coding runs no services.
   */
  readCodingServiceDeclaration?(input: { repository: string; baseRef: string }): Promise<string | null>;
  /**
   * The raw text of one repository file at `baseRef`, or null when absent.
   * Throws (github_file_* or local_file_*: too_large, not_a_file, not_utf8)
   * when the file is oversized or not UTF-8 text. Called by dispatch before its transaction (network call).
   * Used for the knowledge note (src/knowledge/note.ts).
   */
  readCodingRepositoryFile?(input: {
    repository: string;
    baseRef: string;
    path: string;
    maxBytes: number;
  }): Promise<string | null>;
  /**
   * Whether this executor can start coding-run services for a run of `provider`: its job launcher
   * says so (Kubernetes and Docker, for Codex and Claude Code).
   */
  supportsCodingServices?(provider: CodingProvider): boolean;
  /**
   * Whether this executor can run sandbox-mode native runs (a native sandbox executor is composed
   * in). MCP refuses to set an agent to sandbox mode where it cannot (docs/native-sandbox.md).
   */
  supportsNativeSandbox?(): boolean;
  /**
   * true: this executor cannot resolve coding inputs; dispatch records the coding run unresolved
   * and the process that starts it resolves them (resolveDeferredCodingRun).
   */
  defersCodingResolution?: boolean;
}
import type { CodingProvider } from "../../coding/provider.js";
