/**
 * SubstrateJobLauncher (JOB_LAUNCHER=substrate, experimental): runs one Claude Code coding job as
 * two Agent Substrate actors — the agent (the worker) and the tool (the credential-free tool
 * runner, which holds the workspace) — built from shared, secret-free templates. A Codex job runs
 * as one actor (the single shape, recorded on the row as actorShape): the agent, whose Codex bridge
 * runs the unchanged Codex worker and holds the workspace, with the agent's egress rule only. Codex
 * runs never park or adopt (warm rounds are Claude Code only).
 *
 * The Substrate client, the call and error vocabulary, the template and actor steps and the Secret
 * shape both launchers share live in src/providers/substrate/.
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
 * - Extra repositories (JobSpec.repositories): validated before any side effect (each host path must
 *   be the run's own repos/<name>/workspace), recorded on the row by name and access only, and one
 *   seed (REPO_BLOB.seed) and one upload (REPO_BLOB.workspace) per extra, under the run's one diskMb
 *   budget. Only the workspace holder (the tool actor, or a Codex run's one actor) gets the /repos
 *   volume, and its setup lists the extras; Claude's agent never sees a repository.
 * - The dependency cache (JobSpec.dependencyCache) is supported on both shapes with no launcher code
 *   beyond the adopt flag: the cache lives behind the coding proxy, and an adopted round's tool
 *   setup says workspaceReused, so the tool runner skips it. Its snapshots live under
 *   `dependency-cache/` in the same blob store; the launcher never deletes them (it removes only the
 *   run's own `substrate/runs/<token>/` keys).
 * - Bridge protocol: every bridge request names its protocol (BRIDGE_PROTOCOL_HEADER). A bridge from
 *   another release is refused by the proxy, which records it once (BLOB.bridgeRefused), and the run
 *   fails as substrate_bridge_incompatible (phase bridge_incompatible, actors deleted) before the
 *   startup timeout.
 * - Image self-check: the workspace holder's bridge checks its image (runner, GNU tar, /workspace,
 *   its /run/wardby directories) once it has its run name, and reports the first missing one as an
 *   enum item, recorded once by the proxy (BLOB.imageIncomplete). The run fails as
 *   substrate_image_incomplete:<item> (phase image_incomplete, actors deleted); the item is re-checked
 *   here, so nothing but a SUBSTRATE_IMAGE_ITEMS value reaches the run's result.
 * - Coding services (JobSpec.services): one container per service in the workspace holder's template
 *   (specs.ts); each start script is staged in the setup blob and started by the holder's bridge,
 *   which holds the runner (pair) or the input (single) until all are ready; launch() resumes the
 *   holder first, waits on BLOB.services (forwarding states to onServiceState) and throws
 *   coding_service_unready:<name> on failure. A run with services never parks.
 * - Custom images (workerImageRef): any registry digest runs; Claude Code's custom image is the tool
 *   actor's only, Codex's the one actor's. The image must carry this release's bridge; the proxy's
 *   protocol check, the bridge's image check and the template readiness rules turn a broken one into
 *   a fixed code.
 * - Templates: each one wardby ensures has a SubstrateTemplate row (its name, role and image; when
 *   it was last used by a launch, park or adoption; its golden-snapshot failures in the current
 *   window; when it was first seen ready: Substrate reported its golden snapshot tagged, or an
 *   actor from it reached running). A first golden-snapshot failure rebuilds
 *   the template; a second in SUBSTRATE_TEMPLATE_RETRY_SEC, or a never-ready template past
 *   SUBSTRATE_TEMPLATE_READY_SEC of resumes refused while the workers had room, fails the run as
 *   substrate_image_unready instead of requeueing it.
 * - Template cleanup (every template wardby recorded, standard and custom): at most once an hour a
 *   launch (and warmUp) removes the templates no launch, park or adoption used for
 *   SUBSTRATE_TEMPLATE_TTL_SEC (default 7 days, never under the longest coding run plus the park TTL
 *   plus an hour): the row first, only while still unused, then the Substrate template; a failed
 *   Substrate delete puts the row back. A launch whose template was removed between its ensure and
 *   its createActor ensures it once more and retries. Substrate answers a missing template
 *   FailedPrecondition (SubstrateTemplateMissingError); an adoption whose parked actor's template is
 *   gone removes the park and starts the run fresh (cold reason actor_missing).
 * - A create or resume Substrate refuses Unavailable (typically once a broken image's golden actor
 *   crashed) re-reads the template's status (goldenFailureAfter): only a failed golden snapshot counts
 *   as a golden-snapshot failure. A status without a tag on a template that never started an actor
 *   requeues the run uncounted, with no rebuild (a broken build reports its failure by the relaunch,
 *   and ensureTemplate counts it then); once that template has been refused for longer than
 *   SUBSTRATE_TEMPLATE_READY_SEC while the workers had room, the run fails as never_ready.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { collectExclusions } from "../../../coding/collect-exclude.js";
import { isMcpToken } from "../../../coding/mcp-token.js";
import { MAX_CODING_TIMEOUT_SEC } from "../../../coding/profile.js";
import { MAX_PARK_TTL_SEC } from "../../../config/providers.js";
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
import { codexWorkerSetup, holderSetupRepositories } from "../codex-worker-setup.js";
import { MAX_CODING_SERVICES } from "../../../coding/protocol.js";
import {
  StoredCodingServicesSchema,
  type CodingServiceKind,
  type ResolvedCodingService,
} from "../../../coding/services/catalog.js";
import { serviceUnreadyError } from "../../../coding/services/wording.js";
import { isRepositoryDigest } from "../docker-isolation.js";
import { KubernetesAlreadyExistsError, KubernetesNotFoundError, type KubernetesApi } from "../kubernetes-api.js";
import { RUN_ID } from "../kubernetes-isolation.js";
import { CAPABILITY, FINISHED_AT_SKEW_MS, hostTarArchive, stableSpecHash } from "../kubernetes.js";
import { safeExtract } from "../safe-extract.js";
import { expectedRepositoryHostPath, jobRepositoriesValid } from "../storage-init.js";
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
  type UnstartableService,
  type WarmColdReason,
  type WarmOutcome,
  type WorkspaceJobLauncher,
} from "../types.js";
import {
  reportServiceState,
  type ServiceFailureReason,
  type ServiceState,
  type ServiceStateReporter,
} from "../service-state.js";
import { workerDiagnosticOf, type WorkerDiagnostic } from "../worker-diagnostic.js";
import { replaceDirectoryFromStaging, takeResultBundle } from "../workspace-swap.js";
import {
  SubstrateExhaustedError,
  SubstrateTemplateMissingError,
  SubstrateUnavailableError,
  type ActorTemplateSpec,
  type SubstrateApi,
  type TemplateInfo,
} from "../../substrate/api.js";
import {
  createFreshActor,
  ensureTemplate as ensureSubstrateTemplate,
  namedCall,
  reportCallFailure,
  substrateErrorCode,
  type NamedCall,
  type SubstrateCall,
  type SubstrateCallFailure,
} from "../../substrate/actors.js";
import {
  BLOB,
  REPO_BLOB,
  ROUND_BLOBS,
  actorNamesFor,
  agentActorName,
  isSubstrateImageItem,
  MAX_SERVICES_REPORT_BYTES,
  parseServicesReport,
  roundBlob,
  type SubstrateImageItem,
  substrateRunToken,
  templateRoleOf,
  toolActorName,
} from "./names.js";
import { canPlaceAll, type Room } from "../../substrate/placement.js";
import {
  SERVICE_START_MARKER_MS,
  serviceStartScript,
  servicesInOrder,
  servicesWaitMs,
  substrateServiceProblems,
} from "./service-script.js";
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
import type { GoldenFailureCount, SubstrateTemplateRole, SubstrateTemplateStore } from "./template-store.js";

export interface SubstrateJobLauncherOptions {
  api: SubstrateApi;
  runs: SubstrateRunStore;
  blobs: BlobStore;
  secrets: Pick<KubernetesApi, "createSecret" | "deleteSecret">;
  /** The proxy's tool relay: a removed run's channels and queued lines are deleted with it. */
  relay: Pick<RelayStore, "purgeRelay">;
  config: SubstrateLaunchConfig;
  /** Same root the VCS provider prepares workspaces under (as the Kubernetes launcher's). */
  workspaceRoot: string;
  resolveCapability: (runId: string) => Promise<string>;
  /** The run's MCP token from the capability vault (composition: capabilities.mcpToken), asked only for a spec with mcpTools. */
  resolveMcpToken?: (runId: string) => Promise<string | undefined>;
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
  /** The launcher's record of the templates it created (readiness, cleanup). */
  templates: SubstrateTemplateStore;
  /**
   * SUBSTRATE_TEMPLATE_READY_SEC: how long a template that is not ready (Substrate reports no golden
   * snapshot tag, or, without that status, no actor from it ever started) may build before a run on
   * it fails as substrate_image_unready (default 900 s).
   */
  templateReadyMs?: number;
  /**
   * SUBSTRATE_TEMPLATE_RETRY_SEC: the window after a golden-snapshot failure within which another one
   * fails runs instead of rebuilding (default 600 s).
   */
  templateRetryMs?: number;
  /** SUBSTRATE_TEMPLATE_TTL_SEC: how long a template no run used is kept (the cleanup sweep). */
  templateTtlMs?: number;
  /** Where template steps are reported (default: the server log; info, and warn for failures). */
  onTemplateEvent?: (event: TemplateEvent) => void;
  /** Where coding-service display states go (composition: prismaServiceStateReporter, as for Docker and Kubernetes). */
  onServiceState?: ServiceStateReporter;
  /** Waits between polls of a run's services report (default: setTimeout; tests advance their clock). */
  sleep?: (ms: number) => Promise<void>;
}

