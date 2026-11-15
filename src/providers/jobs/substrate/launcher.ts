/**
 * SubstrateJobLauncher (JOB_LAUNCHER=substrate, experimental): runs one Claude Code coding job as
 * two Agent Substrate actors — the agent (the worker) and the tool (the credential-free tool
 * runner, which holds the workspace) — built from shared, secret-free templates. A Codex job runs
 * as one actor (the single shape, recorded on the row as actorShape): the agent, whose Codex bridge
 * runs the unchanged Codex worker and holds the workspace, with the agent's egress rule only. Codex
 * runs never park or adopt (warm rounds are Claude Code only).
 *
 * - The capability lives only in a per-run Kubernetes Secret, which Substrate's egress gateway reads
 *   to inject the agent's X-Api-Key on its way to the coding proxy. The tool actor authenticates with
 *   its own actor JWT, also injected by the gateway. Neither actor ever holds a wardby secret.
 * - Nothing is exec'd into an actor. Data moves through the blob store, served to the actors by the
 *   coding proxy: the launcher stages `input`, `toolSetup` (the run's registry-only token: its only
 *   home) and `seed`; the actors post `result`, `transcript`, `workspace`, and the proxy writes
 *   `exit` (with the worker's own diagnostic, if it printed one), `done` and `started`.
 * - The `SubstrateRun` row is the launch fence (a second launch of the same run finds it) and the
 *   phase record. Completion is reported, not observed: `done` with a parseable `result`, written by
 *   the deadline (plus 5 s of clock skew), is success; a later one is a timeout.
 *   Outcomes the launcher observes itself (timeout, a lost or crashed actor, a failed provisioning)
 *   are written to the row's phase, so a terminal state never changes afterwards.
 * - Warm rounds (SUBSTRATE_WARM_ROUNDS, experimental; off by default, and then nothing below
 *   applies): retain() of a succeeded, delivered run suspends its actors, deletes its Secret and
 *   parks it with the commit it pushed and its agent's fingerprint (at most parkMax parks, the oldest
 *   removed first); remove() always removes. A continuation naming that run (JobSpec.warm) with the
 *   same commit and fingerprint adopts the actors (its row takes the parked token and the next round,
 *   per-round files `-<n>`, a fresh Secret with the new capability, both actors resume) and the
 *   bridges run the next round on the same workspace and the same Claude Code session; any mismatch
 *   removes the park and launches cold, with the reason on the row (warmOutcome). Parks never block
 *   a launch: with no room, the oldest are removed first. Handles are then `<atespace>/<runId>`: the
 *   token, and the round, are always read from the run's row (never derived from the run id).
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { collectExclusions } from "../../../coding/collect-exclude.js";
import {
  MAX_CODING_ARTIFACT_BYTES,
  MAX_CODING_INPUT_BYTES,
  parseCodingWorkerOutputJson,
} from "../../../coding/protocol.js";
import type { CodingProvider } from "../../../coding/provider.js";
import type { RelayStore } from "../../coding-proxy/substrate/relay-store.js";
import { logger } from "../../../core/logger.js";
import { BlobStoreError, type BlobStore } from "../../storage/types.js";
import { claudeToolSetup } from "../claude-tool-setup.js";
import { codexWorkerSetup } from "../codex-worker-setup.js";
import { isRepositoryDigest } from "../docker-isolation.js";
import { KubernetesAlreadyExistsError, KubernetesNotFoundError, type KubernetesApi } from "../kubernetes-api.js";
import { RUN_ID } from "../kubernetes-isolation.js";
import { CAPABILITY, FINISHED_AT_SKEW_MS, hostTarArchive, stableSpecHash } from "../kubernetes.js";
import { safeExtract } from "../safe-extract.js";
import {
  JobCapacityError,
  WARM_FINGERPRINT,
  WARM_HEAD_SHA,
  type JobHandle,
  type JobResult,
  type JobRetention,
  type JobSpec,
  type JobStatus,
  type MaterializedWorkspace,
  type MaterializeWorkspaceOptions,
  type WarmColdReason,
  type WarmOutcome,
  type WorkspaceJobLauncher,
} from "../types.js";
import { workerDiagnosticOf, type WorkerDiagnostic } from "../worker-diagnostic.js";
import { replaceDirectoryFromStaging, takeResultBundle } from "../workspace-swap.js";
import {
  SubstrateAlreadyExistsError,
  SubstrateExhaustedError,
  SubstrateNotFoundError,
  SubstrateUnavailableError,
  type ActorTemplateSpec,
  type SubstrateApi,
} from "./api.js";
import {
  BLOB,
  ROUND_BLOBS,
  actorNamesFor,
  agentActorName,
  roundBlob,
  substrateRunToken,
  toolActorName,
} from "./names.js";
import { canPlaceAll, type Room } from "./placement.js";
import type { SubstrateActorShape, SubstratePhase, SubstrateRunRecord, SubstrateRunStore } from "./run-store.js";
import {
  agentEgress,
  agentTemplate,
  codexTemplate,
  runSecret,
  toolEgress,
  toolTemplate,
  type SubstrateLaunchConfig,
} from "./specs.js";

export interface SubstrateJobLauncherOptions {
  api: SubstrateApi;
  runs: SubstrateRunStore;
  blobs: BlobStore;
  secrets: Pick<KubernetesApi, "createSecret" | "deleteSecret">;
  /** The proxy's tool relay: a removed run's channels and queued lines are deleted with it. */
  relay: Pick<RelayStore, "purgeRelay">;
  config: SubstrateLaunchConfig;
  /**
   * The tool-runner images the deployment configures (CODING_CLAUDE_TOOL_RUNNER_IMAGE and its
   * per-toolchain variants), which carry the Substrate tool bridge. Any other tool image is an
   * agent's custom image (workerImageRef), which has no bridge: refused.
   */
  bridgeToolImages: readonly string[];
  /**
   * The Codex images the deployment configures (CODING_WORKER_IMAGE and its per-toolchain variants),
   * built on the Substrate Codex bridge. Any other Codex image is an agent's custom image
   * (workerImageRef), which has no bridge: refused. Absent: none, so every Codex run is refused.
   */
  bridgeCodexImages?: readonly string[];
  /** Same root the VCS provider prepares workspaces under (as the Kubernetes launcher's). */
  workspaceRoot: string;
  resolveCapability: (runId: string) => Promise<string>;
  now?: () => number;
  /** Where a failed Substrate call during a launch is reported (default: the server log, as a warning). */
  onSubstrateCallFailed?: (failure: SubstrateCallFailure) => void;
  /**
   * How long after the worker's exit report (`exit`) the workspace (`done`) may take before the run
   * fails as substrate_collect_timeout (default 120 s): a tool side that died never sends it.
   */
  collectGraceMs?: number;
  /**
   * How long a running run may go without both actors reaching the proxy (the agent's first input
   * download, the tool's first events poll) before it fails as substrate_startup_timeout (default 300 s).
   */
  startupTimeoutMs?: number;
  /**
   * Warm rounds (SUBSTRATE_WARM_ROUNDS, experimental): retain() parks a succeeded run's suspended
   * actors, and a continuation of that run adopts them (same actors, same workspace, the same Claude
   * Code session). Absent: every behaviour is unchanged (retain() removes).
   */
  warmRounds?: WarmRoundsOptions;
  /** Where warm-round steps are reported with their timings (default: the server log, at info). */
  onWarmEvent?: (event: WarmEvent) => void;
}

export interface WarmRoundsOptions {
  /** How long a parked run waits for a follow-up before a sweep removes it. */
  parkTtlMs: number;
  /** At most this many runs parked at once (SUBSTRATE_PARK_MAX); the oldest go first. 0: never park. */
  parkMax: number;
}

/** Why a park was removed to make room: for a launch (`capacity`) or for a newer park (`park_max`). */
export type WarmEvictReason = "capacity" | "park_max";
/** Why an agent's parks were removed (WorkspaceJobLauncher.removeParked): its caller's lifecycle event. */
export type WarmRemoveReason = "agent";

/**
 * A warm-round step, fixed fields only (never a capability, a commit, a fingerprint, a request or a
 * message). `ms` is the step's duration; `reason` a fixed code: a WarmColdReason on
 * substrate_warm_not_adopted, a WarmEvictReason on substrate_warm_evicted, a WarmRemoveReason on
 * substrate_warm_removed.
 */
