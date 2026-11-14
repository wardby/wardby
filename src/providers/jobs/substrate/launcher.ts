/**
 * SubstrateJobLauncher (JOB_LAUNCHER=substrate, experimental): runs one Claude Code coding job as
 * two Agent Substrate actors — the agent (the worker) and the tool (the credential-free tool
 * runner, which holds the workspace) — built from shared, secret-free templates.
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
 * - Warm rounds (SUBSTRATE_WARM_ROUNDS, experimental spike; off by default, and then nothing below
 *   applies): remove() of a succeeded run suspends its actors and parks it; a continuation of it
 *   adopts them (its row takes the parked token, per-round files `-<n>`, the Secret gets the new
 *   capability, both actors resume) and the bridges run the next round on the same workspace and
 *   the same Claude Code session. Handles are then `<atespace>/<token>/<runId>`.
 */
import { lstat, readFile, rm } from "node:fs/promises";
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
import { isRepositoryDigest } from "../docker-isolation.js";
import { KubernetesAlreadyExistsError, KubernetesNotFoundError, type KubernetesApi } from "../kubernetes-api.js";
import { RUN_ID } from "../kubernetes-isolation.js";
import { CAPABILITY, FINISHED_AT_SKEW_MS, hostTarArchive, stableSpecHash } from "../kubernetes.js";
import { safeExtract } from "../safe-extract.js";
import {
  JobCapacityError,
  type JobHandle,
  type JobResult,
  type JobSpec,
  type JobStatus,
  type MaterializedWorkspace,
  type MaterializeWorkspaceOptions,
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
  agentActorName,
  parseRound,
  retiredRunToken,
  roundBlob,
  runSecretName,
  substrateRunToken,
  toolActorName,
} from "./names.js";
import { canPlaceAll } from "./placement.js";
import type { SubstratePhase, SubstrateRunRecord, SubstrateRunStore } from "./run-store.js";
import {
  agentEgress,
  agentTemplate,
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
   * Warm rounds (SUBSTRATE_WARM_ROUNDS, experimental spike): a succeeded run's actors are suspended
   * and parked on remove() instead of deleted, and a continuation of that run adopts them (same
   * actors, same workspace, the same Claude Code session). Absent: every behaviour is unchanged.
   */
  warmRounds?: WarmRoundsOptions;
  /** Where warm-round steps are reported with their timings (default: the server log, at info). */
  onWarmEvent?: (event: WarmEvent) => void;
}

export interface WarmRoundsOptions {
  /** How long a parked run waits for a follow-up before a sweep removes it. */
  parkTtlMs: number;
  /**
   * How an adopted round gets the new run's capability: `same` replaces the per-run Secret under its
   * name (delete, then create); `fresh` creates a Secret under a new name per round and re-puts the
   * agent's egress policy to point at it (for a credential provider that caches by name).
   */
  secret: "same" | "fresh";
}

/**
 * A warm-round step, fixed fields only (never a capability, a request or a message). `ms` is the
 * step's duration; `reason` a fixed code for a refused adoption.
 */
export interface WarmEvent {
  event:
    | "substrate_warm_parked"
    | "substrate_warm_park_failed"
    | "substrate_warm_adopted"
    | "substrate_warm_not_adopted"
    | "substrate_warm_expired";
  runId: string;
  runToken: string;
  round?: number;
  adoptedRunId?: string;
  reason?: string;
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

/**
 * Phase A runs Claude Code only, without the features that need more than two actors or extra
 * secrets, and only on the configured bridge tool images (a custom tool image has no bridge).
 */
function validateSpec(spec: JobSpec, bridgeToolImages: readonly string[]): void {
  if (spec.kind !== "coding-agent" || !RUN_ID.test(spec.runId)) throw new Error("substrate_spec_invalid");
  if (spec.provider !== "claude-code") throw new Error("substrate_provider_unsupported");
  if (!isRepositoryDigest(spec.image) || spec.toolImage === undefined || !isRepositoryDigest(spec.toolImage)) {
    throw new Error("substrate_image_not_digest");
  }
  for (const feature of ["services", "mcpTools", "dependencyCache", "repositories"] as const) {
    if (spec[feature] !== undefined) throw new Error(`substrate_feature_unsupported:${feature}`);
  }
  if (!bridgeToolImages.includes(spec.toolImage)) throw new Error("substrate_feature_unsupported:workerImage");
}

/** What warm rounds read from a coding input: the run it continues (its root) and its model. */
function summarizeInput(body: Buffer): { root?: string; model?: string } {
  try {
    const value = JSON.parse(body.toString("utf8")) as {
      continuationOf?: { runId?: unknown } | null;
      model?: unknown;
    } | null;
    const root = value?.continuationOf?.runId;
    return {
      ...(typeof root === "string" ? { root } : {}),
      ...(typeof value?.model === "string" ? { model: value.model } : {}),
    };
  } catch {
    return {};
  }
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
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: SubstrateJobLauncherOptions) {
    this.api = options.api;
    this.runs = options.runs;
    this.blobs = options.blobs;
    this.warm = options.warmRounds;
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
    // Warm rounds: an adopting run's token is the parked run's, known only at launch.
    if (this.warm) return undefined;
    try {
      this.templatesFor(spec);
      return this.handleFor(substrateRunToken(spec.runId), spec.runId);
    } catch {
      // An invalid spec has no handle; launch() rejects with the real reason.
      return undefined;
    }
  }

