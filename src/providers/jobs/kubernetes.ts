/**
 * KubernetesJobLauncher: runs one Codex coding job as one pod (a trusted
 * `keeper` container that owns the storage volume, plus the untrusted
 * `worker`), with its own NetworkPolicy and capability Secret.
 *
 * All job state lives in Kubernetes — a per-run record ConfigMap updated with
 * optimistic concurrency (`resourceVersion`) — rather than in local files or
 * in-process timers, so any control-plane replica can observe, collect, stop,
 * or remove any run, and a restarted process loses nothing.
 *
 * Containers in a pod start together, so the worker cannot simply be started
 * later the way Docker's is. Instead its command waits for a seeded marker
 * the launcher writes through the keeper only after the pod and policy have
 * been read back and attested against the canonical builders, the pod's
 * NetworkPolicy is observed to be enforced (CNIs program a new pod's policy
 * a few seconds after it starts), and the workspace and input have been
 * seeded. Seeding is real wall-clock time bounded only by the run's own
 * timeoutSec, so enforcement is re-probed one last time immediately before
 * the marker write, with nothing else awaited in between — a NetworkPolicy
 * landing after the first proof but before release must still be caught.
 * Until that gate opens, nothing untrusted runs.
 */
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PassThrough, Writable, type Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { V1ConfigMap, V1Pod } from "@kubernetes/client-node";
import type { KubernetesJobConfig } from "../../config/providers.js";
import { logger } from "../../core/logger.js";
import { MAX_CODING_ARTIFACT_BYTES, parseCodingAgentOutputJson } from "../../coding/protocol.js";
import { CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "./docker-isolation.js";
import { parseWorkerDiagnosticLine, type WorkerDiagnostic } from "./docker.js";
import { KubernetesAlreadyExistsError, KubernetesConflictError, type KubernetesApi } from "./kubernetes-api.js";
import {
  ENFORCEMENT_PROBE_DENY_REACHABLE,
  ENFORCEMENT_PROBE_PROVEN,
  ENFORCEMENT_PROBE_DENY_REFUSED,
  ENFORCEMENT_PROBE_PROXY_UNREACHABLE,
  KEEPER_CONTAINER,
  KEEPER_SEEDED_MARKER,
  KUBERNETES_ISOLATION_ERROR,
  STORAGE_ROOT,
  WORKER_CONTAINER,
  assertRunNetworkPolicyMatches,
  assertRunPodMatches,
  buildCapabilitySecret,
  buildRunNetworkPolicy,
  buildRunPod,
  enforcementProbeScript,
  kubernetesRunNames,
  kubernetesRunNamesForToken,
  runLabels,
  validateKubernetesSpec,
} from "./kubernetes-isolation.js";
import { readProxyWitness } from "./kubernetes-witness.js";
import { safeExtract } from "./safe-extract.js";
import type { JobHandle, JobResult, JobSpec, JobStatus, WorkspaceJobLauncher } from "./types.js";
import { replaceDirectoryFromStaging } from "./workspace-swap.js";
import {
  collectExclusions,
  normalizeCollectExclusions,
  tarExcludeArgs,
  type CollectExclusions,
} from "../../coding/collect-exclude.js";

/** The per-run object names, always derived through kubernetes-isolation's single naming source. */
type RunNames = ReturnType<typeof kubernetesRunNamesForToken>;

const BACKEND = "kubernetes";
const RECORD_SCHEMA_VERSION = 1;
const RECORD_KEY = "record.json";
const STOP_GRACE_SECONDS = 10;
const DIAGNOSTIC_TAIL_LINES = 8;
const DIAGNOSTIC_LIMIT_BYTES = 4096;
const MAX_WORKSPACE_ENTRIES = 100_000;
const MAX_RECORD_ATTEMPTS = 5;
const READY_POLL_MS = 250;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_ENFORCEMENT_TIMEOUT_MS = 30_000;
const ENFORCEMENT_POLL_MS = 500;
/** Consecutive proven probes required (8787 reachable, 8788 blocked): one dropped SYN must not open the gate. */
const ENFORCEMENT_BLOCKED_STREAK = 3;
/** Bound for one enforcement probe exec (the probe makes two sequential connects, so it gives up after at most 6 s). */
const ENFORCEMENT_EXEC_TIMEOUT_MS = 10_000;

/**
 * What the gate reports at its bound, by the last probe's exit code. Each names a different place
 * to look, and each carries the reason in its own message rather than in the documentation: an
 * operator reads the error, not this file.
 *
 * Anything not listed here is an exit code the probe never produces, so the probe did not run to
 * completion (a crash, a missing interpreter, an OOM-killed keeper) and NOTHING was measured. That
 * must not be reported as "the policy was not enforced": it says nothing whatever about the policy,
 * and sending an operator to the CNI over a dead exec wastes the one clue they were given.
 */
const ENFORCEMENT_VERDICTS: Readonly<Record<number, { code: string; detail: string }>> = {
  [ENFORCEMENT_PROBE_PROVEN]: {
    code: "kubernetes_policy_not_enforced",
    // Reaching the bound on a proven probe means the streak kept being broken: enforcement was
    // observed, but never ENFORCEMENT_BLOCKED_STREAK times running, so it is not stable evidence.
    detail: `the last probe was proven, but never ${ENFORCEMENT_BLOCKED_STREAK} consecutive times within the bound — enforcement is flapping rather than absent`,
  },
  [ENFORCEMENT_PROBE_DENY_REACHABLE]: {
    code: "kubernetes_policy_not_enforced",
    detail: `the deny port ${CODING_PROXY_DENY_PORT} accepted a connection, so no policy is blocking it (or the policy is not port-scoped) — look at the CNI`,
  },
  [ENFORCEMENT_PROBE_PROXY_UNREACHABLE]: {
    code: "kubernetes_policy_witness_unavailable",
    detail: `the proxy port ${CODING_PROXY_PORT} could not be reached, so nothing could be witnessed — look at the proxy pod and its Service, not the CNI`,
  },
  [ENFORCEMENT_PROBE_DENY_REFUSED]: {
    code: "kubernetes_policy_witness_unserved",
    detail:
      `the deny port ${CODING_PROXY_DENY_PORT} answered with a refusal (RST) instead of being dropped. Two causes, ` +
      "either of which voids the witness: nothing is serving the deny port, or this cluster's CNI rejects " +
      "instead of dropping, in which case a genuine denial is indistinguishable from an unserved port and " +
      "this cluster needs a different witness",
  },
};

const ENFORCEMENT_PROBE_DID_NOT_RUN = {
  code: "kubernetes_policy_probe_unusable",
  detail:
    "the probe exited with a code it never produces, so it did not run to completion (a crash, a missing " +
    "interpreter, or an OOM-killed keeper). Nothing was measured, so this says nothing about the policy",
};

/**
 * Where in the launch a probe run happened: `initial` is the first proof, before anything is seeded.
 * `pre_marker` is the re-confirmation run again immediately before the gate marker is written — the
 * whole point of which is that seeding runs for real wall-clock time (up to the run's own timeoutSec)
 * with nothing else re-checked in between, so a NetworkPolicy landing in that window must be caught
 * here, not assumed still absent because it was absent at `initial`. The two stages use distinct error
 * codes so an operator can tell "this run's policy was never enforced" apart from "it was enforced when
 * first proven, but something reopened this pod's egress while the workspace was being seeded" — the
 * second is the far more alarming one (active drift/compromise during a live launch), not just a bug hazard.
 */
type EnforcementStage = "initial" | "pre_marker";

/** Same shape as ENFORCEMENT_VERDICTS/ENFORCEMENT_PROBE_DID_NOT_RUN, but for the `pre_marker` stage. */
const ENFORCEMENT_VERDICTS_PRE_MARKER: Readonly<Record<number, { code: string; detail: string }>> = {
  [ENFORCEMENT_PROBE_PROVEN]: {
    code: "kubernetes_policy_enforcement_lost_before_marker",
    detail:
      `the policy was proven enforced earlier in this launch, but the re-probe run immediately before ` +
      `opening the gate never reached ${ENFORCEMENT_BLOCKED_STREAK} consecutive proven probes within the ` +
      "bound — enforcement held at the initial proof but is flapping now, immediately before release",
  },
  [ENFORCEMENT_PROBE_DENY_REACHABLE]: {
    code: "kubernetes_policy_enforcement_lost_before_marker",
    detail:
      `the deny port ${CODING_PROXY_DENY_PORT} was proven blocked earlier in this launch, but the re-probe ` +
      "run immediately before opening the gate found it reachable — a NetworkPolicy change during seeding " +
      "(GitOps drift, a stale re-apply, anything else with NetworkPolicy write access in this namespace) " +
      "silently reopened this run's egress; look at what changed policies in this namespace, not just the CNI",
  },
  [ENFORCEMENT_PROBE_PROXY_UNREACHABLE]: {
    code: "kubernetes_policy_witness_unavailable_before_marker",
    detail:
      `the proxy port ${CODING_PROXY_PORT} could not be reached on the re-probe run immediately before ` +
      "opening the gate, so enforcement could not be re-confirmed — look at the proxy pod and its Service",
  },
  [ENFORCEMENT_PROBE_DENY_REFUSED]: {
    code: "kubernetes_policy_witness_unserved_before_marker",
    detail:
      `the deny port ${CODING_PROXY_DENY_PORT} answered with a refusal (RST) instead of being dropped on ` +
      "the re-probe run immediately before opening the gate — the witness itself became unserved during seeding",
  },
};

const ENFORCEMENT_PROBE_DID_NOT_RUN_PRE_MARKER = {
  code: "kubernetes_policy_probe_unusable_before_marker",
  detail:
    "the re-probe run immediately before opening the gate exited with a code it never produces, so it did " +
    "not run to completion. Nothing was measured, so this says nothing about whether the policy still holds",
};

/** The gate's verdict, carrying the exit code, the address it probed, and which stage produced it. */
function enforcementVerdict(exitCode: number, proxyIp: string, stage: EnforcementStage): Error {
  const table = stage === "initial" ? ENFORCEMENT_VERDICTS : ENFORCEMENT_VERDICTS_PRE_MARKER;
  const fallback = stage === "initial" ? ENFORCEMENT_PROBE_DID_NOT_RUN : ENFORCEMENT_PROBE_DID_NOT_RUN_PRE_MARKER;
  const { code, detail } = table[exitCode] ?? fallback;
  return new Error(`${code}: probing ${proxyIp}, the last probe exited ${exitCode}; ${detail}`, {
    cause: { exitCode, address: proxyIp, stage },
  });
}
/** Bound for small keeper commands (seeded marker, result artifact read). */
const SHORT_EXEC_TIMEOUT_MS = 60_000;
const FATAL_WAITING_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "CrashLoopBackOff",
]);
const CAPABILITY = /^rrp_[A-Za-z0-9_-]{16,512}$/;
const TOKEN = /^[a-f0-9]{20}$/;
const WORKSPACE_STORAGE = `${STORAGE_ROOT}/workspace`;
const INPUT_STORAGE = `${STORAGE_ROOT}/input`;
const RESULT_PATH = `${STORAGE_ROOT}/output/result.json`;
const kubernetesLog = logger.child({ module: "kubernetes-jobs" });

