/**
 * Trusted control-plane contract for isolated coding jobs. User-controlled
 * values are carried in a versioned input artifact, never expanded into an
 * arbitrary environment map or shell command.
 */

import type { CodingProvider } from "../../coding/provider.js";

export interface JobResourceLimits {
  cpus: number;
  memoryMb: number;
  pids: number;
  diskMb: number;
}

import type { CollectExclusions } from "../../coding/collect-exclude.js";
import type { ResolvedCodingService } from "../../coding/services/catalog.js";

export interface JobSpec {
  kind: "coding-agent";
  runId: string;
  /** Omitted specs are legacy Codex jobs and retain the single-worker topology. */
  provider?: "codex" | "claude-code";
  image: string;
  /** Required only for Claude's credential-free repository tool container. */
  toolImage?: string;
  inputArtifact: string;
  /** Set only when the run's dependency cache is on (CodingRun.dependencyCache); absent otherwise, never false. */
  dependencyCache?: true;
  /**
   * Claude Code only, set only when the run keeps its session (CodingRun.sessionResume); absent otherwise,
   * never false. The worker's SDK config dir, where the session file grows, gets its own size-limited
   * scratch so a long session never fills the worker's shared /tmp.
   */
  sessionResume?: true;
  timeoutSec: number;
  limits: JobResourceLimits;
  labels: Record<string, string>;
  /** Workspace paths never collected; absent on legacy specs, which get the built-in names. */
  collectExclude?: CollectExclusions;
  /**
   * Coding-run services (docs/coding-services.md): catalog snapshots resolved
   * at dispatch, started next to the worker. Their images and environments come
   * from the admin-managed catalog, never from repository content. Absent for
   * a run without services (never an empty list), so such a spec, and its hash,
   * is unchanged.
   */
  services?: ResolvedCodingService[];
}

/** Opaque provider reference. Callers persist both fields exactly as given. */
export interface JobHandle {
  backend: string;
  id: string;
}

export type JobStatus =
  | {
      state: "pending" | "running";
      /**
       * Only ever on `pending`: the backend refused this job's launch for capacity (JobCapacityError)
       * and nothing of it is running, nor will it start on its own. A caller that finds its job so
       * may return the run to its queue and later `launch` the same spec again.
       */
      capacityRefused?: true;
    }
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
 * The backend has no room for this job right now (Kubernetes: the namespace ResourceQuota). No
 * workload of the job is left running; the backend may keep a record of the refusal (Kubernetes
 * does: its run record, which `status` then reports as `pending` with `capacityRefused`). The
 * caller may launch the same spec again later.
 */
export class JobCapacityError extends Error {
  readonly code = "coding_capacity_exceeded";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JobCapacityError";
  }
}

/**
 * Lifecycle invariants implemented by every launcher:
 *
 * - `launch` is idempotent by runId for an identical spec and rejects a
 *   different spec for the same runId.
 * - `launch` may reject with JobCapacityError when the backend has no room for
 *   the job; nothing of it is then left running, and a later `launch` of the
 *   same spec provisions it afresh.
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
  /**
   * Whether the cluster has room for this spec's job right now (Kubernetes: the namespace
   * ResourceQuota). Asked before a run claims a slot; false keeps the run queued so it is retried
   * later instead of failing when the job is refused. Absent, or any doubt, means yes: the launch
   * itself stays the authority.
   */
  hasCapacityFor?: (spec: JobSpec) => Promise<boolean>;
  /**
   * Starts any one-time start-up check (e.g. Kubernetes's memoized cluster preflight) right away,
   * instead of waiting for the first `launch()`. Never throws — a failure is only logged — and
   * `launch()` still runs and reports the same check itself, memoized exactly as if this had never
   * been called. Composition roots call this, fire-and-forget, only from a long-running server
   * process's own start-up (`wardby serve`, the MCP server, `wardby scheduler`); never from a
   * one-shot CLI command. Absent on a launcher with nothing to warm up (e.g. Docker).
   */
  warmUp?: () => Promise<void>;
  launch: (spec: JobSpec) => Promise<JobHandle>;
  status: (handle: JobHandle) => Promise<JobStatus>;
  collect: (handle: JobHandle) => Promise<JobResult>;
  /**
   * The run's session transcript file (the worker's session.jsonl), at most `maxBytes`; undefined
   * when there is none or the job's storage is gone (a stopped job). Throws `transcript_too_large`
   * when larger. Never cached in the job record: it is not redacted yet. Call before `remove`.
   */
  readTranscript?: (handle: JobHandle, maxBytes: number) => Promise<string | undefined>;
  stop: (handle: JobHandle, reason?: string) => Promise<void>;
  remove: (handle: JobHandle) => Promise<void>;
}

/** A launcher that can safely copy a terminal worker workspace back to trusted storage. */
export interface WorkspaceJobLauncher extends JobLauncher {
  materializeWorkspace: (handle: JobHandle, destination: string) => Promise<void>;
  /**
   * Whether this launcher starts JobSpec.services for a run of `provider`: Kubernetes and Docker, for
   * Codex and Claude Code. Absent means no services at all.
   */
  supportsServicesFor?(provider: CodingProvider): boolean;
}