/** A template step, fixed fields only (never a Substrate message, a spec or a run value). */
export interface TemplateEvent {
  event:
    | "substrate_template_golden_failed"
    | "substrate_template_status_read_failed"
    | "substrate_template_unready"
    | "substrate_template_record_failed"
    | "substrate_template_removed"
    | "substrate_template_remove_failed";
  name: string;
  role: SubstrateTemplateRole;
  /** golden_failed: the failures in the window. */
  failures?: number;
  /** unready: why. */
  reason?: "golden_failed" | "never_ready";
  /** removed: seconds since its last use. */
  ageSec?: number;
}

export const DEFAULT_TEMPLATE_READY_MS = 900_000;
/** How many template names the never-ready clock tracks at once (oldest dropped first). */
const NEVER_READY_TRACKED = 1000;
export const DEFAULT_TEMPLATE_RETRY_MS = 600_000;
/**
 * A golden-snapshot failure seen within this of the window's first failure is that same build, seen
 * by another launch before the template was rebuilt: counted once, and that launch requeues (a
 * rebuild takes a fresh golden snapshot build, so a distinct build's failure comes later).
 */
export const TEMPLATE_SAME_BUILD_MS = 60_000;

/** How often launch() may sweep unused templates. */
const TEMPLATE_SWEEP_INTERVAL_MS = 3_600_000;
/** At most this many templates are removed per sweep. */
const TEMPLATE_SWEEP_BATCH = 50;
export const DEFAULT_TEMPLATE_TTL_MS = 7 * 24 * 3_600_000;

/**
 * The shortest template TTL the launcher uses: the longest coding run (MAX_CODING_TIMEOUT_SEC,
 * src/coding/profile.ts), plus the longest park TTL the setting allows (MAX_PARK_TTL_SEC, never
 * the configured one: lowering it, or turning warm rounds off, across a restart must not sweep a
 * template an older, longer park can still adopt), plus an hour. Launch, park and
 * adoption all bump a template, so none is removed while a run or a park from it can exist.
 */
export function templateTtlFloorMs(): number {
  return MAX_CODING_TIMEOUT_SEC * 1000 + MAX_PARK_TTL_SEC * 1000 + 3_600_000;
}

/** A run's template cannot start an actor (see ensureTemplate and neverReady): the run fails, never requeues. */
class TemplateUnreadyError extends Error {
  constructor() {
    super("substrate_image_unready");
  }
}

/** Another launch is rebuilding the template whose failed build this launch also saw: the run requeues. */
class TemplateRebuildingError extends Error {
  constructor() {
    super("substrate_template_rebuilding");
  }
}

/**
 * A start was refused on a template still building its golden snapshot (no tag, never started an
 * actor): the run requeues, uncounted and with no rebuild, unless the template is never ready.
 */
class TemplateBuildingError extends Error {
  constructor() {
    super("substrate_template_building");
  }
}

export interface WarmRoundsOptions {
  /** How long a parked run waits for a follow-up before a sweep removes it. */
  parkTtlMs: number;
  /** At most this many runs parked at once (SUBSTRATE_PARK_MAX); the oldest go first. 0: never park. */
  parkMax: number;
}

/** Why a park was removed to make room: for a launch (`capacity`) or for a newer park (`park_max`). */
export type WarmEvictReason = "capacity" | "park_max";
/** Why an agent's or a run's parks were removed: its caller's lifecycle event, or a run with services (never parked). */
export type WarmRemoveReason = "agent" | "services";

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

/** How often launch() reads a services run's BLOB.services. */
const SERVICES_POLL_MS = 1_000;
/** Beyond the bridge's own bound: the launcher's slack for the bridge's last report. */
const SERVICES_GRACE_MS = 15_000;

export const DEFAULT_COLLECT_GRACE_MS = 120_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;

// The call names and failure shape live with the shared actor steps (src/providers/substrate/actors.ts).
export type { SubstrateCall, SubstrateCallFailure };

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

/**
 * What the worker input says about git history (CodingTaskInput.gitHistory, written only on such a run),
 * parsed once: whether it asks for history, and the paths in gitHistory.repositories (`/workspace`,
 * `/repos/<name>`). An input that does not parse counts as none: the bridge then uploads the whole
 * workspace, as before, and the worker refuses the input itself.
 */
export function inputGitHistory(input: Buffer): { requested: boolean; paths: ReadonlySet<string> } {
  const paths = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(input.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return { requested: false, paths };
    const history = (parsed as { gitHistory?: unknown }).gitHistory;
    if (typeof history !== "object" || history === null) return { requested: false, paths };
    const repositories = (history as { repositories?: unknown }).repositories;
    if (Array.isArray(repositories)) {
      for (const entry of repositories) {
        const path = typeof entry === "object" && entry !== null ? (entry as { path?: unknown }).path : undefined;
        if (typeof path === "string") paths.add(path);
      }
    }
    return { requested: true, paths };
  } catch {
    return { requested: false, paths: new Set() };
  }
}

/** The round a row's actors are on (the row records it; round.json is the bridges' and the proxy's copy). */
function roundOf(record: SubstrateRunRecord): number {
  return record.round ?? 1;
}

/** The names of a spec's extra repositories, in spec order (none for a spec without any). */
function repositoryNames(spec: JobSpec): string[] {
  return (spec.repositories ?? []).map((r) => r.name);
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
  // The proxy refused a bridge of another protocol (BLOB.bridgeRefused): an image from another release.
  bridge_incompatible: {
    status: { state: "failed" },
    result: { exitCode: 1, reason: "failed", diagnostic: "substrate_bridge_incompatible" },
  },
  // A template of the run failed its golden snapshot twice in the window, or never became ready.
  image_unready: {
    status: { state: "failed" },
    result: { exitCode: 1, reason: "failed", diagnostic: "substrate_image_unready" },
  },
  // collect_timeout: its result carries the worker's exit report (see observe).
  // image_incomplete: its diagnostic carries the reported item (see observe).
  // Warm rounds: a run whose parked actors another run took over had succeeded.
  adopted: { status: { state: "succeeded" }, result: { exitCode: 0, reason: "completed" } },
};

/** The blobs observe() reads an outcome from besides `done`, which remove() deletes after them. */
const OUTCOME_BLOBS: readonly ((token: string, round?: number) => string)[] = [BLOB.result, BLOB.exit];
/**
 * The run's (not a round's) outcome blobs: the image report, which observe() reads an
 * image_incomplete run's item from. Deleted with the outcome, once.
 */
const OUTCOME_RUN_BLOBS: readonly ((token: string) => string)[] = [BLOB.imageIncomplete];
/** The per-round names among ROUND_BLOBS that carry a round's outcome (deleted last). */
const OUTCOME_ROUND_BLOBS: readonly (typeof ROUND_BLOBS)[number][] = ["result", "exit", "done"];

/** Outcomes whose actors are deleted when recorded: the run must not keep running. */
const STOP_ACTORS_ON: readonly SubstratePhase[] = [
  "timed_out",
  "collect_timeout",
  "startup_timeout",
  "bridge_incompatible",
  "image_incomplete",
];

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

/**
 * A spec's services: 1..MAX_CODING_SERVICES validated catalog snapshots (else substrate_spec_invalid),
 * each one this launcher can start (else substrate_feature_unsupported:services: the backstop of the
 * dispatch check, unstartableServices).
 */
function validateServices(spec: JobSpec): void {
  if (spec.services === undefined) return;
  const parsed = StoredCodingServicesSchema.safeParse(spec.services);
  if (!parsed.success || spec.services.length < 1 || spec.services.length > MAX_CODING_SERVICES) {
    throw new Error("substrate_spec_invalid");
  }
  if (substrateServiceProblems(spec.services).length > 0) throw new Error("substrate_feature_unsupported:services");
}