type Phase = "provisioning" | "active" | "succeeded" | "failed" | "stopped" | "lost" | "removed";
type ResultPhase = "succeeded" | "failed" | "stopped" | "lost";
const PHASES = new Set<Phase>(["provisioning", "active", "succeeded", "failed", "stopped", "lost", "removed"]);
const TERMINAL_PHASES = new Set<Phase>(["succeeded", "failed", "stopped", "lost", "removed"]);

interface RunRecord {
  schemaVersion: number;
  runId: string;
  specHash: string;
  diskMb: number;
  createdAt: number;
  deadlineAt: number;
  phase: Phase;
  result?: JobResult;
  /** Collection exclusions from the spec; absent on records from before they existed. */
  collectExclude?: CollectExclusions;
}

export interface KubernetesClusterInfo {
  /** The proxy Service's ClusterIP: the enforcement witness's address (8787 reachable, 8788 not). */
  proxyIp: string;
}

export interface KubernetesJobLauncherOptions {
  api: KubernetesApi;
  config: KubernetesJobConfig;
  workspaceRoot: string; // same root the VCS provider prepares workspaces under
  resolveCapability: (runId: string) => Promise<string>;
  /**
   * Cluster preflight run once before the first launch; failure fails every launch. It may return the
   * proxy ClusterIP it validated; otherwise the launcher reads the proxy witness once itself. Either way
   * the gate probes the address `provision` re-reads for that launch, not this memoized one.
   */
  preflight?: () => Promise<KubernetesClusterInfo | void>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  readyTimeoutMs?: number; // default 120_000
  /** How long to wait for the run's NetworkPolicy to be enforced before seeding. Default 30_000. */
  enforcementTimeoutMs?: number;
  createArchive?: (directory: string) => { stream: Readable; done: Promise<number> }; // default: host `tar`
  onWarning?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers: the lifecycle rules.

function stableSpecHash(spec: JobSpec): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...spec,
        labels: Object.fromEntries(Object.entries(spec.labels).sort(([left], [right]) => left.localeCompare(right))),
      }),
    )
    .digest("hex");
}