  /**
   * Whether both actors can be placed now on the workers the configured selector matches, by free
   * CPU and memory (Substrate packs many actors per worker): the larger first on the worker with
   * the most free room, then the other, on the same worker or another. No workers: false. Any
   * error (an unbuildable spec, an unreachable API): true, so the launch itself decides (a refusal
   * there is a JobCapacityError).
   */
  async hasCapacityFor(spec: JobSpec): Promise<boolean> {
    if (this.warm) await this.sweepParkedSometimes();
    try {
      const { agent, tool } = this.templatesFor(spec);
      const selector = Object.entries(this.config.workerSelector ?? {});
      const free = (await this.api.listWorkers())
        .filter((worker) => selector.every(([key, value]) => worker.labels?.[key] === value))
        .map((worker) => ({ cpuMillicores: worker.freeCpuMillicores, memoryBytes: worker.freeMemoryBytes }));
      const size = (t: ActorTemplateSpec) => ({ cpuMillicores: t.cpuMillicores, memoryBytes: t.memoryBytes });
      return canPlaceAll(free, [size(agent), size(tool)]);
    } catch {
      return true;
    }
  }

  async launch(spec: JobSpec): Promise<JobHandle> {
    const templates = this.templatesFor(spec);
    const token = substrateRunToken(spec.runId);
    const specHash = stableSpecHash(spec);
    const deadline = () => new Date(this.now() + spec.timeoutSec * 1000);
    if (this.warm) {
      await this.sweepParkedSometimes();
      const adopted = await this.adoptParked(spec, templates, specHash, deadline());
      if (adopted) return this.handleFor(adopted, spec.runId);
    }
    const claimed = await this.runs.claim({
      runId: spec.runId,
      token,
      specHash,
      phase: "provisioning",
      deadlineAt: deadline(),
    });
    // An adopting run's row carries the parked run's token (warm rounds); every other row, its own.
    const handle = this.handleFor(claimed.record.token, spec.runId);
    if (!claimed.created) {
      if (claimed.record.specHash !== specHash) throw new Error("job_spec_conflict");
      // Any phase but requeued: another launch owns (or owned) this run; never relaunch it. A
      // still-provisioning row whose launch crashed is left to its deadline, as on Kubernetes.
      if (claimed.record.phase !== "requeued") return handle;
      // Refused for capacity before: provision afresh, unless another replica just did.
      if (!(await this.runs.reclaim(spec.runId, deadline()))) return handle;
    }
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
    const key = BLOB.workspace(record.token, await this.roundOf(record.token));
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
    const key = BLOB.transcript(record.token, await this.roundOf(record.token));
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
    await this.deleteActors(record.token);
  }

  async remove(handle: JobHandle): Promise<void> {
    const record = await this.recordFor(handle);
    if (!record || record.phase === "removed") return;
    // Its actors and files belong to the run that adopted them.
    if (record.phase === "adopted") {
      await this.runs.setPhase(record.runId, "removed", ["adopted"]);
      return;
    }
    const observed = await this.observe(record);
    if (!observed.result) throw new Error("job_not_terminal");
    // Warm rounds: a succeeded run waits, suspended, for a follow-up (a parked run is removed in full).
    if (this.warm && record.phase === "running" && observed.status.state === "succeeded") {
      if (await this.park(record)) return;
    }
    // Every deletion is tried even when one fails; the first failure is reported and the run is
    // not marked removed, so a later remove() tries again.
    await this.removeInFull(record.token);
    // The row stays as the tombstone, so the run is never relaunched.
    await this.runs.setPhase(record.runId, "removed");
  }

