/**
 * Trusted control-plane contract for isolated coding jobs. User-controlled
 * values are carried in a versioned input artifact, never expanded into an
 * arbitrary environment map or shell command.
 */

export interface JobResourceLimits {
  cpus: number;
  memoryMb: number;
  pids: number;
  diskMb: number;
}

export interface JobSpec {
  kind: "coding-agent";
  runId: string;
  /** Omitted specs are legacy Codex jobs and retain the single-worker topology. */
  provider?: "codex" | "claude-code";
  image: string;
  /** Required only for Claude's credential-free repository tool container. */
  toolImage?: string;
  inputArtifact: string;
  timeoutSec: number;
  limits: JobResourceLimits;
  labels: Record<string, string>;
}

/** Opaque provider reference. Callers persist both fields exactly as given. */
export interface JobHandle {
  backend: string;
  id: string;
}

export type JobStatus =
  | { state: "pending" | "running" }
  | { state: "succeeded" }
  | { state: "failed"; reason?: string }
  | { state: "stopped" }
  | { state: "lost" };

export interface JobResult {
  exitCode: number;
  reason: "completed" | "failed" | "stopped" | "timed_out" | "lost";
  resultArtifact?: string;
  /** Fixed worker-owned failure code; never raw container output. */
  diagnostic?: string;
  /** Output-schema failure locations (`path:code`) that passed SAFE_CODING_OUTPUT_ISSUE; never values. */
  diagnosticIssues?: string[];
}

/**
 * Lifecycle invariants implemented by every launcher:
 *
 * - `launch` is idempotent by runId for an identical spec and rejects a
 *   different spec for the same runId.
 * - pending may become running or terminal; running may become terminal;
 *   terminal states never change.
 * - `collect` is repeatable for a terminal job until `remove` succeeds.
 * - `stop` and `remove` are idempotent and best effort; removing an active
 *   job is rejected so cleanup cannot silently become an implicit stop.
 * - no operation implicitly relaunches a missing, stopped, or removed job.
 */
export interface JobLauncher {
  /**
   * The handle `launch(spec)` will return, when a backend can derive it from the spec alone with no
   * side effects. Callers persist it *before* launching, so a crash mid-launch still leaves a handle
   * to stop and remove the run's resources with. `launch` must return an equal handle. Backends that
   * cannot know the handle in advance omit this, and callers persist only after `launch` returns.
   */
  plannedHandle?: (spec: JobSpec) => JobHandle | undefined;
  launch: (spec: JobSpec) => Promise<JobHandle>;
  status: (handle: JobHandle) => Promise<JobStatus>;
  collect: (handle: JobHandle) => Promise<JobResult>;
  stop: (handle: JobHandle, reason?: string) => Promise<void>;
  remove: (handle: JobHandle) => Promise<void>;
}

/** A launcher that can safely copy a terminal worker workspace back to trusted storage. */
export interface WorkspaceJobLauncher extends JobLauncher {
  materializeWorkspace: (handle: JobHandle, destination: string) => Promise<void>;
}