function isTerminal(phase: Phase): boolean {
  return TERMINAL_PHASES.has(phase);
}

function statusFor(record: RunRecord): JobStatus {
  switch (record.phase) {
    case "provisioning":
      return { state: "pending" };
    case "active":
      return { state: "running" };
    case "succeeded":
      return { state: "succeeded" };
    case "failed":
      return { state: "failed", ...(record.result?.reason === "timed_out" ? { reason: "timed_out" } : {}) };
    case "stopped":
      return { state: "stopped" };
    case "lost":
      return { state: "lost" };
    case "removed":
      throw new Error("job_removed");
  }
}

function resultFor(phase: ResultPhase): JobResult {
  switch (phase) {
    case "succeeded":
      return { exitCode: 0, reason: "completed" };
    case "failed":
      return { exitCode: 1, reason: "failed" };
    case "stopped":
      return { exitCode: 143, reason: "stopped" };
    case "lost":
      return { exitCode: 1, reason: "lost" };
  }
}

function parseRecord(configMap: V1ConfigMap): RunRecord {
  let decoded: Partial<RunRecord>;
  try {
    decoded = JSON.parse(configMap.data?.[RECORD_KEY] ?? "") as Partial<RunRecord>;
  } catch {
    throw new Error("kubernetes_record_invalid");
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    decoded.schemaVersion !== RECORD_SCHEMA_VERSION ||
    typeof decoded.runId !== "string" ||
    typeof decoded.specHash !== "string" ||
    !Number.isSafeInteger(decoded.diskMb) ||
    !Number.isFinite(decoded.createdAt) ||
    !Number.isFinite(decoded.deadlineAt) ||
    !PHASES.has(decoded.phase as Phase)
  ) {
    throw new Error("kubernetes_record_invalid");
  }
  return decoded as RunRecord;
}

interface PodObservation {
  phase: Phase;
  result?: JobResult;
  /** Set when the pod must be deleted (with this grace) before the new phase is recorded. */
  deleteGraceSeconds?: number;
}

/** Slack for clock skew between the kubelet's finishedAt and the control plane's deadline. */
const FINISHED_AT_SKEW_MS = 5_000;

/** Whether a worker's exit 0 happened on a live pod, not past the deadline, with a parseable finish time. */
function exitedCleanlyInTime(pod: V1Pod, finishedAt: Date | string | undefined, deadlineAt: number): boolean {
  if (pod.status?.reason === "DeadlineExceeded" || pod.metadata?.deletionTimestamp) return false;
  if (finishedAt === undefined || finishedAt === null) return false;
  const finished = new Date(finishedAt).getTime();
  return Number.isFinite(finished) && finished <= deadlineAt + FINISHED_AT_SKEW_MS;
}

/** Maps a pod read-back onto the next record state; `undefined` means "no change". Never called for terminal records. */
function observePod(
  pod: V1Pod | undefined,
  record: RunRecord,
  now: number,
  readyTimeoutMs: number,
): PodObservation | undefined {
  if (!pod) {
    if (record.phase === "provisioning" && now - record.createdAt < readyTimeoutMs) return undefined;
    return { phase: "lost", result: resultFor("lost") };
  }
  const worker = pod.status?.containerStatuses?.find((status) => status.name === WORKER_CONTAINER);
  const terminated = worker?.state?.terminated;
  // Exit 0 counts as success only if the worker finished on its own, before the deadline, on a live pod:
  // a SIGTERM from the kubelet's deadline or a pod deletion can be trapped by the untrusted worker and
  // turned into exit 0, and by then the keeper holding the result is gone too.
  if (terminated?.exitCode === 0 && exitedCleanlyInTime(pod, terminated.finishedAt, record.deadlineAt)) {
    return { phase: "succeeded", result: resultFor("succeeded") };
  }
  if (now >= record.deadlineAt || pod.status?.reason === "DeadlineExceeded") {
    return { phase: "failed", result: { exitCode: 124, reason: "timed_out" }, deleteGraceSeconds: STOP_GRACE_SECONDS };
  }
  if (terminated) {
    // An exit 0 that failed the guard above (pod being deleted, no usable finish time) is not a success.
    if (terminated.exitCode === 0) return { phase: "failed", result: resultFor("failed") };
    return {
      phase: "failed",
      result: {
        exitCode: terminated.reason === "OOMKilled" ? 137 : Math.max(1, terminated.exitCode ?? 1),
        reason: "failed",
      },
    };
  }
  if (pod.status?.phase === "Failed") return { phase: "failed", result: resultFor("failed") };
  // Nothing to record: a provisioning record is promoted only by the launch that owns it (after the
  // gate opens), and refresh() never calls this for a terminal one, so the phase is already right.
  return undefined;
}