export interface WarmEvent {
  event:
    | "substrate_warm_parked"
    | "substrate_warm_park_failed"
    | "substrate_warm_adopted"
    | "substrate_warm_not_adopted"
    | "substrate_warm_evicted"
    | "substrate_warm_expired"
    | "substrate_warm_removed";
  runId: string;
  /** The parked actors' token (absent when there was no park to name). */
  runToken?: string;
  round?: number;
  adoptedRunId?: string;
  reason?: WarmColdReason | WarmEvictReason | WarmRemoveReason;
  ms?: number;
  steps?: Record<string, number>;
}

/** How often launch() and hasCapacityFor() may look for expired parked runs. */
const SWEEP_INTERVAL_MS = 30_000;

export const DEFAULT_COLLECT_GRACE_MS = 120_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;

/** The Substrate calls a launch makes, by SubstrateApi method name. */
export type SubstrateCall =
  | "ensureActorTemplate"
  | "getActorTemplate"
  | "deleteActorTemplate"
  | "createActor"
  | "putEgressPolicy"
  | "resumeActor"
  | "suspendActor"
  | "deleteEgressPolicy";

/** Fixed fields only: the run, which call failed, and the error's fixed code. Never a request or message. */
export interface SubstrateCallFailure {
  runId: string;
  substrateCall: SubstrateCall;
  errorCode: string;
}

const substrateLog = logger.child({ module: "substrate-jobs" });

const BACKEND = "substrate";
const TOKEN = /^wr-[0-9a-f]{20}$/;
const MIB = 1024 * 1024;
const MAX_WORKSPACE_ENTRIES = 100_000;
/** done.json is a few bytes; anything bigger is not ours. */
const MAX_MARKER_BYTES = 4096;
/** exit.json: a code and the worker's diagnostic (the proxy accepts at most 8 KiB). */
const MAX_EXIT_BYTES = 8 * 1024;
const ACTIVE_PHASES: readonly SubstratePhase[] = ["provisioning", "running", "requeued"];
const LIVE_PHASES: SubstratePhase[] = ["provisioning", "running"];

/** The round a row's actors are on (the row records it; round.json is the bridges' and the proxy's copy). */
/**
 * Whether the worker input asks for git history (CodingTaskInput.gitHistory, written only on such a
 * run). An input that does not parse counts as none: the bridge then uploads the whole workspace, as
 * before, and the worker refuses the input itself.
 */
export function inputHasGitHistory(input: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(input.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const history = (parsed as { gitHistory?: unknown }).gitHistory;
    return typeof history === "object" && history !== null;
  } catch {
    return false;
  }
}

function roundOf(record: SubstrateRunRecord): number {
  return record.round ?? 1;
}

/** The row's actor shape; a row from before the shape was recorded is a pair. */
function shapeOf(record: SubstrateRunRecord): SubstrateActorShape {
  return record.actorShape ?? "pair";
}

interface Observation {
  status: JobStatus;
  /** Present exactly when the job is terminal. */
  result?: JobResult;
}

/** The outcome of each terminal phase the launcher recorded itself. */
const RECORDED: Partial<Record<SubstratePhase, Observation>> = {
  stopped: { status: { state: "stopped" }, result: { exitCode: 143, reason: "stopped" } },
  timed_out: { status: { state: "failed", reason: "timed_out" }, result: { exitCode: 124, reason: "timed_out" } },
  lost: { status: { state: "lost" }, result: { exitCode: 1, reason: "lost" } },
  crashed: { status: { state: "failed" }, result: { exitCode: 1, reason: "failed" } },
  // Docker's and Kubernetes's code for the same event: the tool runner is gone.
  tool_failed: {
    status: { state: "failed" },
    result: { exitCode: 1, reason: "failed", diagnostic: "worker_tool_runner_failed" },
  },
  provisioning_failed: {
    status: { state: "failed" },
    result: { exitCode: 1, reason: "failed", diagnostic: "substrate_provisioning_failed" },
  },
  startup_timeout: {
    status: { state: "failed" },
    result: { exitCode: 1, reason: "failed", diagnostic: "substrate_startup_timeout" },
  },
  // collect_timeout: its result carries the worker's exit report (see observe).
  // Warm rounds: a run whose parked actors another run took over had succeeded.
  adopted: { status: { state: "succeeded" }, result: { exitCode: 0, reason: "completed" } },
};

/** The blobs observe() reads an outcome from besides `done`, which remove() deletes after them. */
const OUTCOME_BLOBS: readonly ((token: string, round?: number) => string)[] = [BLOB.result, BLOB.exit];
/** The per-round names among ROUND_BLOBS that carry a round's outcome (deleted last). */
const OUTCOME_ROUND_BLOBS: readonly (typeof ROUND_BLOBS)[number][] = ["result", "exit", "done"];

/** Outcomes whose actors are deleted when recorded: the run must not keep running. */
const STOP_ACTORS_ON: readonly SubstratePhase[] = ["timed_out", "collect_timeout", "startup_timeout"];

/** The fixed code of a failed Substrate call; any other error is "unexpected" (its message is never read). */
function substrateErrorCode(error: unknown): string {
  if (
    error instanceof SubstrateAlreadyExistsError ||
    error instanceof SubstrateExhaustedError ||
    error instanceof SubstrateNotFoundError ||
    error instanceof SubstrateUnavailableError
  ) {
    return error.code;
  }
  return "unexpected";
}

function isPhaseConflict(error: unknown): boolean {
  return error instanceof Error && error.message === "substrate_phase_conflict";
}