/**
 * Substrate runs Claude Code (two actors) and Codex (one) on any registry-digest images (a custom
 * workerImageRef included: it must carry this release's bridge, which the proxy's protocol check and
 * the bridge's own image check verify at run time), without the features that need more actors or
 * extra secrets. A local image ID or a tag is refused (substrate_image_not_digest). MCP tools
 * are supported: the run's MCP token is a key of the per-run Secret, injected by the agent's egress
 * rule (never in a template, an env or a blob). Extra repositories are supported on both shapes: the
 * list must be well formed (jobRepositoriesValid, so every name is a link name before the claim);
 * each host path is checked against the workspace root in launch (checkRepositoryPaths). The
 * dependency cache is supported on both shapes: the cache lives behind the coding proxy and the blob
 * store, keyed by the run's recorded image; an adopted round skips it (`workspaceReused`). Coding
 * services are supported on both shapes (validateServices).
 */
function validateSpec(spec: JobSpec): void {
  if (spec.kind !== "coding-agent" || !RUN_ID.test(spec.runId)) throw new Error("substrate_spec_invalid");
  validateWarm(spec);
  if (!jobRepositoriesValid(spec)) throw new Error("substrate_spec_invalid");
  if (spec.provider === "claude-code") {
    if (!isRepositoryDigest(spec.image) || spec.toolImage === undefined || !isRepositoryDigest(spec.toolImage)) {
      throw new Error("substrate_image_not_digest");
    }
    validateServices(spec);
  } else if (spec.provider === "codex") {
    if (!isRepositoryDigest(spec.image)) throw new Error("substrate_image_not_digest");
    // One actor: a tool image has nowhere to run.
    if (spec.toolImage !== undefined) throw new Error("substrate_spec_invalid");
    validateServices(spec);
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
  private readonly templates: SubstrateTemplateStore;
  private readonly templateReadyMs: number;
  private readonly templateRetryMs: number;
  private readonly templateTtlMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly warm: WarmRoundsOptions | undefined;
  /** WorkspaceJobLauncher.warmRounds: set from the configuration (warm rounds on). */
  readonly warmRounds: boolean;
  private lastSweepAt = Number.NEGATIVE_INFINITY;
  private lastTemplateSweepAt = Number.NEGATIVE_INFINITY;
  /**
   * The never-ready clock: per template name, when this control plane first saw a resume on it
   * refused while the workers had room (neverReady). In memory only, so a restart or another replica
   * starts its own clock: that errs toward requeueing, never toward failing a healthy template. At
   * most NEVER_READY_TRACKED names; removed once the template is ready.
   */
  private readonly refusedWithRoomSince = new Map<string, number>();

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
    // A services run waits SERVICE_START_MARKER_MS for its services before startup_timeout can apply.
    if (!Number.isFinite(this.startupTimeoutMs) || this.startupTimeoutMs < SERVICE_START_MARKER_MS) {
      throw new Error("substrate_startup_timeout_invalid");
    }
    this.templates = options.templates;
    this.templateReadyMs = options.templateReadyMs ?? DEFAULT_TEMPLATE_READY_MS;
    this.templateRetryMs = options.templateRetryMs ?? DEFAULT_TEMPLATE_RETRY_MS;
    this.templateTtlMs = Math.max(options.templateTtlMs ?? DEFAULT_TEMPLATE_TTL_MS, templateTtlFloorMs());
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  /** Kubernetes, Docker and Substrate start services for every coding provider (Codex, Claude Code, Gemini CLI). */
  supportsServicesFor(_provider: CodingProvider): boolean {
    return true;
  }

  /**
   * Never a docker service (rootless dockerd), which is Kubernetes-with-gVisor only; servicesInOrder is
   * the backstop. A toolchain is answered by unstartableServices (service_launcher_unsupported).
   */
  supportsServiceKind(kind: CodingServiceKind): boolean {
    return kind !== "docker";
  }

  /**
   * substrateServiceProblems: no start command, a reserved data path, or a setup too large (16 KiB per
   * start script, 64 KiB per run, both measured JSON-escaped, as staged). Dispatch refuses the run
   * with the first one's sentence, so an oversized script never reaches a launch.
   */
  unstartableServices(services: readonly ResolvedCodingService[]): UnstartableService[] {
    return substrateServiceProblems(services);
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
    // Before the sweep, any adoption or the claim: a misplaced host path leaves nothing behind.
    this.checkRepositoryPaths(spec);
    const token = substrateRunToken(spec.runId);
    const specHash = stableSpecHash(spec);
    const deadline = () => new Date(this.now() + spec.timeoutSec * 1000);
    let coldReason: WarmColdReason | undefined;
    // Removal of kept rounds never depends on the switch (warm rounds off: every one goes).
    await this.sweepParkedSometimes();
    await this.sweepTemplatesSometimes();
    // A single-shape (Codex) run never adopts: it always launches cold, with no cold reason. Nor does
    // a run with extra repositories (W1; the executor never asks one to): cold, no cold reason, and
    // the park it names is left alone.
    if (this.warm && templates.shape === "pair" && spec.repositories === undefined) {
      // A relaunch of a run that has a row keeps whatever that row says.
      if (!(await this.runs.get(spec.runId))) {
        if (!(await this.fits(templates))) await this.evictUntilFits(templates, spec.warm?.fromRunId);
        const outcome = await this.adoptParked(spec, templates, specHash, deadline());
        if (outcome?.adopted || outcome?.launched) return this.handleFor(spec.runId);
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
      // Names and access only: a host path never reaches the row.
      ...(spec.repositories ? { repositories: spec.repositories.map(({ name, access }) => ({ name, access })) } : {}),
      // Names only (the store sorts): never an env value, an image or a command.
      ...(spec.services ? { services: spec.services.map((s) => s.name) } : {}),
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
      // A cold relaunch refused for capacity keeps the reason it went cold for (actor_missing).
      const fields =
        refusedAdopter && claimed.record.coldReason === undefined ? { coldReason: "capacity" as const } : {};
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
   * Extracts the tool actor's posted workspace tar into the run's own folder; with `name`, a writable
   * extra's posted tar (REPO_BLOB.workspace) into its own repos/<name>/workspace. With `gitHistory`
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
    const record = await this.requireRecord(handle);
    if ((await this.observe(record)).status.state !== "succeeded") throw new Error("job_not_succeeded");
    if (name === undefined) {
      const expected = resolve(this.workspaceRoot, record.runId, "workspace");
      if (resolve(destination) !== expected || !expected.startsWith(`${this.workspaceRoot}${sep}`)) {
        throw new Error("substrate_workspace_destination_invalid");
      }
      return this.extractCollected(BLOB.workspace(record.token, roundOf(record)), expected, options);
    }
    // Only a writable extra of the launched spec (its row) is ever collected, into its own folder,
    // as on Kubernetes: a read or unknown one is refused before any blob is read.
    if (!record.repositories?.some((r) => r.name === name && r.access === "write")) {
      throw new Error("substrate_workspace_destination_invalid");
    }
    const expected = expectedRepositoryHostPath(this.workspaceRoot, record.runId, name);
    if (!expected || resolve(destination) !== expected || !expected.startsWith(`${this.workspaceRoot}${sep}`)) {
      throw new Error("substrate_workspace_destination_invalid");
    }
    return this.extractCollected(REPO_BLOB.workspace(record.token, name, roundOf(record)), expected, options);
  }

  /**
   * Extracts the collected tar at `key` into `expected` (already checked to be the run's own folder):
   * the blob's size bounds the tree and any result bundle; a history run's root .git leaves for its
   * bundle before validation. Shared by the default workspace and every writable extra.
   */
  private async extractCollected(
    key: string,
    expected: string,
    options: MaterializeWorkspaceOptions,
  ): Promise<MaterializedWorkspace> {
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
    return this.readRoundOutput(handle, BLOB.transcript, maxBytes, "transcript_too_large");
  }

  async readPlanFiles(handle: JobHandle, maxBytes: number): Promise<string | undefined> {
    return this.readRoundOutput(handle, BLOB.planFiles, maxBytes, "plan_files_too_large");
  }

  /** The current round's output blob, at most maxBytes; undefined when absent or the run is removed. */
  private async readRoundOutput(
    handle: JobHandle,
    blob: (token: string, round?: number) => string,
    maxBytes: number,
    tooLarge: string,
  ): Promise<string | undefined> {
    const record = await this.recordFor(handle);
    if (!record || record.phase === "removed") return undefined;
    const key = blob(record.token, roundOf(record));
    const info = await this.blobs.head(key);
    if (!info) return undefined;
    if (info.sizeBytes > maxBytes) throw new Error(tooLarge);
    let body: Buffer;
    try {
      body = await this.blobs.get(key);
    } catch (error) {
      if (isBlobNotFound(error)) return undefined;
      throw error;
    }
    if (body.length > maxBytes) throw new Error(tooLarge);
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
    await this.removeInFull(record.token, roundOf(record), shapeOf(record), this.repositoryNamesOf(record));
    // The row stays as the tombstone, so the run is never relaunched.
    await this.runs.setPhase(record.runId, "removed");
  }

  // -------------------------------------------------------------------------
  // Launch

  private templatesFor(spec: JobSpec): RunTemplates {
    validateSpec(spec);
    if (spec.provider === "codex") return { shape: "single", agent: codexTemplate(spec, this.config) };
    return { shape: "pair", agent: agentTemplate(spec, this.config), tool: toolTemplate(spec, this.config) };
  }

  /**
   * Each extra repository's host path must be the run's own repos/<name>/workspace under the
   * workspace root (as the Docker and Kubernetes launchers check), else substrate_workspace_path_invalid.
   */
  private checkRepositoryPaths(spec: JobSpec): void {
    for (const entry of spec.repositories ?? []) {
      const expected = expectedRepositoryHostPath(this.workspaceRoot, spec.runId, entry.name);
      if (!expected || resolve(entry.hostPath) !== expected) throw new Error("substrate_workspace_path_invalid");
    }
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

  /** The run's MCP token for a spec with mcpTools (refused unless well formed); undefined otherwise, unasked. */
  private async mcpTokenFor(spec: JobSpec): Promise<string | undefined> {
    if (!spec.mcpTools) return undefined;
    const token = await this.options.resolveMcpToken?.(spec.runId);
    if (!isMcpToken(token)) throw new Error("substrate_mcp_token_invalid");
    return token;
  }

  private async provision(spec: JobSpec, token: string, templates: RunTemplates): Promise<void> {
    const { atespace } = this.config;
    const { shape } = templates;
    const agent = agentActorName(token);
    const tool = toolActorName(token);
    // Each Substrate call is named when it fails, so a refusal is diagnosable from wardby's log.
    // An error `recoverable` names is rethrown without a report: the caller recovers from it, and
    // reports only if that fails.
    const call = namedCall(spec.runId, (failure) => this.reportCallFailure(failure));
    // The template of the actor being resumed, so a refusal names the one refused (neverReady).
    let resuming: ActorTemplateSpec | undefined;
    // The template of the actor being created or resumed: a Substrate failure there may be its
    // golden snapshot failing (goldenFailureAfter).
    let starting: ActorTemplateSpec | undefined;
    // The template being ensured: a TemplateUnreadyError from it may be a service's image (servicesBlame).
    let ensuring: ActorTemplateSpec | undefined;
    // The holder (the tool actor of a pair, the one actor of a single): it runs the services.
    const holder = shape === "pair" ? tool : agent;
    const holderTemplate = templates.shape === "pair" ? templates.tool : templates.agent;
    try {
      const capability = await this.options.resolveCapability(spec.runId);
      if (!CAPABILITY.test(capability)) throw new Error("substrate_capability_invalid");
      const mcpToken = await this.mcpTokenFor(spec);
      for (const template of actorTemplates(templates)) {
        ensuring = template;
        await this.ensureTemplate(template, call);
      }
      ensuring = undefined;
      const input = await this.stageInput(spec.inputArtifact, token);
      const history = inputGitHistory(input);
      const waitMs = await this.stageSetup(spec, capability, token, history.requested, history.paths);
      await this.stageSeed(spec, token);
      try {
        await this.options.secrets.createSecret(
          this.config.credentialsNamespace,
          runSecret(token, capability, this.config, mcpToken),
        );
      } catch (error) {
        if (!(error instanceof KubernetesAlreadyExistsError)) throw error;
      }
      // A launch here is always cold (round 1), so it never takes over an actor it did not just
      // create from the template: one already under this name was left by an earlier attempt whose
      // cleanup failed (a refused adopter's may hold a used workspace). It is deleted, with its
      // egress policy, and created again. If it cannot be deleted, or is still there after, the
      // launch fails (substrate_already_exists) and nothing ever resumes it.
      const templateOf = (name: string): ActorTemplateSpec =>
        name !== agent && templates.shape === "pair" ? templates.tool : templates.agent;
      for (const name of actorNamesFor(token, shape)) {
        const template = templateOf(name);
        starting = template;
        // If the cleanup sweep removed the template between its ensure and here (its row went just
        // before a concurrent bump), Substrate answers FailedPrecondition (or NotFound): ensure it
        // once more (recorded again) and create once more. A second such answer fails the launch.
        // The first answer is not reported: only a failed retry is a failed Substrate call.
        await createFreshActor(this.api, atespace, name, template.name, call, () =>
          this.ensureTemplate(template, call),
        );
        starting = undefined;
      }
      // After the actors: an egress policy belongs to its actor (a foreign key in Substrate). Every
      // policy is in place before any actor resumes, so none ever runs without one. A single-shape
      // run's one actor gets the agent's rule only (no tool rule, no actor JWT). With MCP tools the
      // agent's rule also fills the MCP token header; the tool's never does.
      await call("putEgressPolicy", () =>
        this.api.putEgressPolicy(atespace, agent, agentEgress(token, this.config, { mcp: mcpToken !== undefined })),
      );
      if (shape === "pair") {
        await call("putEgressPolicy", () => this.api.putEgressPolicy(atespace, tool, toolEgress(this.config)));
      }
      if (waitMs !== undefined) {
        // Services: the holder first, alone, until every service is ready; only then the agent (pair).
        resuming = starting = holderTemplate;
        await call("resumeActor", () => this.api.resumeActor(atespace, holder));
        resuming = starting = undefined;
        const ready = await this.waitForServices(spec, token, holder, waitMs + SERVICES_GRACE_MS);
        // Not ready but no failure: the run was stopped or timed out meanwhile (setPhase below sees it).
        if (ready && shape === "pair") {
          resuming = starting = templates.agent;
          await call("resumeActor", () => this.api.resumeActor(atespace, agent));
        }
      } else {
        if (shape === "pair") {
          // The tool first: the agent's first tool call needs it.
          resuming = starting = templates.tool;
          await call("resumeActor", () => this.api.resumeActor(atespace, tool));
        }
        resuming = starting = templates.agent;
        await call("resumeActor", () => this.api.resumeActor(atespace, agent));
      }
      starting = undefined;
    } catch (caught) {
      // Clean up before recording requeued, so a relaunch never races this cleanup.
      await this.cleanup(token, 1, shape, repositoryNames(spec));
      // A create or resume Substrate refused Unavailable on a template whose golden snapshot failed:
      // counted as a golden-snapshot failure, so the run requeues or fails as substrate_image_unready
      // by the same rules as at ensureTemplate, not substrate_unavailable. On a template still
      // building (no tag, never started an actor) it requeues uncounted. A missing template
      // (TemplateMissing, NotFound) is never a failed build: its own error stands.
      const refused = starting;
      const golden =
        refused && caught instanceof SubstrateUnavailableError
          ? await this.goldenFailureAfter(refused, call)
          : undefined;
      const error: unknown = golden ?? caught;
      // A run with services whose holder template cannot start, while the same holder without
      // services is known good: the first service's image is the suspect (coding_service_unready).
      const unready = error instanceof TemplateUnreadyError ? (ensuring ?? refused) : undefined;
      const blamed =
        unready?.name === holderTemplate.name
          ? await this.servicesBlame(spec, templates).catch(() => undefined)
          : undefined;
      if (blamed !== undefined) {
        await reportServiceState(this.options.onServiceState, {
          runId: spec.runId,
          name: blamed,
          state: "failed",
          reason: "image_unavailable",
        });
        await this.runs.setPhase(spec.runId, "provisioning_failed", ["provisioning"]).catch(() => undefined);
        throw serviceUnreadyError(blamed);
      }
      // A template that cannot start an actor: the run fails now (substrate_image_unready) and is
      // never requeued. The launch resolves with its handle; status() answers the recorded failure.
      // A still-building template refused past SUBSTRATE_TEMPLATE_READY_SEC is never ready, as a
      // refused resume is.
      if (
        error instanceof TemplateUnreadyError ||
        (error instanceof TemplateBuildingError && refused && (await this.neverReady(templates, refused))) ||
        (error instanceof SubstrateExhaustedError && resuming && (await this.neverReady(templates, resuming)))
      ) {
        await this.runs.setPhase(spec.runId, "image_unready", ["provisioning"]).catch(() => undefined);
        return;
      }
      if (error instanceof SubstrateExhaustedError) {
        await this.runs.setPhase(spec.runId, "requeued", ["provisioning"]).catch(() => undefined);
        throw new JobCapacityError("substrate_capacity: no worker has room", { cause: error });
      }
      if (error instanceof TemplateRebuildingError) {
        await this.runs.setPhase(spec.runId, "requeued", ["provisioning"]).catch(() => undefined);
        throw new JobCapacityError("substrate_capacity: template rebuilding", { cause: error });
      }
      if (error instanceof TemplateBuildingError) {
        await this.runs.setPhase(spec.runId, "requeued", ["provisioning"]).catch(() => undefined);
        throw new JobCapacityError("substrate_capacity: template building", { cause: error });
      }
      await this.runs.setPhase(spec.runId, "provisioning_failed", ["provisioning"]).catch(() => undefined);
      throw error;
    }
    try {
      await this.runs.setPhase(spec.runId, "running", ["provisioning"]);
    } catch (error) {
      if (!isPhaseConflict(error)) {
        await this.cleanup(token, 1, shape, repositoryNames(spec));
        await this.runs.setPhase(spec.runId, "provisioning_failed", ["provisioning"]).catch(() => undefined);
        throw error;
      }
      // Stopped or timed out while provisioning: whoever moved it may have deleted the actors
      // before they existed, so delete them again.
      await this.deleteActors(token, shape);
      return;
    }
    // Every actor resumed from its template: each one is ready (best effort, never fails the run).
    const readyNames = actorTemplates(templates).map((t) => t.name);
    for (const name of readyNames) this.refusedWithRoomSince.delete(name);
    await this.templates.markReady(readyNames, new Date(this.now())).catch(() => undefined);
  }

  /**
   * After the holder resumed, for a run with services: reports every service pending once, then
   * reads BLOB.services every SERVICES_POLL_MS (parseServicesReport: only the validated name, state,
   * attempts and reason ever reach onServiceState, each change once) until all are ready. Throws
   * serviceUnreadyError(name) for a failed one; for the first not-ready one (by name) when the
   * holder is gone or crashed (start_failed) or `boundMs` passed (timed_out), reporting it failed. A
   * report that does not parse is ignored (the next poll reads it again). True once all are ready (and the run is still provisioning);
   * false, reporting nothing, when the run left provisioning meanwhile (stopped or timed out: its
   * actors are deleted).
   */
  private async waitForServices(spec: JobSpec, token: string, holder: string, boundMs: number): Promise<boolean> {
    const names = servicesInOrder(spec.services ?? []).map((s) => s.name);
    type Seen = { state: ServiceState; attempts?: number; reason?: ServiceFailureReason };
    const seen = new Map<string, Seen>();
    const report = async (name: string, next: Seen): Promise<void> => {
      const last = seen.get(name);
      if (last && last.state === next.state && last.attempts === next.attempts && last.reason === next.reason) return;
      seen.set(name, next);
      await reportServiceState(this.options.onServiceState, {
        runId: spec.runId,
        name,
        state: next.state,
        ...(next.attempts !== undefined ? { attempts: next.attempts } : {}),
        ...(next.reason !== undefined ? { reason: next.reason } : {}),
      });
    };
    const failFirstNotReady = async (reason: ServiceFailureReason): Promise<never> => {
      const name = names.find((n) => seen.get(n)?.state !== "ready") ?? names[0];
      await report(name, { state: "failed", reason });
      throw serviceUnreadyError(name);
    };
    for (const name of names) await report(name, { state: "pending" });
    const started = this.now();
    for (;;) {
      const value = await this.readJson(BLOB.services(token), MAX_SERVICES_REPORT_BYTES).catch(() => undefined);
      const entries = value ? parseServicesReport(value, names) : undefined;
      for (const entry of entries ?? []) {
        await report(entry.name, {
          state: entry.state,
          ...(entry.attempts !== undefined ? { attempts: entry.attempts } : {}),
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        });
      }
      if (names.every((name) => seen.get(name)?.state === "ready")) {
        // A stop between the ready report and here deleted the actors: the agent must not resume.
        return (await this.runs.get(spec.runId))?.phase === "provisioning";
      }
      const failed = names.find((name) => seen.get(name)?.state === "failed");
      if (failed !== undefined) throw serviceUnreadyError(failed);
      const actor = await this.api.getActor(this.config.atespace, holder).then(
        (info) => info ?? null,
        // Unreadable now: the next poll asks again (the bound still applies).
        () => undefined,
      );
      if (actor === null || actor?.state === "CRASHED") {
        if ((await this.runs.get(spec.runId))?.phase !== "provisioning") return false;
        await failFirstNotReady("start_failed");
      }
      if (this.now() - started > boundMs) await failFirstNotReady("timed_out");
      await this.sleep(SERVICES_POLL_MS);
    }
  }

  /**
   * For a run with services whose holder template is unready: the first service by name when the
   * same spec's holder template without services has been ready (its SubstrateTemplate row has
   * readyAt), since the holder's own image is then known good; undefined otherwise (the holder image
   * is the suspect, and substrate_image_unready stands).
   */
  private async servicesBlame(spec: JobSpec, templates: RunTemplates): Promise<string | undefined> {
    const services = servicesInOrder(spec.services ?? []);
    if (services.length === 0) return undefined;
    const plain = { ...spec, services: undefined };
    const name =
      templates.shape === "pair" ? toolTemplate(plain, this.config).name : codexTemplate(plain, this.config).name;
    const row = await this.templates.get(name);
    return row?.readyAt ? services[0].name : undefined;
  }

  /**
   * Whether a refused resume is an image that never becomes ready rather than a full cluster: the
   * workers are known to have room for the run (a worker list that cannot be read is not room), and
   * the refused actor's template is not ready and has been refused with room for longer than
   * templateReadyMs. A template that has started an actor (readyAt) is never failed here, whatever
   * Substrate's status says. Otherwise not ready is Substrate's golden-snapshot status when it
   * reports one (no tag yet; a tag marks the template ready), or no status at all. The time is counted since this control plane first saw it refused with room
   * (refusedWithRoomSince), or since its window's first golden-snapshot failure when that is later.
   * Time a new template spent waiting for real capacity never counts, and neither does its
   * createdAt. Reports that template. Any store error: false (the run requeues, as before).
   */
  private async neverReady(templates: RunTemplates, refused: ActorTemplateSpec): Promise<boolean> {
    try {
      const free = await this.freeRoom();
      if (free === undefined || !placeable(free, templates)) return false;
      const row = await this.templates.get(refused.name);
      if (!row) return false;
      // An actor from it reached running once: proven, whatever Substrate's status says now.
      if (row.readyAt !== undefined) return false;
      const ready = await this.goldenSnapshotReady(refused, row.role);
      if (ready === true) {
        await this.markTemplateReady(refused.name);
        return false;
      }
      const now = this.now();
      let seen = this.refusedWithRoomSince.get(refused.name);
      if (seen === undefined) {
        if (this.refusedWithRoomSince.size >= NEVER_READY_TRACKED) {
          const oldest = this.refusedWithRoomSince.keys().next().value;
          if (oldest !== undefined) this.refusedWithRoomSince.delete(oldest);
        }
        this.refusedWithRoomSince.set(refused.name, now);
        seen = now;
      }
      const since = Math.max(seen, row.lastFailureAt?.getTime() ?? Number.NEGATIVE_INFINITY);
      if (now - since <= this.templateReadyMs) return false;
      this.templateEvent({
        event: "substrate_template_unready",
        name: row.name,
        role: row.role,
        reason: "never_ready",
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Substrate's golden-snapshot ready signal for the template (TemplateInfo.goldenSnapshotReady), or
   * undefined when it is not known: no status reported, a status that cannot be read, or a failed
   * golden build (a failure always wins over a tag; ensureTemplate handles it on the next launch).
   */
  private async goldenSnapshotReady(
    template: ActorTemplateSpec,
    role: SubstrateTemplateRole,
  ): Promise<boolean | undefined> {
    try {
      const info = await this.api.getActorTemplate(template.atespace, template.name);
      if (!info || info.goldenSnapshotFailed) return undefined;
      return info.goldenSnapshotReady;
    } catch {
      this.templateEvent({ event: "substrate_template_status_read_failed", name: template.name, role });
      return undefined;
    }
  }

  /** Marks the template ready (readyAt) and drops its never-ready clock; best effort. */
  private async markTemplateReady(name: string): Promise<void> {
    this.refusedWithRoomSince.delete(name);
    await this.templates.markReady([name], new Date(this.now())).catch(() => undefined);
  }

  /**
   * Records the template (its SubstrateTemplate row, created or its lastUsedAt bumped; a store that
   * cannot be written fails the launch), then creates it unless it exists. An existing template
   * whose golden snapshot build failed for good can never start an actor: the failure is counted in
   * the row's window (SUBSTRATE_TEMPLATE_RETRY_SEC, anchored at its first failure). The first one in
   * a window deletes the template and creates it again, once per launch (a fresh golden snapshot
   * build follows); a second one within the window fails the run (TemplateUnreadyError:
   * substrate_image_unready) without rebuilding, since the image itself is broken. A failure seen
   * within TEMPLATE_SAME_BUILD_MS of the window's first is that same build, seen by a concurrent
   * launch: not counted again, and this launch requeues (TemplateRebuildingError) without deleting
   * the template the other launch is rebuilding. A record that cannot be written is logged
   * (substrate_template_record_failed) and counts as no earlier failure (rebuilt). A template's
   * name is derived from its image, size and settings, so the one deleted is this same spec.
   * Substrate's failure message is never read (the client maps only goldenSnapshotFailed).
   */
  private async ensureTemplate(template: ActorTemplateSpec, call: NamedCall): Promise<void> {
    const { name, atespace } = template;
    const role = templateRoleOf(name);
    // Every name templatesFor builds has a role; one without is a broken invariant, never a Prisma write.
    if (!role) throw new Error("substrate_template_name_invalid");
    await this.templates.touch({ name, atespace, role, image: template.containers[0].image }, new Date(this.now()));
    let count: GoldenFailureCount | undefined;
    let recorded = false;
    let deleted = false;
    const tracked: NamedCall = async (callName, fn, recoverable) => {
      const result = await call(callName, fn, recoverable);
      if (callName === "deleteActorTemplate") deleted = true;
      return result;
    };
    let info: TemplateInfo | undefined;
    try {
      info = await ensureSubstrateTemplate(this.api, template, tracked, async () => {
        count = await this.recordGoldenFailure(template, role);
        recorded = true;
      });
    } catch (error) {
      // No rebuild was tried (the delete failed), so this launch's count must not make a later one
      // fail as unready for a build that never happened: take it back (best effort; the window's
      // anchor stays).
      if (recorded && !deleted && count) {
        await this.templates.withdrawGoldenFailure(name, count.failures).catch(() => undefined);
      }
      throw error;
    }
    // Rebuilt just now: this launch never resumes against the rebuilding template. It requeues, and
    // the relaunch after the backoff sees the new build's outcome.
    if (recorded) throw new TemplateRebuildingError();
    // Substrate says its golden snapshot is built: the template is ready (best effort).
    if (info?.goldenSnapshotReady === true) await this.markTemplateReady(name);
  }

  /**
   * After a createActor or resumeActor Substrate refused Unavailable (provision): whether that was the
   * actor's template failing its golden snapshot. This re-reads the status. Only a failed golden
   * snapshot (goldenSnapshotFailed) is counted, by ensureTemplate's rules: TemplateRebuildingError
   * (requeue: the same build, or a first failure, whose rebuild is started here) or
   * TemplateUnreadyError (a second failure: substrate_image_unready). A golden-snapshot status with
   * no tag yet on a template that never started an actor (no readyAt) is the normal window of a new
   * template's first run: TemplateBuildingError (requeue, uncounted, no rebuild; a broken build
   * reports its failure by the relaunch, and ensureTemplate counts it then). Undefined otherwise (a
   * ready or missing template, a status or row that cannot be read, a rebuild that failed): the
   * call's own error stands.
   */
  private async goldenFailureAfter(
    template: ActorTemplateSpec,
    call: NamedCall,
  ): Promise<TemplateUnreadyError | TemplateRebuildingError | TemplateBuildingError | undefined> {
    const role = templateRoleOf(template.name);
    if (!role) return undefined;
    let info: TemplateInfo | undefined;
    try {
      info = await this.api.getActorTemplate(template.atespace, template.name);
    } catch {
      this.templateEvent({ event: "substrate_template_status_read_failed", name: template.name, role });
      return undefined;
    }
    // Gone: a sweep removed it, not a failed build.
    if (!info) return undefined;
    if (!info.goldenSnapshotFailed) {
      // Only a reported status without a golden tag (or without a golden-snapshot status): no status at all (undefined) says nothing either way.
      if (info.goldenSnapshotReady !== false) return undefined;
      try {
        const row = await this.templates.get(template.name);
        if (!row || row.readyAt !== undefined) return undefined;
      } catch {
        return undefined;
      }
      // Still building: never counted and never rebuilt here.
      return new TemplateBuildingError();
    }
    try {
      await this.countGoldenFailure(template, role, call);
    } catch (error) {
      if (error instanceof TemplateUnreadyError || error instanceof TemplateRebuildingError) return error;
      // The rebuild failed (a failed delete took the count back): the call's own error stands.
      return undefined;
    }
    // A first failure: rebuilt. The run waits for the rebuild in the queue.
    return new TemplateRebuildingError();
  }

  /**
   * Records a golden-snapshot failure of `template` in its row's window and refuses a rebuild when it
   * should not happen: the same build throws TemplateRebuildingError, a second failure throws
   * TemplateUnreadyError. Otherwise returns the count (undefined when it cannot be written: counts as
   * no earlier failure), and the caller deletes the template and creates it again.
   */
  private async recordGoldenFailure(
    template: ActorTemplateSpec,
    role: SubstrateTemplateRole,
  ): Promise<GoldenFailureCount | undefined> {
    const { name } = template;
    let count: GoldenFailureCount | undefined;
    try {
      count = await this.templates.recordGoldenFailure(
        name,
        new Date(this.now()),
        this.templateRetryMs,
        TEMPLATE_SAME_BUILD_MS,
      );
    } catch {
      // Counts as no earlier failure: the template is rebuilt, as before. Fixed fields only.
      this.templateEvent({ event: "substrate_template_record_failed", name, role });
    }
    if (count?.sameBuild) throw new TemplateRebuildingError();
    if (count) this.templateEvent({ event: "substrate_template_golden_failed", name, role, failures: count.failures });
    if (count && count.failures > 1) {
      this.templateEvent({ event: "substrate_template_unready", name, role, reason: "golden_failed" });
      throw new TemplateUnreadyError();
    }
    return count;
  }

  /**
   * Counts a golden-snapshot failure of `template` and acts on it (see ensureTemplate and
   * recordGoldenFailure): a first one deletes the template and creates it again (a failed delete
   * takes the count back and throws the delete's error).
   */
  private async countGoldenFailure(
    template: ActorTemplateSpec,
    role: SubstrateTemplateRole,
    call: NamedCall,
  ): Promise<void> {
    const { name, atespace } = template;
    const count = await this.recordGoldenFailure(template, role);
    try {
      await call("deleteActorTemplate", () => this.api.deleteActorTemplate(atespace, name));
    } catch (error) {
      // No rebuild was tried, so this launch's count must not make a later one fail as unready for a
      // build that never happened: take it back (best effort; the window's anchor stays).
      if (count) await this.templates.withdrawGoldenFailure(name, count.failures).catch(() => undefined);
      throw error;
    }
    await call("ensureActorTemplate", () => this.api.ensureActorTemplate(template));
  }

  private templateEvent(event: TemplateEvent): void {
    try {
      if (this.options.onTemplateEvent) this.options.onTemplateEvent(event);
      else if (event.event === "substrate_template_removed") substrateLog.info({ ...event }, event.event);
      else substrateLog.warn({ ...event }, event.event);
    } catch {
      // Reporting never changes the launch's outcome.
    }
  }

  /**
   * The setup blob, for the workspace holder (the tool actor, or a Codex run's one actor): the
   * run's registry-only token lives here (and in the holder) only. Claude Code: the tool setup with
   * the exclusions; Codex: codexWorkerSetup. `collectResultBundle` (a run with git history, #536):
   * the holder's workspace upload then carries, from the root `.git`, only the result bundle
   * (materializeWorkspace takes it); set only then, so a bridge without history uploads as before.
   * `repositories` (a run with extras only): each extra's name and access, and a result bundle for a
   * write extra in the input's history (`historyPaths`); never a host path. `workspaceReused` (the
   * adopt path only): the tool setup says so on a dependency-cache run, and the tool runner skips
   * the cache.
   */
  private async stageSetup(
    spec: JobSpec,
    capability: string,
    token: string,
    collectResultBundle: boolean,
    historyPaths: ReadonlySet<string>,
    workspaceReused = false,
  ): Promise<number | undefined> {
    // Bounded before any launch: validateSpec's jobRepositoriesValid allows at most 16 (MAX_RUN_REPOSITORIES_IN_INPUT) valid, distinct names.
    const repositories = holderSetupRepositories(spec, historyPaths);
    // Services: each start script (it carries serviceEnv values: this blob is its only home outside
    // the holder), in name order, and the bridge's bound for all of them. Sized at dispatch and in
    // validateSpec (substrateServiceProblems) as JSON-escaped once, as they sit here.
    const services = spec.services
      ? servicesInOrder(spec.services).map((s) => ({ name: s.name, script: serviceStartScript(s) }))
      : undefined;
    const waitMs = spec.services ? servicesWaitMs(spec.services, this.startupTimeoutMs) : undefined;
    const body =
      spec.provider === "codex"
        ? codexWorkerSetup(spec, capability, {
            collectResultBundle,
            ...(repositories ? { repositories } : {}),
            ...(services && waitMs !== undefined ? { services: { entries: services, waitMs } } : {}),
          })
        : JSON.stringify({
            toolSetup: claudeToolSetup(spec, capability, {
              proxyBaseUrl: `http://${this.config.proxyHost}:${this.config.proxyPort}`,
              ...(workspaceReused ? { workspaceReused: true } : {}),
            }),
            // The Kubernetes launcher's default for a spec without exclusions: the built-in names.
            collectExclude: spec.collectExclude ?? collectExclusions([]),
            ...(collectResultBundle ? { collectResultBundle: true } : {}),
            ...(repositories ? { repositories } : {}),
            // Beside the tool setup, never inside it: the tool runner never sees a start script.
            ...(services ? { services, servicesWaitMs: waitMs } : {}),
          });
    await this.blobs.put(BLOB.toolSetup(token), Buffer.from(body), { contentType: "application/json" });
    return waitMs;
  }

  private reportCallFailure(failure: SubstrateCallFailure): void {
    reportCallFailure(failure, this.options.onSubstrateCallFailed, substrateLog);
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

  /**
   * Streams the run's prepared workspace, as a tar, into the seed blob, then each extra repository's
   * prepared folder (in spec order) into its own REPO_BLOB.seed. One limits.diskMb budget for all of
   * them, as on Kubernetes (one emptyDir): each seed may take only what the ones before it left.
   */
  private async stageSeed(spec: JobSpec, token: string): Promise<void> {
    const directory = resolve(this.workspaceRoot, spec.runId, "workspace");
    if (!directory.startsWith(`${this.workspaceRoot}${sep}`)) throw new Error("substrate_seed_failed");
    const budget = spec.limits.diskMb * MIB;
    let staged = await this.stageSeedDirectory(directory, BLOB.seed(token), budget);
    for (const entry of spec.repositories ?? []) {
      // launch checked it already (checkRepositoryPaths); the folder itself is checked here.
      staged += await this.stageSeedDirectory(
        resolve(entry.hostPath),
        REPO_BLOB.seed(token, entry.name),
        budget - staged,
      );
    }
  }

  /** One directory, as a tar, into one seed blob of at most `maxBytes`; returns the bytes staged. */
  private async stageSeedDirectory(directory: string, key: string, maxBytes: number): Promise<number> {
    if (maxBytes <= 0) throw new Error("substrate_seed_too_large");
    const found = await lstat(directory).catch(() => undefined);
    if (!found?.isDirectory()) throw new Error("substrate_seed_failed");
    const archive = hostTarArchive(directory);
    let sizeBytes: number;
    try {
      ({ sizeBytes } = await this.blobs.putStream(key, archive.stream, {
        contentType: "application/x-tar",
        maxBytes,
      }));
    } catch (error) {
      archive.stream.destroy();
      if (error instanceof BlobStoreError && error.code === "blob_too_large") {
        throw new Error("substrate_seed_too_large", { cause: error });
      }
      throw new Error("substrate_seed_failed", { cause: error });
    }
    if ((await archive.done) !== 0) throw new Error("substrate_seed_failed");
    return sizeBytes;
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
   * startupTimeoutMs (startup_timeout). A run whose bridge the proxy refused (BLOB.bridgeRefused)
   * fails as bridge_incompatible, checked before the actors and the startup timeout; one whose holder
   * reported its image incomplete (BLOB.imageIncomplete) fails as image_incomplete, right after.
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
    if (record.phase === "image_incomplete") {
      // The holder's image lacks the item: an enum value, re-checked (never free text from the blob).
      const item = await this.imageIncompleteItem(record.token);
      return {
        status: { state: "failed" },
        result: {
          exitCode: 1,
          reason: "failed",
          diagnostic: item ? `substrate_image_incomplete:${item}` : "substrate_image_incomplete",
        },
      };
    }
    if (record.phase === "requeued") return { status: { state: "pending", capacityRefused: true } };
    const reported = await this.reported(record, round);
    if (reported) return reported;
    if (this.now() > record.deadlineAt.getTime()) return this.settle(record, "timed_out");
    // Actors may not exist yet while a launch provisions them.
    if (record.phase === "provisioning") return { status: { state: "pending" } };
    // The proxy refused a bridge of another protocol: before the startup timeout, and before the
    // actors (a refused bridge may exit, which would read as lost or crashed).
    if (await this.blobs.head(BLOB.bridgeRefused(record.token))) return this.settle(record, "bridge_incompatible");
    // The holder's image check found a prerequisite missing: the bridge idles, so its actor never ends.
    if (await this.blobs.head(BLOB.imageIncomplete(record.token))) return this.settle(record, "image_incomplete");
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

  /** The item of the holder's image report, when it is one of SUBSTRATE_IMAGE_ITEMS. */
  private async imageIncompleteItem(token: string): Promise<SubstrateImageItem | undefined> {
    const report = await this.readJson(BLOB.imageIncomplete(token), MAX_MARKER_BYTES);
    const item = report && typeof report === "object" ? (report as { item?: unknown }).item : undefined;
    return isSubstrateImageItem(item) ? item : undefined;
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
    // A single-shape (Codex) run is never parked: warm rounds are Claude Code only. Nor is a run with
    // extra repositories (W1: runs with them never park or adopt; the executor never asks either).
    if (record.actorShape === "single" || record.repositories || record.repositoriesUnreadable) {
      await this.remove(handle);
      return false;
    }
    // Nor is a run with services (or an unreadable services column): its holder's service data
    // belongs to that round alone.
    if (record.services || record.servicesUnreadable) {
      this.warmEvent({
        event: "substrate_warm_removed",
        runId: record.runId,
        runToken: record.token,
        reason: "services",
      });
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
   * rounds off every park left from when they were on; then the templates no run used for the TTL
   * (sweepTemplates). Never throws.
   */
  async warmUp(): Promise<void> {
    this.lastSweepAt = this.now();
    await this.sweepParked().catch(() => undefined);
    this.lastTemplateSweepAt = this.now();
    await this.sweepTemplates().catch(() => undefined);
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
   * step fails: the caller then removes the run. First, best effort, the templates the actors were
   * created from (getActor's templateName, never a name recomputed from a spec) are marked used.
   */
  private async park(record: SubstrateRunRecord, retention: JobRetention): Promise<boolean> {
    const { atespace } = this.config;
    const startedAt = this.now();
    const clock = performance.now();
    const round = roundOf(record);
    await this.touchActorTemplates(record.token);
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
   * Bumps lastUsedAt on the templates a pair's actors were created from (getActor's templateName),
   * so the cleanup sweep never removes a template a parked chain still runs on. Never throws.
   */
  private async touchActorTemplates(token: string): Promise<void> {
    try {
      const { atespace } = this.config;
      const actors = await Promise.all([
        this.api.getActor(atespace, agentActorName(token)),
        this.api.getActor(atespace, toolActorName(token)),
      ]);
      const names = actors.map((actor) => actor?.templateName).filter((name): name is string => !!name);
      await this.templates.touchNames(names, new Date(this.now()));
    } catch {
      // Best effort: a park never fails for it.
    }
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
    await this.removeInFull(record.token, roundOf(record), "pair", this.repositoryNamesOf(record));
    try {
      await this.runs.setPhase(record.runId, "removed", ["parked"]);
    } catch (error) {
      // Another removal of the same park finished first: removed either way.
      if (!isPhaseConflict(error) || (await this.runs.get(record.runId))?.phase !== "removed") throw error;
    }
    return true;
  }

  private async sweepTemplatesSometimes(): Promise<void> {
    if (this.now() - this.lastTemplateSweepAt < TEMPLATE_SWEEP_INTERVAL_MS) return;
    this.lastTemplateSweepAt = this.now();
    await this.sweepTemplates().catch(() => undefined);
  }

  /**
   * Removes templates no launch, park or adoption used for the TTL: the row first (only while still
   * unused), then the Substrate template (a missing one is success). A failed Substrate delete puts the
   * row back (restore: only if no launch re-created it meanwhile), so the next sweep tries again.
   * Never throws; at most TEMPLATE_SWEEP_BATCH per call. A launch that bumped the row just after its
   * delete and finds the template gone at createActor ensures it again (provision).
   */
  async sweepTemplates(): Promise<void> {
    try {
      const now = this.now();
      const cutoff = new Date(now - this.templateTtlMs);
      for (const row of await this.templates.listUnusedBefore(cutoff, TEMPLATE_SWEEP_BATCH)) {
        try {
          if (!(await this.templates.deleteIfUnusedBefore(row.name, cutoff))) continue;
        } catch {
          continue;
        }
        try {
          await this.api.deleteActorTemplate(row.atespace, row.name);
        } catch {
          await this.templates.restore(row).catch(() => undefined);
          this.templateEvent({ event: "substrate_template_remove_failed", name: row.name, role: row.role });
          continue;
        }
        this.templateEvent({
          event: "substrate_template_removed",
          name: row.name,
          role: row.role,
          ageSec: Math.round((now - row.lastUsedAt.getTime()) / 1000),
        });
      }
    } catch {
      // Tried again on the next sweep; a sweep never fails a launch.
    }
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
   * launch of the same run got its row first (no event: that launch reports). `launched`: the
   * adoption found a parked actor's template gone and this run was already launched cold
   * (resumeAdopted), so the caller launches nothing.
   */
  private async adoptParked(
    spec: JobSpec,
    templates: RunTemplates,
    specHash: string,
    deadlineAt: Date,
  ): Promise<(WarmOutcome & { launched?: true }) | undefined> {
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
    // A spec with services never adopts (the executor hashes them into the fingerprint; this is the backstop).
    if (parked.fingerprint !== warm.fingerprint || spec.services !== undefined) {
      return notAdopted("fingerprint_changed", parked);
    }
    const { atespace } = this.config;
    const [agent, tool] = await Promise.all([
      this.api.getActor(atespace, agentActorName(parked.token)),
      this.api.getActor(atespace, toolActorName(parked.token)),
    ]);
    if (!agent || !tool) return notAdopted("actor_missing", parked);
    if (agent.state !== "SUSPENDED" || tool.state !== "SUSPENDED") return notAdopted("actor_not_suspended", parked);
    // The fingerprint covers the images; the template name also covers the worker env and settings,
    // which may change across a restart. A parked tool actor on another template starts cold.
    if (templates.shape === "pair" && tool.templateName !== templates.tool.name) {
      return notAdopted("fingerprint_changed", parked);
    }
    const record = await this.runs.adopt(parked.runId, spec.runId, deadlineAt, {
      specHash,
      ...(spec.agentId !== undefined ? { agentId: spec.agentId } : {}),
    });
    if (record) {
      // The templates the parked actors run on (as Substrate reports them): best effort.
      await this.templates
        .touchNames([agent.templateName, tool.templateName], new Date(this.now()))
        .catch(() => undefined);
    } else {
      // Another launch of this same run got its row first: that launch decides, and reports.
      if (await this.runs.get(spec.runId)) return undefined;
      // Expired meanwhile (or being removed, which expires it first), else adopted or removed first.
      // Left for whoever removes it, or the sweep.
      const current = await this.runs.get(parked.runId);
      const expired = current?.phase === "parked" && current.deadlineAt.getTime() <= this.now();
      return expired ? notAdopted("expired", current, false) : notAdopted("not_parked");
    }
    if (!(await this.resumeAdopted(spec, record, roundOf(record), parked.runId, templates))) {
      return { adopted: false, reason: "actor_missing", launched: true };
    }
    return { adopted: true };
  }

  /**
   * Round `round` on adopted actors: stage its input and tool setup, record the round, hand the
   * per-run Secret the new run's capability, then resume the tool and the agent. Nothing is seeded:
   * the tool actor's /workspace is the previous round's, as collected. A failure cleans up every
   * round's resources (the warm state is gone) and is recorded as on a cold launch. True when
   * adopted. False when a parked actor's template is gone (Substrate answers its resume
   * FailedPrecondition: a template removed while the run was parked): the parked actors are removed
   * and the run starts fresh instead, cold at round 1 with cold reason actor_missing (relaunchCold).
   */
  private async resumeAdopted(
    spec: JobSpec,
    record: SubstrateRunRecord,
    round: number,
    adoptedRunId: string,
    templates: RunTemplates,
  ): Promise<boolean> {
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
    const call = namedCall(spec.runId, (failure) => this.reportCallFailure(failure));
    const clock = performance.now();
    try {
      const capability = await this.options.resolveCapability(spec.runId);
      if (!CAPABILITY.test(capability)) throw new Error("substrate_capability_invalid");
      const mcpToken = await this.mcpTokenFor(spec);
      await timed("stage", async () => {
        const input = await this.stageInput(spec.inputArtifact, token, round);
        const history = inputGitHistory(input);
        await this.stageSetup(spec, capability, token, history.requested, history.paths, true);
        await this.blobs.put(roundBlob(token), Buffer.from(JSON.stringify({ round })), {
          contentType: "application/json",
        });
      });
      // Fresh, with the new run's capability (and MCP token): the park deleted the last round's (any
      // left from before that rule is deleted first). The parked agent's egress policy is not re-put:
      // the warm fingerprint guarantees the parked round and the adopter agree on whether MCP tools
      // exist, and the park already deleted the Secret, so no live MCP token is at rest while parked.
      await timed("secret", async () => {
        await this.deleteSecret(token);
        await this.options.secrets.createSecret(
          this.config.credentialsNamespace,
          runSecret(token, capability, this.config, mcpToken),
        );
      });
      await timed("resumeTool", () => call("resumeActor", () => this.api.resumeActor(atespace, tool)));
      await timed("resumeAgent", () => call("resumeActor", () => this.api.resumeActor(atespace, agent)));
    } catch (error) {
      // Only paired runs are ever adopted; the row's extras (none: W1, a spec with any never adopts).
      await this.cleanup(token, round, "pair", this.repositoryNamesOf(record));
      if (error instanceof SubstrateExhaustedError) {
        await this.runs.setPhase(spec.runId, "requeued", ["provisioning"]).catch(() => undefined);
        throw new JobCapacityError("substrate_capacity: no worker has room", { cause: error });
      }
      if (error instanceof SubstrateTemplateMissingError) {
        this.warmEvent({
          event: "substrate_warm_not_adopted",
          runId: spec.runId,
          runToken: token,
          adoptedRunId,
          reason: "actor_missing",
        });
        await this.relaunchCold(spec, token, templates, "actor_missing");
        return false;
      }
      await this.runs.setPhase(spec.runId, "provisioning_failed", ["provisioning"]).catch(() => undefined);
      throw error;
    }
    try {
      await this.runs.setPhase(spec.runId, "running", ["provisioning"]);
    } catch (error) {
      if (!isPhaseConflict(error)) {
        await this.cleanup(token, round, "pair", this.repositoryNamesOf(record));
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
    return true;
  }

  /**
   * An adopter whose warm state is gone (its round's resources already cleaned up) starts fresh on
   * the token its row holds: the row goes back to provisioning at round 1 with `coldReason` and a
   * fresh deadline (through requeued, as a refused adopter's relaunch), then a cold provision. A row
   * that moved on meanwhile (stopped, or another launch reclaimed it) is left to whoever moved it.
   */
  private async relaunchCold(
    spec: JobSpec,
    token: string,
    templates: RunTemplates,
    coldReason: WarmColdReason,
  ): Promise<void> {
    try {
      await this.runs.setPhase(spec.runId, "requeued", ["provisioning"]);
    } catch (error) {
      if (isPhaseConflict(error)) return;
      throw error;
    }
    const deadlineAt = new Date(this.now() + spec.timeoutSec * 1000);
    if (!(await this.runs.reclaim(spec.runId, deadlineAt, { coldReason }))) return;
    await this.provision(spec, token, templates);
  }

  // -------------------------------------------------------------------------
  // Cleanup (each step: missing is success)

  /**
   * The names of the run's extra repositories, from its row (removal deletes each one's blobs). A
   * row whose stored value does not parse names none: that is logged as a fixed event (the run id
   * only, never the value), and everything else of the run is still removed.
   */
  private repositoryNamesOf(record: SubstrateRunRecord): string[] {
    if (record.repositoriesUnreadable) {
      try {
        substrateLog.warn({ runId: record.runId }, "substrate_run_repositories_unreadable");
      } catch {
        // Logging never changes the removal.
      }
    }
    return (record.repositories ?? []).map((r) => r.name);
  }

  /** Deletes the run's actors (both, or a single-shape run's one), each tried even if another fails. */
  private async deleteActors(token: string, shape: SubstrateActorShape): Promise<void> {
    const { atespace } = this.config;
    await settleAll(actorNamesFor(token, shape).map((name) => () => this.api.deleteActor(atespace, name)));
  }

  /**
   * Every resource of the run, one step per deletion, so none waits on (or is skipped by) another.
   * With `outcome: false`, not the blobs that carry the run's outcome (result, exit, done, the image
   * report) nor the round record. Every round's files (`rounds` from the run's row), whatever the warm-rounds
   * setting now: a run from when it was on is removed in full after it is turned off. `repositories`
   * (the run's extra repositories, by name): each one's seed and every round's workspace upload.
   */
  private deletions(
    token: string,
    rounds: number,
    {
      outcome = true,
      shape,
      repositories = [],
    }: { outcome?: boolean; shape: SubstrateActorShape; repositories?: readonly string[] },
  ): (() => Promise<void>)[] {
    const { atespace } = this.config;
    const actors = actorNamesFor(token, shape);
    const blobs = Object.values(BLOB).filter(
      (blob) => outcome || (blob !== BLOB.done && !OUTCOME_BLOBS.includes(blob) && !OUTCOME_RUN_BLOBS.includes(blob)),
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
    for (const name of repositories) {
      steps.push(() => this.deleteBlob(REPO_BLOB.seed(token, name)));
      for (let round = 1; round <= rounds; round += 1) {
        steps.push(() => this.deleteBlob(REPO_BLOB.workspace(token, name, round)));
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
  private async removeInFull(
    token: string,
    rounds: number,
    shape: SubstrateActorShape,
    repositories: readonly string[] = [],
  ): Promise<void> {
    await settleAll(this.deletions(token, rounds, { outcome: false, shape, repositories }));
    await this.options.relay.purgeRelay(token);
    const outcome: (() => Promise<void>)[] = OUTCOME_RUN_BLOBS.map((blob) => () => this.deleteBlob(blob(token)));
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
  private async cleanup(
    token: string,
    rounds: number,
    shape: SubstrateActorShape,
    repositories: readonly string[] = [],
  ): Promise<void> {
    await settleAll(this.deletions(token, rounds, { shape, repositories })).catch(() => undefined);
    await this.options.relay.purgeRelay(token).catch(() => undefined);
  }
}