  // -------------------------------------------------------------------------
  // Launch

  private templatesFor(spec: JobSpec): { agent: ActorTemplateSpec; tool: ActorTemplateSpec } {
    validateSpec(spec, this.options.bridgeToolImages);
    return { agent: agentTemplate(spec, this.config), tool: toolTemplate(spec, this.config) };
  }

  /**
   * `<atespace>/<token>`; with warm rounds `<atespace>/<token>/<runId>`, because an adopted run's token
   * is not derived from its own run id and moves on to the next adopter.
   */
  private handleFor(token: string, runId: string): JobHandle {
    return {
      backend: BACKEND,
      id: this.warm ? `${this.config.atespace}/${token}/${runId}` : `${this.config.atespace}/${token}`,
    };
  }

  private async provision(
    spec: JobSpec,
    token: string,
    templates: { agent: ActorTemplateSpec; tool: ActorTemplateSpec },
  ): Promise<void> {
    const { atespace } = this.config;
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
      await this.ensureTemplate(templates.agent, call);
      await this.ensureTemplate(templates.tool, call);
      await this.stageInput(spec.inputArtifact, token);
      await this.stageToolSetup(spec, capability, token);
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
      for (const [name, template] of [
        [agent, templates.agent.name],
        [tool, templates.tool.name],
      ] as const) {
        await call("createActor", async () => {
          try {
            await this.api.createActor(atespace, name, template);
          } catch (error) {
            if (!(error instanceof SubstrateAlreadyExistsError)) throw error;
          }
        });
      }
      // After the actors: an egress policy belongs to its actor (a foreign key in Substrate). Both
      // policies are in place before either actor resumes, so neither ever runs without one.
      await call("putEgressPolicy", () => this.api.putEgressPolicy(atespace, agent, agentEgress(token, this.config)));
      await call("putEgressPolicy", () => this.api.putEgressPolicy(atespace, tool, toolEgress(this.config)));
      // The tool first: the agent's first tool call needs it.
      await call("resumeActor", () => this.api.resumeActor(atespace, tool));
      await call("resumeActor", () => this.api.resumeActor(atespace, agent));
    } catch (error) {
      // Clean up before recording requeued, so a relaunch never races this cleanup.
      await this.cleanup(token);
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
        await this.cleanup(token);
        await this.runs.setPhase(spec.runId, "provisioning_failed", ["provisioning"]).catch(() => undefined);
        throw error;
      }
      // Stopped or timed out while provisioning: whoever moved it may have deleted the actors
      // before they existed, so delete them again.
      await this.deleteActors(token);
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

  /** The tool setup blob: the run's registry-only token lives here (and in the tool runner) only. */
  private async stageToolSetup(spec: JobSpec, capability: string, token: string): Promise<void> {
    const setup = {
      toolSetup: claudeToolSetup(spec, capability, {
        proxyBaseUrl: `http://${this.config.proxyHost}:${this.config.proxyPort}`,
      }),
      // The Kubernetes launcher's default for a spec without exclusions: the built-in names.
      collectExclude: spec.collectExclude ?? collectExclusions([]),
    };
    await this.blobs.put(BLOB.toolSetup(token), Buffer.from(JSON.stringify(setup)), {
      contentType: "application/json",
    });
  }

  private reportCallFailure(failure: SubstrateCallFailure): void {
    try {
      if (this.options.onSubstrateCallFailed) this.options.onSubstrateCallFailed(failure);
      else substrateLog.warn({ ...failure }, "substrate_call_failed");
    } catch {
      // Reporting never changes the launch's outcome.
    }
  }