/** Starts every step, waits for all of them, then throws the first failure, if any. */
async function settleAll(steps: (() => Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(steps.map((step) => Promise.resolve().then(step)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

function isBlobNotFound(error: unknown): boolean {
  return error instanceof BlobStoreError && error.code === "not_found";
}

const UNSUPPORTED_FEATURES = ["services", "mcpTools", "dependencyCache", "repositories"] as const;

function refuseUnsupportedFeatures(spec: JobSpec): void {
  for (const feature of UNSUPPORTED_FEATURES) {
    if (spec[feature] !== undefined) throw new Error(`substrate_feature_unsupported:${feature}`);
  }
}

/**
 * Substrate runs Claude Code (two actors) and Codex (one), without the features that need more
 * actors or extra secrets, and only on the configured bridge images (a custom image has no bridge):
 * Claude Code's tool image among the tool images, Codex's image among the Codex images.
 */
function validateSpec(spec: JobSpec, images: { tool: readonly string[]; codex: readonly string[] }): void {
  if (spec.kind !== "coding-agent" || !RUN_ID.test(spec.runId)) throw new Error("substrate_spec_invalid");
  validateWarm(spec);
  if (spec.provider === "claude-code") {
    if (!isRepositoryDigest(spec.image) || spec.toolImage === undefined || !isRepositoryDigest(spec.toolImage)) {
      throw new Error("substrate_image_not_digest");
    }
    refuseUnsupportedFeatures(spec);
    if (!images.tool.includes(spec.toolImage)) throw new Error("substrate_feature_unsupported:workerImage");
  } else if (spec.provider === "codex") {
    if (!isRepositoryDigest(spec.image)) throw new Error("substrate_image_not_digest");
    // One actor: a tool image has nowhere to run.
    if (spec.toolImage !== undefined) throw new Error("substrate_spec_invalid");
    refuseUnsupportedFeatures(spec);
    if (!images.codex.includes(spec.image)) throw new Error("substrate_feature_unsupported:workerImage");
  } else {
    throw new Error("substrate_provider_unsupported");
  }
}

function validateWarm(spec: JobSpec): void {
  const warm = spec.warm;
  if (
    warm !== undefined &&
    (typeof warm !== "object" ||
      warm === null ||
      typeof warm.fromRunId !== "string" ||
      !RUN_ID.test(warm.fromRunId) ||
      typeof warm.headSha !== "string" ||
      !WARM_HEAD_SHA.test(warm.headSha) ||
      typeof warm.fingerprint !== "string" ||
      !WARM_FINGERPRINT.test(warm.fingerprint))
  ) {
    throw new Error("substrate_spec_invalid");
  }
}

function validRetention(retention: JobRetention): boolean {
  return (
    typeof retention === "object" &&
    retention !== null &&
    typeof retention.headSha === "string" &&
    WARM_HEAD_SHA.test(retention.headSha) &&
    typeof retention.fingerprint === "string" &&
    WARM_FINGERPRINT.test(retention.fingerprint)
  );
}

/** Parks oldest first; a park without parkedAt (from before it was recorded) counts as the oldest. */
function oldestFirst(parks: SubstrateRunRecord[]): SubstrateRunRecord[] {
  return [...parks.filter((park) => !park.parkedAt), ...parks.filter((park) => park.parkedAt)];
}

/** A run's templates: the agent's and the tool's (pair), or the one agent actor's (single). */
type RunTemplates =
  { shape: "pair"; agent: ActorTemplateSpec; tool: ActorTemplateSpec } | { shape: "single"; agent: ActorTemplateSpec };

/** The templates of every actor of the run. */
function actorTemplates(templates: RunTemplates): ActorTemplateSpec[] {
  return templates.shape === "pair" ? [templates.agent, templates.tool] : [templates.agent];
}

/** Whether every actor of the run can be placed in `free`; true when the room is unknown (the launch decides). */
function placeable(free: Room[] | undefined, templates: RunTemplates): boolean {
  if (!free) return true;
  const size = (t: ActorTemplateSpec) => ({ cpuMillicores: t.cpuMillicores, memoryBytes: t.memoryBytes });
  return canPlaceAll(free, actorTemplates(templates).map(size));
}

/** Whether the workers' total free CPU or memory went up from `before` to `after`. */
function grew(before: Room[], after: Room[]): boolean {
  const total = (rooms: Room[], key: keyof Room) => rooms.reduce((sum, room) => sum + room[key], 0);
  return (
    total(after, "cpuMillicores") > total(before, "cpuMillicores") ||
    total(after, "memoryBytes") > total(before, "memoryBytes")
  );
}

export class SubstrateJobLauncher implements WorkspaceJobLauncher {
  private readonly api: SubstrateApi;
  private readonly runs: SubstrateRunStore;
  private readonly blobs: BlobStore;
  private readonly config: SubstrateLaunchConfig;
  private readonly workspaceRoot: string;
  private readonly now: () => number;
  private readonly collectGraceMs: number;
  private readonly startupTimeoutMs: number;
  private readonly warm: WarmRoundsOptions | undefined;
  /** WorkspaceJobLauncher.warmRounds: set from the configuration (warm rounds on). */
  readonly warmRounds: boolean;
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: SubstrateJobLauncherOptions) {
    this.api = options.api;
    this.runs = options.runs;
    this.blobs = options.blobs;
    this.warm = options.warmRounds;
    this.warmRounds = this.warm !== undefined;
    // Warm rounds switch the bridges through the templates' env (so they get their own templates).
    this.config = this.warm ? { ...options.config, warmRounds: true } : options.config;
    this.workspaceRoot = resolve(options.workspaceRoot);
    if (this.workspaceRoot === resolve("/")) throw new Error("substrate_launcher_path_invalid");
    this.now = options.now ?? Date.now;
    this.collectGraceMs = options.collectGraceMs ?? DEFAULT_COLLECT_GRACE_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  /** Phase A: no coding-run services on Substrate. */
  supportsServicesFor(_provider: CodingProvider): boolean {
    return false;
  }

  plannedHandle(spec: JobSpec): JobHandle | undefined {
    try {
      this.templatesFor(spec);
      return this.handleFor(spec.runId);
    } catch {
      // An invalid spec has no handle; launch() rejects with the real reason.
      return undefined;
    }
  }

  /**
   * Whether the run's actors (both, or a Codex run's one) can be placed now on the workers the
   * configured selector matches, by free CPU and memory (Substrate packs many actors per worker):
   * the larger first on the worker with the most free room, then the other, on the same worker or
   * another. No workers: false. Any error (an unbuildable spec, an unreachable API): true, so the
   * launch itself decides (a refusal there is a JobCapacityError).
   */
  async hasCapacityFor(spec: JobSpec): Promise<boolean> {
    await this.sweepParkedSometimes();
    let templates: RunTemplates;
    try {
      templates = this.templatesFor(spec);
    } catch {
      return true;
    }
    if (await this.fits(templates)) return true;
    // Warm rounds: parks never block a run; the oldest go until it fits (never the one it continues).
    return this.warm ? this.evictUntilFits(templates, spec.warm?.fromRunId) : false;
  }

  async launch(spec: JobSpec): Promise<JobHandle> {
    const templates = this.templatesFor(spec);
    const token = substrateRunToken(spec.runId);
    const specHash = stableSpecHash(spec);
    const deadline = () => new Date(this.now() + spec.timeoutSec * 1000);
    let coldReason: WarmColdReason | undefined;
    // Removal of kept rounds never depends on the switch (warm rounds off: every one goes).
    await this.sweepParkedSometimes();
    // A single-shape (Codex) run never adopts: it always launches cold, with no cold reason.
    if (this.warm && templates.shape === "pair") {
      // A relaunch of a run that has a row keeps whatever that row says.
      if (!(await this.runs.get(spec.runId))) {
        if (!(await this.fits(templates))) await this.evictUntilFits(templates, spec.warm?.fromRunId);
        const outcome = await this.adoptParked(spec, specHash, deadline());
        if (outcome?.adopted) return this.handleFor(spec.runId);
        coldReason = outcome?.reason;
      }
    }
    const claimed = await this.runs.claim({
      runId: spec.runId,
      token,
      specHash,
      phase: "provisioning",
      deadlineAt: deadline(),
      actorShape: templates.shape,
      ...(spec.agentId !== undefined ? { agentId: spec.agentId } : {}),
      ...(coldReason !== undefined ? { coldReason } : {}),
    });
    const handle = this.handleFor(spec.runId);
    if (!claimed.created) {
      if (claimed.record.specHash !== specHash) throw new Error("job_spec_conflict");
      // Any phase but requeued: another launch owns (or owned) this run; never relaunch it. A
      // still-provisioning row whose launch crashed is left to its deadline, as on Kubernetes.
      if (claimed.record.phase !== "requeued") return handle;
      // Refused for capacity before: provision afresh (round 1), unless another replica just did. A
      // refused adopter (it holds the parked run's token) relaunches cold, for capacity.
      const refusedAdopter = claimed.record.token !== token;
      const fields = refusedAdopter ? { coldReason: "capacity" as const } : {};
      if (!(await this.runs.reclaim(spec.runId, deadline(), fields))) return handle;
    }
    // An adopter refused for capacity keeps the parked run's token on its row (warm rounds).
    await this.provision(spec, claimed.record.token, templates);
    return handle;
  }

  async status(handle: JobHandle): Promise<JobStatus> {
    return structuredClone((await this.observe(await this.requireRecord(handle))).status);
  }

  async collect(handle: JobHandle): Promise<JobResult> {
    const observed = await this.observe(await this.requireRecord(handle));
    if (!observed.result) throw new Error("job_not_terminal");
    return structuredClone(observed.result);
  }

  /**
   * Extracts the tool actor's posted workspace tar into the run's own folder. With `gitHistory`
   * (#536), as on Docker: the root `.git`'s result bundle is taken to `bundleDestination` and the
   * root `.git` dropped before validation, so a nested `.git` elsewhere is still refused; without
   * it, a `.git` anywhere is refused.
   */
  async materializeWorkspace(
    handle: JobHandle,
    destination: string,
    name?: string,
    options: MaterializeWorkspaceOptions = {},
  ): Promise<MaterializedWorkspace> {
    // Phase A has no extra repositories, so there is never a named one to collect.
    if (name !== undefined) throw new Error("substrate_workspace_destination_invalid");
    const record = await this.requireRecord(handle);
    if ((await this.observe(record)).status.state !== "succeeded") throw new Error("job_not_succeeded");
    const expected = resolve(this.workspaceRoot, record.runId, "workspace");
    if (resolve(destination) !== expected || !expected.startsWith(`${this.workspaceRoot}${sep}`)) {
      throw new Error("substrate_workspace_destination_invalid");
    }
    const key = BLOB.workspace(record.token, roundOf(record));
    const info = await this.blobs.head(key);
    if (!info) throw new Error("substrate_workspace_missing");
    // The archive holds every extracted byte plus headers, so its size bounds the tree.
    const maxBytes = info.sizeBytes;
    const gitHistory = options.gitHistory && {
      ...options.gitHistory,
      // A bundle never exceeds the collected workspace that carries it, whatever the configured limit.
      maxBundleBytes: Math.min(options.gitHistory.maxBundleBytes, maxBytes),
    };
    if (gitHistory && (!Number.isSafeInteger(gitHistory.maxBundleBytes) || gitHistory.maxBundleBytes <= 0)) {
      throw new Error("job_result_bundle_limit_invalid");
    }
    let bundle = false;
    try {
      await replaceDirectoryFromStaging(
        expected,
        maxBytes,
        "substrate_workspace_destination_invalid",
        async (staging) => {
          const body = await this.blobs.getStream(key);
          const source = body instanceof Readable ? body : Readable.from(body as AsyncIterable<Buffer>);
          await safeExtract(source, staging, { maxBytes, maxEntries: MAX_WORKSPACE_ENTRIES });
          // A history run's root .git leaves the copy here, its bundle kept; validation then never sees it.
          if (gitHistory) bundle = await takeResultBundle(staging, gitHistory);
        },
      );
    } catch (error) {
      // A workspace that was not collected leaves no bundle behind either.
      if (bundle && gitHistory) await rm(gitHistory.bundleDestination, { force: true });
      throw error;
    }
    return { bundle };
  }

  async readTranscript(handle: JobHandle, maxBytes: number): Promise<string | undefined> {
    const record = await this.recordFor(handle);
    if (!record || record.phase === "removed") return undefined;
    const key = BLOB.transcript(record.token, roundOf(record));
    const info = await this.blobs.head(key);
    if (!info) return undefined;
    if (info.sizeBytes > maxBytes) throw new Error("transcript_too_large");
    let body: Buffer;
    try {
      body = await this.blobs.get(key);
    } catch (error) {
      if (isBlobNotFound(error)) return undefined;
      throw error;
    }
    if (body.length > maxBytes) throw new Error("transcript_too_large");
    return body.toString("utf8");
  }

  async stop(handle: JobHandle, _reason?: string): Promise<void> {
    const record = await this.recordFor(handle);
    if (!record || !ACTIVE_PHASES.includes(record.phase)) return;
    // Already finished by report: stopping now changes nothing.
    if (await this.reported(record)) return;
    try {
      await this.runs.setPhase(record.runId, "stopped", [...ACTIVE_PHASES]);
    } catch (error) {
      // Moved on meanwhile (finished, timed out, removed): nothing to stop.
      if (isPhaseConflict(error)) return;
      throw error;
    }
    await this.deleteActors(record.token, shapeOf(record));
  }

  async remove(handle: JobHandle): Promise<void> {
    const record = await this.recordFor(handle);
    if (!record || record.phase === "removed") return;
    // Its actors and files belong to the run that adopted them.
    if (record.phase === "adopted") {
      await this.runs.setPhase(record.runId, "removed", ["adopted"]);
      return;
    }
    // Warm rounds: a parked run is removed in full; one a continuation just adopted, as adopted.
    if (record.phase === "parked") {
      if (!(await this.removeParkedRun(record))) await this.remove(handle);
      return;
    }
    const observed = await this.observe(record);
    if (!observed.result) throw new Error("job_not_terminal");
    // Every deletion is tried even when one fails; the first failure is reported and the run is
    // not marked removed, so a later remove() tries again.
    await this.removeInFull(record.token, roundOf(record), shapeOf(record));
    // The row stays as the tombstone, so the run is never relaunched.
    await this.runs.setPhase(record.runId, "removed");
  }

  // -------------------------------------------------------------------------
  // Launch

  private templatesFor(spec: JobSpec): RunTemplates {
    validateSpec(spec, { tool: this.options.bridgeToolImages, codex: this.options.bridgeCodexImages ?? [] });
    if (spec.provider === "codex") return { shape: "single", agent: codexTemplate(spec, this.config) };
    return { shape: "pair", agent: agentTemplate(spec, this.config), tool: toolTemplate(spec, this.config) };
  }

  /**
   * `<atespace>/<token>` (Phase A, unchanged); with warm rounds `<atespace>/<runId>`, because an
   * adopter's token is the parked run's, which only its row records.
   */
  private handleFor(runId: string): JobHandle {
    return {
      backend: BACKEND,
      id: this.warm ? `${this.config.atespace}/${runId}` : `${this.config.atespace}/${substrateRunToken(runId)}`,
    };
  }

  private async provision(spec: JobSpec, token: string, templates: RunTemplates): Promise<void> {
    const { atespace } = this.config;
    const { shape } = templates;
    const agent = agentActorName(token);
    const tool = toolActorName(token);
    // Each Substrate call is named when it fails, so a refusal is diagnosable from wardby's log.
    const call = async <T>(name: SubstrateCall, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        this.reportCallFailure({ runId: spec.runId, substrateCall: name, errorCode: substrateErrorCode(error) });
        throw error;
      }
    };
    try {
      const capability = await this.options.resolveCapability(spec.runId);
      if (!CAPABILITY.test(capability)) throw new Error("substrate_capability_invalid");
      for (const template of actorTemplates(templates)) await this.ensureTemplate(template, call);
      const input = await this.stageInput(spec.inputArtifact, token);
      await this.stageSetup(spec, capability, token, inputHasGitHistory(input));
      await this.stageSeed(spec, token);
      try {
        await this.options.secrets.createSecret(
          this.config.credentialsNamespace,
          runSecret(token, capability, this.config),
        );
      } catch (error) {
        if (!(error instanceof KubernetesAlreadyExistsError)) throw error;
      }
      // The fence already serialized launches of this run, so an existing actor is our own.
      const templateOf = (name: string) =>
        name !== agent && templates.shape === "pair" ? templates.tool.name : templates.agent.name;
      for (const name of actorNamesFor(token, shape)) {
        const template = templateOf(name);
        await call("createActor", async () => {
          try {
            await this.api.createActor(atespace, name, template);
          } catch (error) {
            if (!(error instanceof SubstrateAlreadyExistsError)) throw error;
          }
        });
      }
      // After the actors: an egress policy belongs to its actor (a foreign key in Substrate). Every
      // policy is in place before any actor resumes, so none ever runs without one. A single-shape
      // run's one actor gets the agent's rule only (no tool rule, no actor JWT).
      await call("putEgressPolicy", () => this.api.putEgressPolicy(atespace, agent, agentEgress(token, this.config)));
      if (shape === "pair") {
        await call("putEgressPolicy", () => this.api.putEgressPolicy(atespace, tool, toolEgress(this.config)));
        // The tool first: the agent's first tool call needs it.
        await call("resumeActor", () => this.api.resumeActor(atespace, tool));
      }
      await call("resumeActor", () => this.api.resumeActor(atespace, agent));
    } catch (error) {
      // Clean up before recording requeued, so a relaunch never races this cleanup.
      await this.cleanup(token, 1, shape);
      if (error instanceof SubstrateExhaustedError) {
        await this.runs.setPhase(spec.runId, "requeued", ["provisioning"]).catch(() => undefined);
        throw new JobCapacityError("substrate_capacity: no worker has room", { cause: error });
      }
      await this.runs.setPhase(spec.runId, "provisioning_failed", ["provisioning"]).catch(() => undefined);
      throw error;
    }
    try {
      await this.runs.setPhase(spec.runId, "running", ["provisioning"]);
    } catch (error) {
      if (!isPhaseConflict(error)) {
        await this.cleanup(token, 1, shape);
        await this.runs.setPhase(spec.runId, "provisioning_failed", ["provisioning"]).catch(() => undefined);
        throw error;
      }
      // Stopped or timed out while provisioning: whoever moved it may have deleted the actors
      // before they existed, so delete them again.
      await this.deleteActors(token, shape);
    }
  }

  /**
   * Creates the template unless it exists. An existing template whose golden snapshot build failed
   * for good can never start an actor, so it is deleted and created again, once per launch (a fresh
   * golden snapshot build follows). A template's name is derived from its image, size and settings,
   * so the one deleted is this same spec.
   */
  private async ensureTemplate(
    template: ActorTemplateSpec,
    call: <T>(name: SubstrateCall, fn: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    await call("ensureActorTemplate", () => this.api.ensureActorTemplate(template));
    const info = await call("getActorTemplate", () => this.api.getActorTemplate(template.atespace, template.name));
    if (!info?.goldenSnapshotFailed) return;
    await call("deleteActorTemplate", () => this.api.deleteActorTemplate(template.atespace, template.name));
    await call("ensureActorTemplate", () => this.api.ensureActorTemplate(template));
  }

  /**
   * The setup blob, for the workspace holder (the tool actor, or a Codex run's one actor): the
   * run's registry-only token lives here (and in the holder) only. Claude Code: the tool setup with
   * the exclusions; Codex: codexWorkerSetup. `collectResultBundle` (a run with git history, #536):
   * the holder's workspace upload then carries, from the root `.git`, only the result bundle
   * (materializeWorkspace takes it); set only then, so a bridge without history uploads as before.
   */
  private async stageSetup(
    spec: JobSpec,
    capability: string,
    token: string,
    collectResultBundle: boolean,
  ): Promise<void> {
    const body =
      spec.provider === "codex"
        ? codexWorkerSetup(spec, capability, { collectResultBundle })
        : JSON.stringify({
            toolSetup: claudeToolSetup(spec, capability, {
              proxyBaseUrl: `http://${this.config.proxyHost}:${this.config.proxyPort}`,
            }),
            // The Kubernetes launcher's default for a spec without exclusions: the built-in names.
            collectExclude: spec.collectExclude ?? collectExclusions([]),
            ...(collectResultBundle ? { collectResultBundle: true } : {}),
          });
    await this.blobs.put(BLOB.toolSetup(token), Buffer.from(body), { contentType: "application/json" });
  }

  private reportCallFailure(failure: SubstrateCallFailure): void {
    try {
      if (this.options.onSubstrateCallFailed) this.options.onSubstrateCallFailed(failure);
      else substrateLog.warn({ ...failure }, "substrate_call_failed");
    } catch {
      // Reporting never changes the launch's outcome.
    }
  }

  /** Stages the worker input and returns what was staged (stageSetup reads its git history). */
  private async stageInput(inputArtifact: string, token: string, round = 1): Promise<Buffer> {
    let body: Buffer;
    // One descriptor for the check and the read (never a symlink), so the file checked is the file read.
    const source = await open(inputArtifact, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error: unknown) => {
      throw new Error("substrate_input_artifact_invalid", { cause: error });
    });
    try {
      const stats = await source.stat();
      if (!stats.isFile() || stats.size > MAX_CODING_INPUT_BYTES) throw new Error("substrate_input_artifact_invalid");
      body = await source.readFile();
    } catch (error) {
      if (error instanceof Error && error.message === "substrate_input_artifact_invalid") throw error;
      throw new Error("substrate_input_artifact_invalid", { cause: error });
    } finally {
      await source.close();
    }
    // Re-check what was read: the file could have grown after the stat.
    if (body.length > MAX_CODING_INPUT_BYTES) throw new Error("substrate_input_artifact_invalid");
    await this.blobs.put(BLOB.input(token, round), body, { contentType: "application/json" });
    return body;
  }

  /** Streams the run's prepared workspace, as a tar, into the seed blob, bounded by limits.diskMb. */
  private async stageSeed(spec: JobSpec, token: string): Promise<void> {
    const directory = resolve(this.workspaceRoot, spec.runId, "workspace");
    if (!directory.startsWith(`${this.workspaceRoot}${sep}`)) throw new Error("substrate_seed_failed");
    const found = await lstat(directory).catch(() => undefined);
    if (!found?.isDirectory()) throw new Error("substrate_seed_failed");
    const archive = hostTarArchive(directory);
    const key = BLOB.seed(token);
    try {
      await this.blobs.putStream(key, archive.stream, {
        contentType: "application/x-tar",
        maxBytes: spec.limits.diskMb * MIB,
      });
    } catch (error) {
      archive.stream.destroy();
      if (error instanceof BlobStoreError && error.code === "blob_too_large") {
        throw new Error("substrate_seed_too_large", { cause: error });
      }
      throw new Error("substrate_seed_failed", { cause: error });
    }
    if ((await archive.done) !== 0) throw new Error("substrate_seed_failed");
  }

  // -------------------------------------------------------------------------
  // Observation

  /**
   * The row a handle names. Both forms are read whether or not warm rounds are on, so a run keeps
   * its handle across a change of the setting: `<atespace>/<token>` (Phase A) is the row holding its
   * own token, `<atespace>/<runId>` (warm rounds) the run's row, whatever token it holds.
   */
  private async recordFor(handle: JobHandle): Promise<SubstrateRunRecord | undefined> {
    if (handle.backend !== BACKEND || typeof handle.id !== "string") return undefined;
    const [atespace, name, ...rest] = handle.id.split("/");
    if (rest.length > 0 || atespace !== this.config.atespace || !name) return undefined;
    if (TOKEN.test(name)) {
      const record = await this.runs.getByToken(name);
      // A row holding another run's token is an adopter (warm rounds), never this handle's run.
      if (record && record.token === substrateRunToken(record.runId)) return record;
    }
    if (!RUN_ID.test(name)) return undefined;
    return this.runs.get(name);
  }

  private async requireRecord(handle: JobHandle): Promise<SubstrateRunRecord> {
    const record = await this.recordFor(handle);
    if (!record) throw new Error("job_not_found");
    return record;
  }

  /**
   * The job's state, and its result when terminal. Order: a recorded outcome; a reported one (the
   * proxy's `done` blob); the deadline; the actors; then the two fail-fast checks. An `exit` without
   * `done` is a collect still in flight, so the run stays running until `done`, collectGraceMs after
   * `exit` (collect_timeout) or the deadline; a run whose actors never reached the proxy fails after
   * startupTimeoutMs (startup_timeout).
   */
  private async observe(record: SubstrateRunRecord): Promise<Observation> {
    if (record.phase === "removed") throw new Error("job_removed");
    const recorded = RECORDED[record.phase];
    if (recorded) return structuredClone(recorded);
    const round = roundOf(record);
    if (record.phase === "parked") {
      // Succeeded and suspended for a follow-up: still the succeeded run it was.
      const artifact = await this.resultArtifact(record, round);
      return {
        status: { state: "succeeded" },
        result: { exitCode: 0, reason: "completed", ...(artifact !== undefined ? { resultArtifact: artifact } : {}) },
      };
    }
    // An adopting run while it provisions: the token's files are still the previous round's. Its
    // deadline still holds: a control plane that stopped between the adoption and the phase write
    // (or a refused adopter that never relaunched) would otherwise leave it pending for good.
    if (record.phase === "provisioning" && record.token !== substrateRunToken(record.runId)) {
      if (this.now() > record.deadlineAt.getTime()) return this.settle(record, "timed_out");
      return { status: { state: "pending" } };
    }
    if (record.phase === "collect_timeout") {
      // The worker's exit code and its own diagnostic when it reported one, as for a missing result.
      const exit = await this.exitReport(record.token, round);
      return {
        status: { state: "failed" },
        result: {
          exitCode: exit.code,
          reason: "failed",
          ...(exit.diagnostic ?? { diagnostic: "substrate_collect_timeout" }),
        },
      };
    }
    if (record.phase === "requeued") return { status: { state: "pending", capacityRefused: true } };
    const reported = await this.reported(record, round);
    if (reported) return reported;
    if (this.now() > record.deadlineAt.getTime()) return this.settle(record, "timed_out");
    // Actors may not exist yet while a launch provisions them.
    if (record.phase === "provisioning") return { status: { state: "pending" } };
    const { atespace } = this.config;
    const shape = shapeOf(record);
    const [agent, tool] = await Promise.all(
      actorNamesFor(record.token, shape).map((name) => this.api.getActor(atespace, name)),
    );
    // A single-shape run has no tool actor to lose or crash.
    if (!agent || (shape === "pair" && !tool)) return this.settle(record, "lost");
    if (agent.state === "CRASHED") return this.settle(record, "crashed");
    if (tool?.state === "CRASHED") return this.settle(record, "tool_failed");
    // The worker exited (exit) but the workspace (done) never came: the tool side is gone.
    const exited = await this.blobs.head(BLOB.exit(record.token, round));
    if (exited && this.now() - exited.updatedAt.getTime() > this.collectGraceMs) {
      return this.settle(record, "collect_timeout");
    }
    if (await this.startupTimedOut(record, round)) return this.settle(record, "startup_timeout");
    return { status: { state: "running" } };
  }

  /**
   * Running longer than startupTimeoutMs while an actor has not reached the proxy: no `started`
   * record (the agent never downloaded its input) or the tool setup still staged (the tool never
   * made its first events poll, which deletes it). Measured from the row's updatedAt, which is the
   * move to running while neither has happened (the relay writes the row only once the agent has
   * its input, and then only ever later, so the timeout can only come late, never early).
   */
  private async startupTimedOut(record: SubstrateRunRecord, round: number): Promise<boolean> {
    const since = record.updatedAt?.getTime();
    if (since === undefined || !Number.isFinite(since) || this.now() - since <= this.startupTimeoutMs) return false;
    if (!(await this.blobs.head(BLOB.started(record.token, round)))) return true;
    return (await this.blobs.head(BLOB.toolSetup(record.token))) !== null;
  }

  /** Records an outcome the launcher observed; if another caller recorded one first, that one stands. */
  private async settle(record: SubstrateRunRecord, phase: SubstratePhase): Promise<Observation> {
    let stored: SubstrateRunRecord;
    try {
      stored = await this.runs.setPhase(record.runId, phase, LIVE_PHASES);
    } catch (error) {
      if (!isPhaseConflict(error)) throw error;
      const current = await this.runs.get(record.runId);
      if (!current) throw new Error("job_not_found", { cause: error });
      return this.observe(current);
    }
    // A timed-out run must not keep running; the others are left for remove().
    if (STOP_ACTORS_ON.includes(phase)) {
      await this.deleteActors(record.token, shapeOf(record)).catch(() => undefined);
    }
    return this.observe(stored);
  }

  /** The outcome the actors reported through the proxy, once the proxy has written `done`. */
  private async reported(record: SubstrateRunRecord, round?: number): Promise<Observation | undefined> {
    round ??= roundOf(record);
    const done = await this.readJson(BLOB.done(record.token, round), MAX_MARKER_BYTES);
    if (done === undefined) return undefined;
    const workspace = typeof done === "object" && done !== null ? (done as { workspace?: unknown }).workspace : null;
    if (workspace !== "ok") {
      return {
        status: { state: "failed", reason: "substrate_collect_failed" },
        result: {
          exitCode: await this.exitCode(record.token, round),
          reason: "failed",
          diagnostic: "substrate_collect_failed",
        },
      };
    }
    const artifact = await this.resultArtifact(record, round);
    if (artifact !== undefined) {
      // Same rule as the Kubernetes launcher's exitedCleanlyInTime: a success reported past the
      // deadline (with clock skew) is a timeout, since the run kept going after it should have stopped.
      const at = (await this.blobs.head(BLOB.done(record.token, round)))?.updatedAt.getTime();
      if (at === undefined || !Number.isFinite(at) || at > record.deadlineAt.getTime() + FINISHED_AT_SKEW_MS) {
        return this.settle(record, "timed_out");
      }
      return { status: { state: "succeeded" }, result: { exitCode: 0, reason: "completed", resultArtifact: artifact } };
    }
    // No reason string, as on Kubernetes. The worker's own diagnostic (what Kubernetes reads from its
    // log tail) when its bridge reported one; else the collect diagnostic says what was missing.
    const exit = await this.exitReport(record.token, round);
    return {
      status: { state: "failed" },
      result: {
        exitCode: exit.code,
        reason: "failed",
        ...(exit.diagnostic ?? { diagnostic: "substrate_result_missing" }),
      },
    };
  }

  /** The posted result, validated and for this run; undefined when missing or not a valid output. */
  private async resultArtifact(record: SubstrateRunRecord, round: number): Promise<string | undefined> {
    const raw = await this.readBlob(BLOB.result(record.token, round), MAX_CODING_ARTIFACT_BYTES);
    if (raw === undefined) return undefined;
    try {
      const output = parseCodingWorkerOutputJson(raw.toString("utf8"));
      return output.runId === record.runId ? JSON.stringify(output) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The worker's exit code from the proxy's `exit` blob; 1 when absent or not a failure code. */
  private async exitCode(token: string, round: number): Promise<number> {
    return (await this.exitReport(token, round)).code;
  }

  /**
   * The proxy's `exit` blob: the worker's exit code (1 when absent or not a failure code) and its own
   * diagnostic, re-checked with the shared worker-diagnostic rule (the blob is the bridge's report).
   */
  private async exitReport(token: string, round: number): Promise<{ code: number; diagnostic?: WorkerDiagnostic }> {
    const exit = (await this.readJson(BLOB.exit(token, round), MAX_EXIT_BYTES)) as
      { code?: unknown; diagnostic?: unknown; diagnosticIssues?: unknown } | null | undefined;
    const raw = exit?.code;
    const code = typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= 255 ? raw : 1;
    const diagnostic =
      exit && typeof exit === "object" ? workerDiagnosticOf(exit.diagnostic, exit.diagnosticIssues) : undefined;
    return diagnostic ? { code, diagnostic } : { code };
  }

  /** A blob of at most maxBytes; undefined when missing or larger. */
  private async readBlob(key: string, maxBytes: number): Promise<Buffer | undefined> {
    const info = await this.blobs.head(key);
    if (!info || info.sizeBytes > maxBytes) return undefined;
    try {
      const body = await this.blobs.get(key);
      return body.length > maxBytes ? undefined : body;
    } catch (error) {
      if (isBlobNotFound(error)) return undefined;
      throw error;
    }
  }

  /** A small JSON blob; null when present but unreadable, undefined when missing. */
  private async readJson(key: string, maxBytes: number): Promise<unknown> {
    const info = await this.blobs.head(key);
    if (!info) return undefined;
    const body = await this.readBlob(key, maxBytes);
    if (body === undefined) return null;
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Warm rounds (SUBSTRATE_WARM_ROUNDS, experimental)

  /**
   * Keeps a succeeded, delivered run's actors for the next round (see WorkspaceJobLauncher.retain):
   * with warm rounds on, parking allowed (parkMax > 0) and the run running and succeeded, the run is
   * parked with `retention`, then the oldest parks go until no more than parkMax remain. Anything
   * else, or any failed step, removes the run as remove() does, and the answer is false. Retaining a
   * run already parked with the same retention is true again (a retried call); with another, it is
   * removed.
   */
  async retain(handle: JobHandle, retention: JobRetention): Promise<boolean> {
    const record = await this.recordFor(handle);
    if (!record || record.phase === "removed") return false;
    // A single-shape (Codex) run is never parked: warm rounds are Claude Code only.
    if (record.actorShape === "single") {
      await this.remove(handle);
      return false;
    }
    if (
      record.phase === "parked" &&
      validRetention(retention) &&
      record.headSha === retention.headSha &&
      record.fingerprint === retention.fingerprint
    ) {
      return true;
    }
    if (this.warm && this.warm.parkMax > 0 && record.phase === "running" && validRetention(retention)) {
      const observed = await this.observe(record);
      if (observed.status.state === "succeeded" && (await this.park(record, retention))) {
        await this.trimParks(record.runId).catch(() => undefined);
        return true;
      }
    }
    await this.remove(handle);
    return false;
  }

  /**
   * For a run launched with JobSpec.warm (warm rounds on): adopted, or launched cold and why. Read
   * from the run's row, so it answers after a restart too: a recorded cold reason; else a row holding
   * another run's token adopted it (round > 1), or, requeued, was refused for capacity while resuming.
   */
  async warmOutcome(handle: JobHandle): Promise<WarmOutcome | undefined> {
    if (!this.warm) return undefined;
    const record = await this.recordFor(handle);
    if (!record) return undefined;
    if (record.coldReason !== undefined) return { adopted: false, reason: record.coldReason };
    if (record.token === substrateRunToken(record.runId)) return undefined;
    if (record.phase === "requeued") return { adopted: false, reason: "capacity" };
    return roundOf(record) > 1 ? { adopted: true } : undefined;
  }

  /**
   * Removes every park of `filter.agentId`'s runs (WorkspaceJobLauncher.removeParked), each as an
   * expired park is removed; how many went. Never throws: a park that cannot be removed now (or
   * when the store cannot be read) is left to the sweep. Removal only, so it works with warm rounds
   * off too.
   */
  async removeParked(filter: { agentId: string }): Promise<number> {
    let removed = 0;
    for (const park of await this.parks()) {
      if (park.agentId !== filter.agentId) continue;
      try {
        if (!(await this.removeParkedRun(park))) continue;
      } catch {
        continue;
      }
      removed += 1;
      this.warmEvent({ event: "substrate_warm_removed", runId: park.runId, runToken: park.token, reason: "agent" });
    }
    return removed;
  }

  /**
   * Start-up: removes the parks that expired while no control plane was sweeping, and with warm
   * rounds off every park left from when they were on. Never throws.
   */
  async warmUp(): Promise<void> {
    this.lastSweepAt = this.now();
    await this.sweepParked().catch(() => undefined);
  }

  private warmEvent(event: WarmEvent): void {
    try {
      if (this.options.onWarmEvent) this.options.onWarmEvent(event);
      else substrateLog.info({ ...event }, event.event);
    } catch {
      // Reporting never changes the outcome.
    }
  }

  /**
   * Whether the run's actors (both, or a Codex run's one) can be placed now on the workers the
   * configured selector matches, by free CPU and memory (Substrate packs many actors per worker): the
   * larger first on the worker with the most free room, then the other, on the same worker or
   * another. No workers: false. Any error (an unreachable API): true, so the launch itself decides
   * (a refusal there is a JobCapacityError).
   */
  private async fits(templates: RunTemplates): Promise<boolean> {
    return placeable(await this.freeRoom(), templates);
  }

  /** The free room of each worker the configured selector matches; undefined when it cannot be read. */
  private async freeRoom(): Promise<Room[] | undefined> {
    try {
      const selector = Object.entries(this.config.workerSelector ?? {});
      return (await this.api.listWorkers())
        .filter((worker) => selector.every(([key, value]) => worker.labels?.[key] === value))
        .map((worker) => ({ cpuMillicores: worker.freeCpuMillicores, memoryBytes: worker.freeMemoryBytes }));
    } catch {
      return undefined;
    }
  }

  /** Every park, oldest first (none when the store cannot be read: a launch never fails for it). */
  private async parks(): Promise<SubstrateRunRecord[]> {
    return oldestFirst(await this.runs.listParked().catch(() => []));
  }

  /**
   * Removes parks, oldest first and never `keep`, one at a time, until the templates fit; whether
   * they do. After each removal the workers' free room is read again, and the removals stop as soon
   * as one did not add to it: where a suspended actor already gives back its room, removing parks
   * cannot make room, so at most one goes per call.
   */
  private async evictUntilFits(templates: RunTemplates, keep: string | undefined): Promise<boolean> {
    let before = await this.freeRoom();
    if (placeable(before, templates)) return true;
    for (const park of await this.parks()) {
      if (park.runId === keep || !(await this.evict(park, "capacity"))) continue;
      const after = await this.freeRoom();
      if (placeable(after, templates)) return true;
      if (!before || !after || !grew(before, after)) return false;
      before = after;
    }
    return false;
  }

  /**
   * After `parked` was parked: while more than parkMax runs are parked, removes the parks ahead of it
   * (oldest first; never itself or a newer one). The cap holds after the fact, not before: control
   * planes that park at the same time each see room, so parks can exceed parkMax briefly, by at most
   * the number of retains in flight, until each trims. Only older parks go, so two control planes
   * trimming at once never remove each other's new park.
   */
  private async trimParks(parked: string): Promise<void> {
    const max = this.warm!.parkMax;
    const parks = await this.parks();
    const index = parks.findIndex((park) => park.runId === parked);
    const ahead = index > 0 ? parks.slice(0, index) : [];
    for (const park of ahead) {
      if ((await this.runs.countParked().catch(() => 0)) <= max) return;
      await this.evict(park, "park_max");
    }
  }

  private async evict(park: SubstrateRunRecord, reason: WarmEvictReason): Promise<boolean> {
    try {
      if (!(await this.removeParkedRun(park))) return false;
    } catch {
      return false;
    }
    this.warmEvent({ event: "substrate_warm_evicted", runId: park.runId, runToken: park.token, reason });
    return true;
  }

  /**
   * Suspends both actors (the snapshot durable before this returns), deletes the per-run Secret (no
   * live credential at rest: nothing runs, and adoption creates it fresh), the seed, the workspace
   * tar and the tool setup (the run's registry-only token), and the relay's rows (which would
   * otherwise follow the retired token on adoption), then records the run as parked until now +
   * parkTtlMs with the round, its commit and fingerprint. Keeps the egress policies, the actors'
   * state and the small files the run's outcome is read from. False, with nothing recorded, when any
   * step fails: the caller then removes the run.
   */
  private async park(record: SubstrateRunRecord, retention: JobRetention): Promise<boolean> {
    const { atespace } = this.config;
    const startedAt = this.now();
    const clock = performance.now();
    const round = roundOf(record);
    try {
      try {
        // The tool first: it holds the workspace and the agent never needs it while suspended.
        await this.api.suspendActor(atespace, toolActorName(record.token));
        await this.api.suspendActor(atespace, agentActorName(record.token));
      } catch (error) {
        this.reportCallFailure({
          runId: record.runId,
          substrateCall: "suspendActor",
          errorCode: substrateErrorCode(error),
        });
        throw error;
      }
      await settleAll([
        () => this.deleteSecret(record.token),
        () => this.deleteBlob(BLOB.seed(record.token)),
        () => this.deleteBlob(BLOB.workspace(record.token, round)),
        () => this.deleteBlob(BLOB.toolSetup(record.token)),
      ]);
      await this.options.relay.purgeRelay(record.token);
      await this.runs.park(record.runId, {
        headSha: retention.headSha,
        fingerprint: retention.fingerprint,
        parkedAt: new Date(startedAt),
        round,
        expiresAt: new Date(startedAt + this.warm!.parkTtlMs),
      });
    } catch {
      this.warmEvent({ event: "substrate_warm_park_failed", runId: record.runId, runToken: record.token, round });
      return false;
    }
    const ms = Math.round(performance.now() - clock);
    this.warmEvent({ event: "substrate_warm_parked", runId: record.runId, runToken: record.token, round, ms });
    return true;
  }

  /**
   * Removes a parked run in full (expired, evicted, removed, or one a continuation could not adopt).
   * Its park is expired first, so no continuation adopts it while its actors go; false, with
   * nothing touched, when one adopted it already.
   */
  private async removeParkedRun(record: SubstrateRunRecord): Promise<boolean> {
    try {
      await this.runs.setPhase(record.runId, "parked", ["parked"], new Date(0));
    } catch (error) {
      if (isPhaseConflict(error)) return false;
      throw error;
    }
    // Only paired runs are ever parked.
    await this.removeInFull(record.token, roundOf(record), "pair");
    try {
      await this.runs.setPhase(record.runId, "removed", ["parked"]);
    } catch (error) {
      // Another removal of the same park finished first: removed either way.
      if (!isPhaseConflict(error) || (await this.runs.get(record.runId))?.phase !== "removed") throw error;
    }
    return true;
  }

  private async sweepParkedSometimes(): Promise<void> {
    if (this.now() - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = this.now();
    await this.sweepParked().catch(() => undefined);
  }

  /**
   * Removes every parked run past its expiry (deadlineAt); with warm rounds off, every parked run
   * (nothing adopts one, so a park left from when they were on is only cost). Removal only: never
   * parks or adopts.
   */
  async sweepParked(): Promise<void> {
    for (const record of await this.runs.listParked()) {
      if (this.warm && record.deadlineAt.getTime() > this.now()) continue;
      try {
        if (await this.removeParkedRun(record)) {
          this.warmEvent({ event: "substrate_warm_expired", runId: record.runId, runToken: record.token });
        }
      } catch {
        // Tried again on the next sweep.
      }
    }
  }

  /**
   * Adopts the run this continuation names (JobSpec.warm.fromRunId) when it is parked, unexpired,
   * both its actors are suspended, and it was parked with the commit and fingerprint the spec
   * carries: the parked row moves to `adopted` and this run's row takes its token, then the next
   * round's files and the new capability are staged and both actors resume. Undefined for a spec
   * without `warm`. Otherwise why not (the caller launches cold); a park that does not fit is
   * removed, so no later round adopts state older than the branch. Undefined, too, when another
   * launch of the same run got its row first (no event: that launch reports).
   */
  private async adoptParked(spec: JobSpec, specHash: string, deadlineAt: Date): Promise<WarmOutcome | undefined> {
    const warm = spec.warm;
    if (!warm) return undefined;
    const parked = await this.runs.get(warm.fromRunId);
    const notAdopted = async (
      reason: WarmColdReason,
      park?: SubstrateRunRecord,
      removePark = true,
    ): Promise<WarmOutcome> => {
      this.warmEvent({
        event: "substrate_warm_not_adopted",
        runId: spec.runId,
        ...(park ? { runToken: park.token } : {}),
        adoptedRunId: warm.fromRunId,
        reason,
      });
      if (park && removePark) await this.removeParkedRun(park).catch(() => undefined);
      return { adopted: false, reason };
    };
    if (!parked || parked.phase !== "parked" || parked.runId === spec.runId) return notAdopted("not_parked");
    if (parked.deadlineAt.getTime() <= this.now()) return notAdopted("expired", parked);
    if (parked.headSha !== warm.headSha) return notAdopted("branch_moved", parked);
    if (parked.fingerprint !== warm.fingerprint) return notAdopted("fingerprint_changed", parked);
    const { atespace } = this.config;
    const [agent, tool] = await Promise.all([
      this.api.getActor(atespace, agentActorName(parked.token)),
      this.api.getActor(atespace, toolActorName(parked.token)),
    ]);
    if (!agent || !tool) return notAdopted("actor_missing", parked);
    if (agent.state !== "SUSPENDED" || tool.state !== "SUSPENDED") return notAdopted("actor_not_suspended", parked);
    const record = await this.runs.adopt(parked.runId, spec.runId, deadlineAt, {
      specHash,
      ...(spec.agentId !== undefined ? { agentId: spec.agentId } : {}),
    });
    if (!record) {
      // Another launch of this same run got its row first: that launch decides, and reports.
      if (await this.runs.get(spec.runId)) return undefined;
      // Expired meanwhile (or being removed, which expires it first), else adopted or removed first.
      // Left for whoever removes it, or the sweep.
      const current = await this.runs.get(parked.runId);
      const expired = current?.phase === "parked" && current.deadlineAt.getTime() <= this.now();
      return expired ? notAdopted("expired", current, false) : notAdopted("not_parked");
    }
    await this.resumeAdopted(spec, record, roundOf(record), parked.runId);
    return { adopted: true };
  }

  /**
   * Round `round` on adopted actors: stage its input and tool setup, record the round, hand the
   * per-run Secret the new run's capability, then resume the tool and the agent. Nothing is seeded:
   * the tool actor's /workspace is the previous round's, as collected. A failure cleans up every
   * round's resources (the warm state is gone) and is recorded as on a cold launch.
   */
  private async resumeAdopted(spec: JobSpec, record: SubstrateRunRecord, round: number, adoptedRunId: string) {
    const { atespace } = this.config;
    const token = record.token;
    const agent = agentActorName(token);
    const tool = toolActorName(token);
    const steps: Record<string, number> = {};
    const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const clock = performance.now();
      try {
        return await fn();
      } finally {
        steps[name] = Math.round(performance.now() - clock);
      }
    };
    const call = async <T>(name: SubstrateCall, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        this.reportCallFailure({ runId: spec.runId, substrateCall: name, errorCode: substrateErrorCode(error) });
        throw error;
      }
    };
    const clock = performance.now();
    try {
      const capability = await this.options.resolveCapability(spec.runId);
      if (!CAPABILITY.test(capability)) throw new Error("substrate_capability_invalid");
      await timed("stage", async () => {
        const input = await this.stageInput(spec.inputArtifact, token, round);
        await this.stageSetup(spec, capability, token, inputHasGitHistory(input));
        await this.blobs.put(roundBlob(token), Buffer.from(JSON.stringify({ round })), {
          contentType: "application/json",
        });
      });
      // Fresh, with the new run's capability: the park deleted the last round's (any left from before
      // that rule is deleted first).
      await timed("secret", async () => {
        await this.deleteSecret(token);
        await this.options.secrets.createSecret(
          this.config.credentialsNamespace,
          runSecret(token, capability, this.config),
        );
      });
      await timed("resumeTool", () => call("resumeActor", () => this.api.resumeActor(atespace, tool)));
      await timed("resumeAgent", () => call("resumeActor", () => this.api.resumeActor(atespace, agent)));
    } catch (error) {
      // Only paired runs are ever adopted.
      await this.cleanup(token, round, "pair");
      if (error instanceof SubstrateExhaustedError) {
        await this.runs.setPhase(spec.runId, "requeued", ["provisioning"]).catch(() => undefined);
        throw new JobCapacityError("substrate_capacity: no worker has room", { cause: error });
      }
      await this.runs.setPhase(spec.runId, "provisioning_failed", ["provisioning"]).catch(() => undefined);
      throw error;
    }
    try {
      await this.runs.setPhase(spec.runId, "running", ["provisioning"]);
    } catch (error) {
      if (!isPhaseConflict(error)) {
        await this.cleanup(token, round, "pair");
        await this.runs.setPhase(spec.runId, "provisioning_failed", ["provisioning"]).catch(() => undefined);
        throw error;
      }
      await this.deleteActors(token, "pair");
    }
    this.warmEvent({
      event: "substrate_warm_adopted",
      runId: spec.runId,
      runToken: token,
      round,
      adoptedRunId,
      ms: Math.round(performance.now() - clock),
      steps,
    });
  }

  // -------------------------------------------------------------------------
  // Cleanup (each step: missing is success)

  /** Deletes the run's actors (both, or a single-shape run's one), each tried even if another fails. */
  private async deleteActors(token: string, shape: SubstrateActorShape): Promise<void> {
    const { atespace } = this.config;
    await settleAll(actorNamesFor(token, shape).map((name) => () => this.api.deleteActor(atespace, name)));
  }

  /**
   * Every resource of the run, one step per deletion, so none waits on (or is skipped by) another.
   * With `outcome: false`, not the blobs that carry the run's outcome (result, exit, done) nor the
   * round record. Every round's files (`rounds` from the run's row), whatever the warm-rounds
   * setting now: a run from when it was on is removed in full after it is turned off.
   */
  private deletions(
    token: string,
    rounds: number,
    { outcome = true, shape }: { outcome?: boolean; shape: SubstrateActorShape },
  ): (() => Promise<void>)[] {
    const { atespace } = this.config;
    const actors = actorNamesFor(token, shape);
    const blobs = Object.values(BLOB).filter(
      (blob) => outcome || (blob !== BLOB.done && !OUTCOME_BLOBS.includes(blob)),
    );
    const steps = [
      ...actors.map((name) => () => this.api.deleteActor(atespace, name)),
      ...actors.map((name) => () => this.api.deleteEgressPolicy(atespace, name)),
      () => this.deleteSecret(token),
      ...blobs.map((blob) => () => this.deleteBlob(blob(token))),
    ];
    for (let round = 2; round <= rounds; round += 1) {
      for (const name of ROUND_BLOBS) {
        if (outcome || !OUTCOME_ROUND_BLOBS.includes(name)) steps.push(() => this.deleteBlob(BLOB[name](token, round)));
      }
    }
    if (outcome && (this.warm || rounds > 1)) steps.push(() => this.deleteBlob(roundBlob(token)));
    return steps;
  }

  /**
   * Removes everything of the token, every round included. Every deletion is tried even when one
   * fails; the first failure is reported (the caller does not mark the run removed, so a later
   * remove() tries again). With the actors gone (nothing can append to it any more), the relay's
   * rows go; the outcome last, the current round's `done` after everything it describes and the
   * round record after that: until every other deletion has succeeded, a later status() still reads
   * the run's real outcome rather than a lost run.
   */
  private async removeInFull(token: string, rounds: number, shape: SubstrateActorShape): Promise<void> {
    await settleAll(this.deletions(token, rounds, { outcome: false, shape }));
    await this.options.relay.purgeRelay(token);
    const outcome: (() => Promise<void>)[] = [];
    for (let round = 1; round <= rounds; round += 1) {
      outcome.push(...OUTCOME_BLOBS.map((blob) => () => this.deleteBlob(blob(token, round))));
      if (round < rounds) outcome.push(() => this.deleteBlob(BLOB.done(token, round)));
    }
    await settleAll(outcome);
    await this.deleteBlob(BLOB.done(token, rounds));
    if (this.warm || rounds > 1) await this.deleteBlob(roundBlob(token));
  }

  private async deleteSecret(name: string): Promise<void> {
    try {
      await this.options.secrets.deleteSecret(this.config.credentialsNamespace, name);
    } catch (error) {
      if (!(error instanceof KubernetesNotFoundError)) throw error;
    }
  }

  private async deleteBlob(key: string): Promise<void> {
    try {
      await this.blobs.delete(key);
    } catch (error) {
      if (!isBlobNotFound(error)) throw error;
    }
  }

  /** Best effort after a failed launch: nothing of the attempt (every round up to `rounds`) is left behind. */
  private async cleanup(token: string, rounds: number, shape: SubstrateActorShape): Promise<void> {
    await settleAll(this.deletions(token, rounds, { shape })).catch(() => undefined);
    await this.options.relay.purgeRelay(token).catch(() => undefined);
  }
}
