/**
 * Jobs seam — dispatch long-running work (plan-runs, the job-runner).
 *
 * Default adapter: LocalJobLauncher (spawn a local process/container).
 * Native adapter:  EcsFargateJobLauncher (AWS ECS/Fargate).
 *
 * Dead-job detection lives here: the watchdog/reconciler polls `status()`,
 * and the adapter maps liveness to a `"lost"` state (e.g. ECS DescribeTasks
 * plus missed heartbeats). Keeping this in the interface keeps the watchdog
 * logic cloud-agnostic.
 */

export interface JobSpec {
  /** Job type, e.g. "plan-run" | "index" | "snyk". */
  kind: string;
  /**
   * Environment passed to the job. Secrets and the run token ride in env only —
   * they are never logged, returned in errors, or persisted.
   */
  env: Record<string, string>;
  labels?: Record<string, string>;
  timeoutSec?: number;
}

/** Opaque provider reference to a launched job (e.g. an ECS task ARN). */
export interface JobHandle {
  id: string;
}

export type JobStatus =
  | { state: "pending" | "running" }
  | { state: "succeeded" }
  | { state: "failed"; reason?: string }
  | { state: "stopped" }
  /** Watchdog verdict: the job is presumed dead (missed heartbeats / vanished). */
  | { state: "lost" };

export interface JobLauncher {
  launch(spec: JobSpec): Promise<JobHandle>;
  status(handle: JobHandle): Promise<JobStatus>;
  stop(handle: JobHandle, reason?: string): Promise<void>;
}