  private async stageInput(inputArtifact: string, token: string, round = 1): Promise<void> {
    let body: Buffer;
    try {
      const source = await lstat(inputArtifact);
      if (!source.isFile() || source.size > MAX_CODING_INPUT_BYTES) throw new Error("substrate_input_artifact_invalid");
      body = await readFile(inputArtifact);
    } catch (error) {
      if (error instanceof Error && error.message === "substrate_input_artifact_invalid") throw error;
      throw new Error("substrate_input_artifact_invalid", { cause: error });
    }
    // Re-check what was read: the file could have changed after lstat.
    if (body.length > MAX_CODING_INPUT_BYTES) throw new Error("substrate_input_artifact_invalid");
    await this.blobs.put(BLOB.input(token, round), body, { contentType: "application/json" });
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

  private async recordFor(handle: JobHandle): Promise<SubstrateRunRecord | undefined> {
    if (handle.backend !== BACKEND || typeof handle.id !== "string") return undefined;
    const [atespace, token, runId, ...rest] = handle.id.split("/");
    if (rest.length > 0 || atespace !== this.config.atespace || !token || !TOKEN.test(token)) return undefined;
    if (runId !== undefined) {
      // `<atespace>/<token>/<runId>` (warm rounds): the run's own row, while it still holds the token
      // (a run whose parked actors were adopted no longer does: its handle names nothing).
      if (!RUN_ID.test(runId)) return undefined;
      const record = await this.runs.get(runId);
      return record?.token === token ? record : undefined;
    }
    const record = await this.runs.getByToken(token);
    // A row holding another run's token is an adopter (warm rounds), never this handle's run.
    return record && record.token === substrateRunToken(record.runId) ? record : undefined;
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
    const round = await this.roundOf(record.token);
    if (record.phase === "parked") {
      // Succeeded and suspended for a follow-up: still the succeeded run it was.
      const artifact = await this.resultArtifact(record, round);
      return {
        status: { state: "succeeded" },
        result: { exitCode: 0, reason: "completed", ...(artifact !== undefined ? { resultArtifact: artifact } : {}) },
      };
    }
    // An adopting run while it provisions: the token's files are still the previous round's.
    if (record.phase === "provisioning" && record.token !== substrateRunToken(record.runId)) {
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
    const [agent, tool] = await Promise.all([
      this.api.getActor(atespace, agentActorName(record.token)),
      this.api.getActor(atespace, toolActorName(record.token)),
    ]);
    if (!agent || !tool) return this.settle(record, "lost");
    if (agent.state === "CRASHED") return this.settle(record, "crashed");
    if (tool.state === "CRASHED") return this.settle(record, "tool_failed");
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
    if (STOP_ACTORS_ON.includes(phase)) await this.deleteActors(record.token).catch(() => undefined);
    return this.observe(stored);
  }

  /** The outcome the actors reported through the proxy, once the proxy has written `done`. */
  private async reported(record: SubstrateRunRecord, round?: number): Promise<Observation | undefined> {
    round ??= await this.roundOf(record.token);
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
  // Warm rounds (SUBSTRATE_WARM_ROUNDS, experimental spike)

  /** The round the token's actors are on: 1 without warm rounds or a round record. */
  private async roundOf(token: string): Promise<number> {
    if (!this.warm) return 1;
    const body = await this.readBlob(roundBlob(token), MAX_MARKER_BYTES);
    return (body && parseRound(body.toString("utf8"))) || 1;
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
   * Suspends both actors (the snapshot durable before this returns) and records the run as parked
   * until now + parkTtlMs. Keeps the Secret, the egress policies, the actors' state and the small
   * files the run's outcome is read from; drops the seed and the workspace tar. False, with nothing
   * recorded, when a suspend fails: the caller then removes the run as usual.
   */
  private async park(record: SubstrateRunRecord): Promise<boolean> {
    const { atespace } = this.config;
    const startedAt = this.now();
    const clock = performance.now();
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
      this.warmEvent({ event: "substrate_warm_park_failed", runId: record.runId, runToken: record.token });
      return false;
    }
    const ms = Math.round(performance.now() - clock);
    await this.runs.setPhase(record.runId, "parked", ["running"], new Date(startedAt + this.warm!.parkTtlMs));
    const round = await this.roundOf(record.token);
    await settleAll([
      () => this.deleteBlob(BLOB.seed(record.token)),
      () => this.deleteBlob(BLOB.workspace(record.token, round)),
      () => this.deleteBlob(BLOB.toolSetup(record.token)),
    ]).catch(() => undefined);
    this.warmEvent({ event: "substrate_warm_parked", runId: record.runId, runToken: record.token, round, ms });
    return true;
  }

  /** Removes a parked run in full (an expired park, or one a continuation could not adopt). */
  private async removeParked(record: SubstrateRunRecord): Promise<void> {
    await this.removeInFull(record.token);
    await this.runs.setPhase(record.runId, "removed", ["parked"]);
  }

  private async sweepParkedSometimes(): Promise<void> {
    if (this.now() - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = this.now();
    await this.sweepParked().catch(() => undefined);
  }

  /** Removes every parked run past its expiry (deadlineAt). */
  async sweepParked(): Promise<void> {
    if (!this.warm) return;
    for (const record of await this.runs.listByPhase("parked")) {
      if (record.deadlineAt.getTime() > this.now()) continue;
      try {
        await this.removeParked(record);
        this.warmEvent({ event: "substrate_warm_expired", runId: record.runId, runToken: record.token });
      } catch {
        // Tried again on the next sweep.
      }
    }
  }

  /** The run id the input continues (the thread's root run) and its model; undefined fields when absent. */
  private async inputSummary(inputArtifact: string): Promise<{ root?: string; model?: string }> {
    try {
      const source = await lstat(inputArtifact);
      if (!source.isFile() || source.size > MAX_CODING_INPUT_BYTES) return {};
      return summarizeInput(await readFile(inputArtifact));
    } catch {
      return {};
    }
  }

  /**
   * Adopts the parked run this continuation continues, when there is one and it fits: the parked
   * row moves to `adopted` and this run's row takes its token, then the next round's files and the
   * new capability are staged and both actors resume. Undefined when there is nothing to adopt (the
   * caller launches cold). A parked run that does not fit is removed, so no later round adopts state
   * older than the branch.
   */
  private async adoptParked(
    spec: JobSpec,
    templates: { agent: ActorTemplateSpec; tool: ActorTemplateSpec },
    specHash: string,
    deadlineAt: Date,
  ): Promise<string | undefined> {
    if (await this.runs.get(spec.runId)) return undefined;
    const input = await this.inputSummary(spec.inputArtifact);
    if (!input.root || !RUN_ID.test(input.root)) return undefined;
    const parked = await this.runs.getByToken(substrateRunToken(input.root));
    if (!parked || parked.phase !== "parked" || parked.runId === spec.runId) return undefined;
    const notAdopted = async (reason: string): Promise<undefined> => {
      this.warmEvent({
        event: "substrate_warm_not_adopted",
        runId: spec.runId,
        runToken: parked.token,
        adoptedRunId: parked.runId,
        reason,
      });
      await this.removeParked(parked).catch(() => undefined);
      return undefined;
    };
    if (parked.deadlineAt.getTime() <= this.now()) return notAdopted("expired");
    const { atespace } = this.config;
    const [agent, tool] = await Promise.all([
      this.api.getActor(atespace, agentActorName(parked.token)),
      this.api.getActor(atespace, toolActorName(parked.token)),
    ]);
    if (!agent || !tool) return notAdopted("actor_missing");
    if (agent.state !== "SUSPENDED" || tool.state !== "SUSPENDED") return notAdopted("actor_not_suspended");
    if (agent.templateName !== templates.agent.name || tool.templateName !== templates.tool.name) {
      return notAdopted("template_changed");
    }
    const previous = await this.roundOf(parked.token);
    const before = await this.readBlob(BLOB.input(parked.token, previous), MAX_CODING_INPUT_BYTES);
    if (!before || summarizeInput(before).model !== input.model) return notAdopted("model_changed");
    const record = await this.runs.adopt(parked.runId, retiredRunToken(parked.runId), {
      runId: spec.runId,
      token: parked.token,
      specHash,
      phase: "provisioning",
      deadlineAt,
    });
    // Another launch adopted it first, or this run got a row meanwhile: launch as usual.
    if (!record) return undefined;
    await this.resumeAdopted(spec, record, previous + 1, parked.runId);
    return record.token;
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
        await this.stageInput(spec.inputArtifact, token, round);
        await this.stageToolSetup(spec, capability, token);
        await this.blobs.put(roundBlob(token), Buffer.from(JSON.stringify({ round })), {
          contentType: "application/json",
        });
      });
      await timed("secret", async () => {
        const namespace = this.config.credentialsNamespace;
        if (this.warm!.secret === "fresh") {
          // A new name per round, and the agent's policy pointed at it.
          const name = runSecretName(token, round);
          await this.createSecret(runSecret(token, capability, this.config, name));
          await call("deleteEgressPolicy", () => this.api.deleteEgressPolicy(atespace, agent));
          await call("putEgressPolicy", () =>
            this.api.putEgressPolicy(atespace, agent, agentEgress(token, this.config, name)),
          );
          await this.deleteSecret(runSecretName(token, round - 1));
        } else {
          await this.deleteSecret(token);
          await this.options.secrets.createSecret(namespace, runSecret(token, capability, this.config));
        }
      });
      await timed("resumeTool", () => call("resumeActor", () => this.api.resumeActor(atespace, tool)));
      await timed("resumeAgent", () => call("resumeActor", () => this.api.resumeActor(atespace, agent)));
    } catch (error) {
      await this.cleanup(token);
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
        await this.cleanup(token);
        await this.runs.setPhase(spec.runId, "provisioning_failed", ["provisioning"]).catch(() => undefined);
        throw error;
      }
      await this.deleteActors(token);
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

  private async createSecret(body: ReturnType<typeof runSecret>): Promise<void> {
    try {
      await this.options.secrets.createSecret(this.config.credentialsNamespace, body);
    } catch (error) {
      if (!(error instanceof KubernetesAlreadyExistsError)) throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup (each step: missing is success)

  /** Deletes both actors, each tried even if the other fails. */
  private async deleteActors(token: string): Promise<void> {
    const { atespace } = this.config;
    await settleAll(
      [agentActorName(token), toolActorName(token)].map((name) => () => this.api.deleteActor(atespace, name)),
    );
  }

  /**
   * Every resource of the run, one step per deletion, so none waits on (or is skipped by) another.
   * With `outcome: false`, not the blobs that carry the run's outcome (result, exit, done) nor the
   * round record. With warm rounds: every round's files and Secrets (`rounds` from the round record).
   */
  private deletions(
    token: string,
    rounds: number,
    { outcome = true }: { outcome?: boolean } = {},
  ): (() => Promise<void>)[] {
    const { atespace } = this.config;
    const actors = [agentActorName(token), toolActorName(token)];
    const blobs = Object.values(BLOB).filter(
      (blob) => outcome || (blob !== BLOB.done && !OUTCOME_BLOBS.includes(blob)),
    );
    const steps = [
      ...actors.map((name) => () => this.api.deleteActor(atespace, name)),
      ...actors.map((name) => () => this.api.deleteEgressPolicy(atespace, name)),
      () => this.deleteSecret(token),
      ...blobs.map((blob) => () => this.deleteBlob(blob(token))),
    ];
    if (!this.warm) return steps;
    for (let round = 2; round <= rounds; round += 1) {
      steps.push(() => this.deleteSecret(runSecretName(token, round)));
      for (const name of ROUND_BLOBS) {
        if (outcome || !OUTCOME_ROUND_BLOBS.includes(name)) steps.push(() => this.deleteBlob(BLOB[name](token, round)));
      }
    }
    if (outcome) steps.push(() => this.deleteBlob(roundBlob(token)));
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
  private async removeInFull(token: string): Promise<void> {
    const rounds = await this.roundOf(token);
    await settleAll(this.deletions(token, rounds, { outcome: false }));
    await this.options.relay.purgeRelay(token);
    const outcome: (() => Promise<void>)[] = [];
    for (let round = 1; round <= rounds; round += 1) {
      outcome.push(...OUTCOME_BLOBS.map((blob) => () => this.deleteBlob(blob(token, round))));
      if (round < rounds) outcome.push(() => this.deleteBlob(BLOB.done(token, round)));
    }
    await settleAll(outcome);
    await this.deleteBlob(BLOB.done(token, rounds));
    if (this.warm) await this.deleteBlob(roundBlob(token));
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

  /** Best effort after a failed launch: nothing of the attempt is left behind. */
  private async cleanup(token: string): Promise<void> {
    const rounds = await this.roundOf(token).catch(() => 1);
    await settleAll(this.deletions(token, rounds)).catch(() => undefined);
    await this.options.relay.purgeRelay(token).catch(() => undefined);
  }
}