/** Collects at most `limit` bytes; anything more only sets `exceeded`. */
class BoundedCollector extends Writable {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  exceeded = false;

  constructor(private readonly limit: number) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) this.exceeded = true;
    else this.chunks.push(chunk);
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Archives a trusted local directory with the host's `tar`, under a minimal environment. */
export function hostTarArchive(directory: string): { stream: Readable; done: Promise<number> } {
  const child = spawn("tar", ["-C", directory, "-cf", "-", "."], {
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    // COPYFILE_DISABLE stops macOS tar from adding `._*` metadata entries.
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", COPYFILE_DISABLE: "1" },
  });
  // Take ownership of stdout immediately. A small tree archives in milliseconds, and when the child
  // exits Node resume()s (discards) any stdout pipe nobody has consumed yet — which would silently
  // drop the whole archive before the exec WebSocket connects. Piping into a PassThrough buffers it
  // (with backpressure on tar) until the exec attaches.
  const stream = new PassThrough();
  child.stdout.pipe(stream);
  child.stdout.once("error", (error) => stream.destroy(error));
  // Without a listener, an unhandled "error" event on a stream surfaces asynchronously as an
  // uncaughtException and crashes the process (not a synchronous throw) — and `destroy(error)`
  // above emits exactly that on `stream`. The failure is still observable through `done` (the
  // child's close/error handlers below) and through the exec/extract that reads `stream`.
  stream.on("error", () => undefined);
  const done = new Promise<number>((resolvePromise) => {
    child.once("error", () => resolvePromise(-1));
    child.once("close", (code) => resolvePromise(code ?? -1));
  });
  stream.once("close", () => {
    // A seed that fails destroys this stream; don't leave tar blocked on a full pipe.
    if (!stream.readableEnded && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { stream, done };
}

function errorWithCode(code: string, cause?: unknown): Error {
  return cause === undefined ? new Error(code) : new Error(code, { cause });
}

// ---------------------------------------------------------------------------

export class KubernetesJobLauncher implements WorkspaceJobLauncher {
  private readonly api: KubernetesApi;
  private readonly namespace: string;
  private readonly workspaceRoot: string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly readyTimeoutMs: number;
  private readonly createArchive: (directory: string) => { stream: Readable; done: Promise<number> };
  private readonly warn: (message: string) => void;
  private readonly enforcementTimeoutMs: number;
  private preflightResult?: Promise<KubernetesClusterInfo>;

  constructor(private readonly options: KubernetesJobLauncherOptions) {
    this.api = options.api;
    this.namespace = options.config.namespace;
    this.workspaceRoot = resolve(options.workspaceRoot);
    if (this.workspaceRoot === resolve("/")) throw new Error("kubernetes_launcher_path_invalid");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.enforcementTimeoutMs = options.enforcementTimeoutMs ?? DEFAULT_ENFORCEMENT_TIMEOUT_MS;
    this.createArchive = options.createArchive ?? hostTarArchive;
    this.warn = options.onWarning ?? ((message) => kubernetesLog.warn(message));
  }

  /**
   * Every per-run object name derives from the run id, so the handle is known before any cluster call.
   * The executor persists it first; a crash mid-launch then still has a handle to clean up with (the
   * launcher itself has no `list` permission and so can never rediscover stray objects).
   */
  plannedHandle(spec: JobSpec): JobHandle | undefined {
    try {
      validateKubernetesSpec(spec);
      return { backend: BACKEND, id: `${this.namespace}/${kubernetesRunNames(spec.runId).token}` };
    } catch {
      // An invalid spec has no handle; launch() rejects with the real reason.
      return undefined;
    }
  }

  async launch(spec: JobSpec): Promise<JobHandle> {
    validateKubernetesSpec(spec);
    await this.runPreflight();
    const names = kubernetesRunNames(spec.runId);
    const handle: JobHandle = { backend: BACKEND, id: `${this.namespace}/${names.token}` };
    const specHash = stableSpecHash(spec);
    const existing = await this.readRecord(names);
    if (existing) return this.existingLaunch(existing.record, specHash, handle);
    const createdAt = this.now();
    const record: RunRecord = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      runId: spec.runId,
      specHash,
      diskMb: spec.limits.diskMb,
      createdAt,
      deadlineAt: createdAt + spec.timeoutSec * 1000,
      phase: "provisioning",
      collectExclude: spec.collectExclude ?? collectExclusions([]),
    };
    try {
      // The record is the idempotency fence before any other cluster side effect.
      await this.api.createConfigMap(this.namespace, this.recordConfigMap(names, record));
    } catch (error) {
      if (!(error instanceof KubernetesAlreadyExistsError)) throw error;
      const raced = await this.readRecord(names);
      if (!raced) throw error;
      return this.existingLaunch(raced.record, specHash, handle);
    }
    try {
      await this.provision(spec, names, record);
    } catch (error) {
      // Record the failure before deleting the pod, so a replica that observes "no pod" in between
      // can't record `lost` first and have this more specific outcome dropped.
      await this.updateRecord(names, () => ({
        phase: "failed",
        result: { exitCode: 1, reason: "failed", diagnostic: "kubernetes_provisioning_failed" },
      })).catch(() => undefined);
      await this.cleanupRun(names, 0);
      throw error;
    }
    return structuredClone(handle);
  }

  async status(handle: JobHandle): Promise<JobStatus> {
    const names = this.namesFor(handle);
    const found = names && (await this.readRecord(names));
    if (!names || !found) throw new Error("job_not_found");
    if (found.record.phase === "removed") throw new Error("job_removed");
    return structuredClone(statusFor(await this.refresh(names, found.record)));
  }

  async collect(handle: JobHandle): Promise<JobResult> {
    const names = this.namesFor(handle);
    const found = names && (await this.readRecord(names));
    if (!names || !found) throw new Error("job_not_found");
    if (found.record.phase === "removed") throw new Error("job_removed");
    const record = await this.refresh(names, found.record);
    if (!isTerminal(record.phase)) throw new Error("job_not_terminal");
    const phase = record.phase as ResultPhase;
    let result = record.result ?? resultFor(phase);
    if (phase === "failed" && !result.diagnostic) {
      const diagnostic = await this.readWorkerDiagnostic(names);
      if (diagnostic) result = { ...result, ...diagnostic };
    }
    if (phase === "succeeded" && !result.resultArtifact) {
      result = { ...result, resultArtifact: await this.readResultArtifact(names, record.runId) };
    }
    if (JSON.stringify(result) !== JSON.stringify(record.result)) {
      const stored = result;
      const updated = await this.updateRecord(names, (current) =>
        current.phase === phase ? { phase, result: stored } : undefined,
      );
      if (updated.phase === "removed") throw new Error("job_removed");
    }
    return structuredClone(result);
  }

  async materializeWorkspace(handle: JobHandle, destination: string): Promise<void> {
    const names = this.namesFor(handle);
    const found = names && (await this.readRecord(names));
    if (!names || !found) throw new Error("job_not_found");
    const record = await this.refresh(names, found.record);
    if (record.phase !== "succeeded") throw new Error("job_not_succeeded");
    const expected = resolve(this.workspaceRoot, record.runId, "workspace");
    if (resolve(destination) !== expected || !expected.startsWith(`${this.workspaceRoot}${sep}`)) {
      throw new Error("kubernetes_workspace_destination_invalid");
    }
    const maxBytes = record.diskMb * 1024 * 1024;
    await replaceDirectoryFromStaging(expected, maxBytes, "kubernetes_workspace_destination_invalid", (staging) =>
      this.extractWorkspace(
        names,
        staging,
        maxBytes,
        this.transferBudgetMs(record),
        // Names are always the current built-in list; only the paths come from the record.
        normalizeCollectExclusions(record.collectExclude?.paths),
      ),
    );
  }

  async stop(handle: JobHandle, _reason?: string): Promise<void> {
    const names = this.namesFor(handle);
    const found = names && (await this.readRecord(names));
    if (!names || !found || isTerminal(found.record.phase)) return;
    await this.api.deletePod(this.namespace, names.pod, STOP_GRACE_SECONDS);
    await this.updateRecord(names, () => ({ phase: "stopped", result: resultFor("stopped") }));
  }

  async remove(handle: JobHandle): Promise<void> {
    const names = this.namesFor(handle);
    const found = names && (await this.readRecord(names));
    if (!names || !found || found.record.phase === "removed") return;
    const record = await this.refresh(names, found.record);
    if (!isTerminal(record.phase)) throw new Error("job_not_terminal");
    await this.api.deletePod(this.namespace, names.pod, 0);
    await this.api.deleteNetworkPolicy(this.namespace, names.policy);
    await this.api.deleteSecret(this.namespace, names.secret);
    // The record stays as a tombstone so the run is never relaunched.
    await this.updateRecord(names, () => ({ phase: "removed" }));
  }

  // -------------------------------------------------------------------------
  // Launch

  /** Memoized: the preflight (or, without one, a single proxy-witness read) runs once per launcher. */
  private runPreflight(): Promise<KubernetesClusterInfo> {
    this.preflightResult ??= (async () => {
      try {
        const provided = (await this.options.preflight?.())?.proxyIp;
        if (provided !== undefined) {
          if (isIP(provided) === 0) throw new Error("kubernetes_proxy_unavailable");
          return { proxyIp: provided };
        }
        const witness = await readProxyWitness(this.api, this.namespace, this.options.config.proxyService);
        return { proxyIp: witness.clusterIp };
      } catch (error) {
        throw errorWithCode(KUBERNETES_ISOLATION_ERROR, error);
      }
    })();
    return this.preflightResult;
  }

  /**
   * Waits until the run's NetworkPolicy is enforced on this pod: the keeper (same network namespace
   * as the worker) must, on ENFORCEMENT_BLOCKED_STREAK consecutive probes 500 ms apart, reach the
   * proxy on CODING_PROXY_PORT and fail to reach it on CODING_PROXY_DENY_PORT. Anything else resets
   * the streak; the wall-clock bound still applies.
   *
   * "Fail to reach" means the connect *timed out* — the packet was dropped. A refusal (RST) is not
   * a denial: it proves the SYN reached the destination host, so the deny port is merely unserved
   * and witnesses nothing. That is its own verdict, below.
   *
   * The verdict at the bound is taken from the *last* probe, not from whether any probe was ever
   * unavailable: an early blip while the pod's networking came up must not send an operator looking
   * at the proxy when the real problem is an unenforced policy. The three non-proven outcomes stay
   * distinct because they send an operator to three different places: the CNI, the proxy pod, and
   * the deny listener.
   *
   * `stage` only changes which error codes a bound produces (see `EnforcementStage`); the probe
   * machinery itself — the script, the streak, the poll interval, the wall-clock bound — is identical
   * for the initial proof and for `provision`'s later re-confirmation immediately before the marker
   * write. That re-confirmation deliberately requires the same full `ENFORCEMENT_BLOCKED_STREAK`
   * consecutive proven probes, not a single one-shot probe: seeding (the window it's guarding) can run
   * for real hours, so the few hundred extra milliseconds a streak costs in the common, still-enforced
   * case is negligible, while a single probe could pass on a lucky sample the same way one dropped SYN
   * must not open the gate at the initial proof either.
   */
  private async waitForPolicyEnforcement(
    names: RunNames,
    proxyIp: string,
    stage: EnforcementStage = "initial",
  ): Promise<void> {
    const command = ["node", "-e", enforcementProbeScript(proxyIp)];
    const started = this.now();
    let blocked = 0;
    for (;;) {
      // `exitCode` is this iteration's probe, and the bound below is only ever reached from here —
      // so the verdict is always the *last* probe's, never a remembered earlier one.
      const exitCode = await this.api.exec(this.namespace, names.pod, KEEPER_CONTAINER, command, {
        timeoutMs: ENFORCEMENT_EXEC_TIMEOUT_MS,
      });
      blocked = exitCode === 0 ? blocked + 1 : 0;
      if (blocked >= ENFORCEMENT_BLOCKED_STREAK) return;
      if (this.now() - started >= this.enforcementTimeoutMs) {
        throw enforcementVerdict(exitCode, proxyIp, stage);
      }
      await this.sleep(ENFORCEMENT_POLL_MS);
    }
  }

  private existingLaunch(record: RunRecord, specHash: string, handle: JobHandle): JobHandle {
    if (record.specHash !== specHash) throw new Error("job_spec_conflict");
    // A still-`provisioning` record is not re-provisioned: another replica may legitimately be mid-launch.
    // If that launch crashed instead, the run is left to the deadline — its pod never opens the gate and
    // is bounded by timeoutSec + POD_DEADLINE_GRACE_SECONDS — and observation then records it timed out or lost.
    return structuredClone(handle);
  }

  private async provision(spec: JobSpec, names: RunNames, record: RunRecord): Promise<void> {
    const { runtimeClassName, priorityClassName, proxyService, platform } = this.options.config;
    if (!runtimeClassName) {
      this.warn(
        "kubernetes_runtime_class_unset: no runtime class configured; coding pods run without gVisor (development clusters only)",
      );
    }
    const capability = await this.options.resolveCapability(spec.runId);
    if (!CAPABILITY.test(capability)) throw new Error("kubernetes_capability_invalid");
    // Re-read (not just the ClusterIP): the gate below reads "deny port unreachable" as evidence,
    // which is only meaningful against a Service that actually exposes it with a ready backend.
    const witness = await readProxyWitness(this.api, this.namespace, proxyService);
    const proxyIp = witness.clusterIp;

    const pod = buildRunPod(spec, {
      namespace: this.namespace,
      proxyIp,
      runtimeClassName,
      priorityClassName,
      platform,
    });
    const policy = buildRunNetworkPolicy(spec, this.namespace);
    await this.createIfMissing(() =>
      this.api.createSecret(this.namespace, buildCapabilitySecret(spec, this.namespace, capability)),
    );
    await this.createIfMissing(() => this.api.createNetworkPolicy(this.namespace, policy));
    await this.createIfMissing(() => this.api.createPod(this.namespace, pod));
    await this.waitForKeeper(names);

    const [actualPod, actualPolicy] = await Promise.all([
      this.api.readPod(this.namespace, names.pod),
      this.api.readNetworkPolicy(this.namespace, names.policy),
    ]);
    if (!actualPod || !actualPolicy) throw new Error(KUBERNETES_ISOLATION_ERROR);
    assertRunPodMatches(actualPod, pod, platform);
    assertRunNetworkPolicyMatches(actualPolicy, policy);
    await this.waitForPolicyEnforcement(names, proxyIp);

    const budget = this.transferBudgetMs(record);
    await this.seedDirectory(names, this.runWorkspace(spec.runId), WORKSPACE_STORAGE, budget);
    await this.seedInput(names, spec.inputArtifact, budget);
    // Never open the gate for a run that was stopped (or otherwise finished) while it was being seeded.
    const current = await this.readRecord(names);
    if (!current || isTerminal(current.record.phase)) throw new Error("kubernetes_launch_superseded");
    // Re-confirm enforcement one last time, with nothing else awaited between this and the marker
    // write below: seeding above ran for real wall-clock time (bounded only by the run's own
    // timeoutSec), and nothing since the initial proof re-checked anything. A NetworkPolicy landing
    // in that window — GitOps drift, a stale re-apply, an unrelated future feature, anything else
    // with NetworkPolicy write access in this namespace — would otherwise silently reopen this pod's
    // egress at the exact moment the untrusted worker is released into it, and this launch would have
    // no way to notice. Re-attesting the run's own NetworkPolicy object cannot catch this (policies
    // are additive: a second policy under a different name is invisible to a comparison against the
    // object this launch built); only re-probing the pod's actual, observed egress can.
    await this.waitForPolicyEnforcement(names, proxyIp, "pre_marker");
    const marker = await this.api.exec(
      this.namespace,
      names.pod,
      KEEPER_CONTAINER,
      ["node", "-e", `require("node:fs").writeFileSync(${JSON.stringify(KEEPER_SEEDED_MARKER)}, "")`],
      { timeoutMs: SHORT_EXEC_TIMEOUT_MS },
    );
    if (marker !== 0) throw new Error("kubernetes_seed_failed");
    const updated = await this.updateRecord(names, () => ({ phase: "active" }));
    // Another replica may have stopped the run mid-launch; don't leave its pod running.
    if (updated.phase !== "active") await this.api.deletePod(this.namespace, names.pod, 0).catch(() => undefined);
  }

  private async createIfMissing(create: () => Promise<unknown>): Promise<void> {
    try {
      await create();
    } catch (error) {
      if (!(error instanceof KubernetesAlreadyExistsError)) throw error;
    }
  }

  private async waitForKeeper(names: RunNames): Promise<void> {
    const started = this.now();
    for (;;) {
      const pod = await this.api.readPod(this.namespace, names.pod);
      if (!pod || pod.status?.phase === "Failed") throw new Error("kubernetes_pod_start_failed");
      const statuses = pod.status?.containerStatuses ?? [];
      const initStatuses = pod.status?.initContainerStatuses ?? [];
      const keeper = statuses.find((status) => status.name === KEEPER_CONTAINER);
      if (
        [...initStatuses, ...statuses].some((status) =>
          FATAL_WAITING_REASONS.has(status.state?.waiting?.reason ?? ""),
        ) ||
        // A failed init container (kubectl's Init:Error) or a keeper that already exited can never become ready.
        initStatuses.some((status) => (status.state?.terminated?.exitCode ?? 0) !== 0) ||
        keeper?.state?.terminated !== undefined
      ) {
        throw new Error("kubernetes_pod_start_failed");
      }
      if (keeper?.ready === true) return;
      if (this.now() - started >= this.readyTimeoutMs) throw new Error("kubernetes_pod_start_timeout");
      await this.sleep(READY_POLL_MS);
    }
  }

  private runWorkspace(runId: string): string {
    const workspace = resolve(this.workspaceRoot, runId, "workspace");
    if (!workspace.startsWith(`${this.workspaceRoot}${sep}`)) throw new Error("kubernetes_workspace_path_invalid");
    return workspace;
  }

  /** Streams a trusted local directory into `destination` inside the keeper. */
  private async seedDirectory(names: RunNames, directory: string, destination: string, timeoutMs: number) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("kubernetes_seed_failed");
    const archive = this.createArchive(directory);
    const archived = archive.done;
    archived.catch(() => undefined);
    try {
      const extracted = await this.api.exec(
        this.namespace,
        names.pod,
        KEEPER_CONTAINER,
        ["tar", "-C", destination, "--no-same-owner", "--no-same-permissions", "-xf", "-"],
        { stdin: archive.stream, timeoutMs },
      );
      // On a failed extract, the archive is destroyed (in the catch) before anything waits on it,
      // so an archive nobody drains can't hang the launch.
      if (extracted !== 0) throw new Error("kubernetes_seed_failed");
      if ((await archived) !== 0) throw new Error("kubernetes_seed_failed");
    } catch (error) {
      archive.stream.destroy();
      if (error instanceof Error && error.message === "kubernetes_seed_failed") throw error;
      throw errorWithCode("kubernetes_seed_failed", error);
    }
  }

  private async seedInput(names: RunNames, inputArtifact: string, timeoutMs: number): Promise<void> {
    const staging = await mkdtemp(join(tmpdir(), "wardby-k8s-input-"));
    try {
      const source = await lstat(inputArtifact);
      if (!source.isFile() || source.size > MAX_CODING_ARTIFACT_BYTES) {
        throw new Error("kubernetes_input_artifact_invalid");
      }
      const copy = join(staging, "input.json");
      await copyFile(inputArtifact, copy);
      // Re-check the copy: the source could have changed between lstat and copy.
      const copied = await lstat(copy);
      if (!copied.isFile() || copied.size > MAX_CODING_ARTIFACT_BYTES) {
        throw new Error("kubernetes_input_artifact_invalid");
      }
      await this.seedDirectory(names, staging, INPUT_STORAGE, timeoutMs);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async cleanupRun(names: RunNames, podGraceSeconds: number): Promise<void> {
    await this.api.deletePod(this.namespace, names.pod, podGraceSeconds).catch(() => undefined);
    await this.api.deleteNetworkPolicy(this.namespace, names.policy).catch(() => undefined);
    await this.api.deleteSecret(this.namespace, names.secret).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Observation and collection

  /** Observes a non-terminal run against its pod and persists any transition; returns the stored record. */
  private async refresh(names: RunNames, record: RunRecord): Promise<RunRecord> {
    if (isTerminal(record.phase)) return record;
    const pod = await this.api.readPod(this.namespace, names.pod);
    const observed = observePod(pod, record, this.now(), this.readyTimeoutMs);
    if (!observed) return record;
    if (observed.deleteGraceSeconds !== undefined) {
      await this.api.deletePod(this.namespace, names.pod, observed.deleteGraceSeconds);
    }
    return this.updateRecord(names, () => ({ phase: observed.phase, result: observed.result }));
  }

  /** Reads only a fixed diagnostic code from a failed worker's bounded log tail; never keeps anything else. */
  private async readWorkerDiagnostic(names: RunNames): Promise<WorkerDiagnostic | undefined> {
    let raw: string;
    try {
      raw = await this.api.readLogTail(
        this.namespace,
        names.pod,
        WORKER_CONTAINER,
        DIAGNOSTIC_TAIL_LINES,
        DIAGNOSTIC_LIMIT_BYTES,
      );
    } catch {
      // Diagnostics are optional (the pod may already be gone after a timeout).
      return undefined;
    }
    for (const line of raw.split("\n").reverse()) {
      const diagnostic = parseWorkerDiagnosticLine(line);
      if (diagnostic) return diagnostic;
    }
    return undefined;
  }

  private async readResultArtifact(names: RunNames, runId: string): Promise<string> {
    const collector = new BoundedCollector(MAX_CODING_ARTIFACT_BYTES);
    let raw: string;
    try {
      const exitCode = await this.api.exec(
        this.namespace,
        names.pod,
        KEEPER_CONTAINER,
        ["head", "-c", String(MAX_CODING_ARTIFACT_BYTES + 1), RESULT_PATH],
        { stdout: collector, timeoutMs: SHORT_EXEC_TIMEOUT_MS },
      );
      if (!collector.writableEnded) collector.end();
      await finished(collector);
      if (exitCode !== 0 || collector.exceeded) throw new Error("kubernetes_result_artifact_invalid");
      raw = collector.text();
    } catch (error) {
      collector.destroy();
      if (error instanceof Error && error.message === "kubernetes_result_artifact_invalid") throw error;
      throw errorWithCode("kubernetes_result_artifact_invalid", error);
    }
    let output: ReturnType<typeof parseCodingAgentOutputJson>;
    try {
      output = parseCodingAgentOutputJson(raw);
    } catch (error) {
      throw errorWithCode("kubernetes_result_artifact_invalid", error);
    }
    if (output.runId !== runId) throw new Error("kubernetes_result_run_mismatch");
    return JSON.stringify(output);
  }

  /**
   * Streams the keeper's workspace through the strict extractor into `staging`.
   * The transfer is bounded by `timeoutMs` (see transferBudgetMs): on expiry the
   * extraction is aborted. On any failure the output stream this method created
   * is destroyed, since the exec's own timeout does not end it. Excluded dependency
   * and cache paths never leave the pod (see src/coding/collect-exclude.ts).
   */
  private async extractWorkspace(
    names: RunNames,
    staging: string,
    maxBytes: number,
    timeoutMs: number,
    exclusions: CollectExclusions,
  ) {
    const output = new PassThrough();
    // Errors are surfaced through the exec/extraction promises; never let a late destroy() crash the process.
    output.on("error", () => undefined);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    const extraction = safeExtract(
      output,
      staging,
      { maxBytes, maxEntries: MAX_WORKSPACE_ENTRIES },
      {
        signal: controller.signal,
      },
    );
    const execution = this.api
      .exec(
        this.namespace,
        names.pod,
        KEEPER_CONTAINER,
        ["tar", "-C", WORKSPACE_STORAGE, ...tarExcludeArgs(exclusions), "-cf", "-", "."],
        { stdout: output, timeoutMs },
      )
      .then((exitCode) => {
        if (exitCode !== 0) throw new Error("kubernetes_workspace_archive_failed");
        if (!output.writableEnded) output.end();
      });
    // Unblock the extractor as soon as the exec fails, rather than waiting for the deadline.
    execution.catch((error: unknown) => output.destroy(error instanceof Error ? error : new Error(String(error))));
    try {
      await Promise.all([extraction, execution]);
    } catch (error) {
      controller.abort();
      output.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Time allowed for one workspace/input transfer: the run's full timeout
   * (deadlineAt - createdAt), measured from when the transfer starts. The
   * remaining run deadline is not used because collection legitimately
   * happens after a run has finished close to (or past) its deadline.
   */
  private transferBudgetMs(record: RunRecord): number {
    return Math.max(1000, record.deadlineAt - record.createdAt);
  }

  // -------------------------------------------------------------------------
  // Records

  private namesFor(handle: JobHandle): RunNames | undefined {
    if (handle.backend !== BACKEND || typeof handle.id !== "string") return undefined;
    const [namespace, token, ...rest] = handle.id.split("/");
    if (rest.length > 0 || namespace !== this.namespace || !token || !TOKEN.test(token)) return undefined;
    return kubernetesRunNamesForToken(token);
  }

  private recordConfigMap(names: RunNames, record: RunRecord, resourceVersion?: string): V1ConfigMap {
    return {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: names.record,
        namespace: this.namespace,
        labels: runLabels(record.runId),
        annotations: { "wardby.io/run-id": record.runId },
        ...(resourceVersion ? { resourceVersion } : {}),
      },
      data: { [RECORD_KEY]: JSON.stringify(record) },
    };
  }

  private async readRecord(names: RunNames): Promise<{ record: RunRecord; resourceVersion?: string } | undefined> {
    const configMap = await this.api.readConfigMap(this.namespace, names.record);
    if (!configMap) return undefined;
    const record = parseRecord(configMap);
    // The record must belong to the run its name was derived from.
    if (kubernetesRunNames(record.runId).token !== names.token) throw new Error("kubernetes_record_invalid");
    return { record, resourceVersion: configMap.metadata?.resourceVersion };
  }

  /**
   * Applies a transition with optimistic concurrency, retrying on conflict.
   * `transition` sees the freshly read record and returns the new phase/result
   * (or `undefined` for no change). A terminal record never moves to another
   * phase except `removed`; it may only have its result filled in.
   */
  private async updateRecord(
    names: RunNames,
    transition: (current: RunRecord) => { phase: Phase; result?: JobResult } | undefined,
  ): Promise<RunRecord> {
    for (let attempt = 0; attempt < MAX_RECORD_ATTEMPTS; attempt += 1) {
      const found = await this.readRecord(names);
      if (!found) throw new Error("job_not_found");
      const current = found.record;
      const next = transition(current);
      if (!next) return current;
      const regresses = isTerminal(current.phase) && next.phase !== current.phase && next.phase !== "removed";
      if (regresses || current.phase === "removed") return current;
      const updated: RunRecord = { ...current, phase: next.phase };
      if (next.result) updated.result = next.result;
      try {
        await this.api.replaceConfigMap(
          this.namespace,
          names.record,
          this.recordConfigMap(names, updated, found.resourceVersion),
        );
        return updated;
      } catch (error) {
        if (!(error instanceof KubernetesConflictError)) throw error;
      }
    }
    throw new Error("kubernetes_record_conflict");
  }
}
