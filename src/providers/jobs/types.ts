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
  image: string;
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
  launch: (spec: JobSpec) => Promise<JobHandle>;
  status: (handle: JobHandle) => Promise<JobStatus>;
  collect: (handle: JobHandle) => Promise<JobResult>;
  stop: (handle: JobHandle, reason?: string) => Promise<void>;
  remove: (handle: JobHandle) => Promise<void>;
}
