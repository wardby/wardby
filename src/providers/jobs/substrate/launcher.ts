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
 *   `exit` and `done`.
 * - The `SubstrateRun` row is the launch fence (a second launch of the same run finds it) and the
 *   phase record. Completion is reported, not observed: `done` with a parseable `result` is success.
 *   Outcomes the launcher observes itself (timeout, a lost or crashed actor, a failed provisioning)
 *   are written to the row's phase, so a terminal state never changes afterwards.
 */
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { collectExclusions } from "../../../coding/collect-exclude.js";
import {
  MAX_CODING_ARTIFACT_BYTES,
  MAX_CODING_INPUT_BYTES,
  parseCodingWorkerOutputJson,
} from "../../../coding/protocol.js";
import type { CodingProvider } from "../../../coding/provider.js";
import { BlobStoreError, type BlobStore } from "../../storage/types.js";
import { claudeToolSetup } from "../claude-tool-setup.js";
import { isRepositoryDigest } from "../docker-isolation.js";
import { KubernetesAlreadyExistsError, KubernetesNotFoundError, type KubernetesApi } from "../kubernetes-api.js";
import { RUN_ID } from "../kubernetes-isolation.js";
import { CAPABILITY, hostTarArchive, stableSpecHash } from "../kubernetes.js";
import { safeExtract } from "../safe-extract.js";
import {
  JobCapacityError,
  type JobHandle,
  type JobResult,
  type JobSpec,
  type JobStatus,
  type WorkspaceJobLauncher,
} from "../types.js";
import { replaceDirectoryFromStaging } from "../workspace-swap.js";
import {
  SubstrateAlreadyExistsError,
  SubstrateExhaustedError,
  type ActorTemplateSpec,
  type SubstrateApi,
} from "./api.js";
import { BLOB, agentActorName, substrateRunToken, toolActorName } from "./names.js";
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
  config: SubstrateLaunchConfig;
  /** Same root the VCS provider prepares workspaces under (as the Kubernetes launcher's). */
  workspaceRoot: string;
  resolveCapability: (runId: string) => Promise<string>;
  now?: () => number;
}

const BACKEND = "substrate";
const TOKEN = /^wr-[0-9a-f]{20}$/;
const MIB = 1024 * 1024;
const MAX_WORKSPACE_ENTRIES = 100_000;
/** done.json and exit.json are a few bytes; anything bigger is not ours. */
const MAX_MARKER_BYTES = 4096;
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
};

function isPhaseConflict(error: unknown): boolean {
  return error instanceof Error && error.message === "substrate_phase_conflict";
}

function isBlobNotFound(error: unknown): boolean {
  return error instanceof BlobStoreError && error.code === "not_found";
}

/** Phase A runs Claude Code only, without the features that need more than two actors or extra secrets. */
function validateSpec(spec: JobSpec): void {
  if (spec.kind !== "coding-agent" || !RUN_ID.test(spec.runId)) throw new Error("substrate_spec_invalid");
  if (spec.provider !== "claude-code") throw new Error("substrate_provider_unsupported");
  if (!isRepositoryDigest(spec.image) || spec.toolImage === undefined || !isRepositoryDigest(spec.toolImage)) {
    throw new Error("substrate_image_not_digest");
  }
  for (const feature of ["services", "mcpTools", "dependencyCache", "repositories"] as const) {
    if (spec[feature] !== undefined) throw new Error(`substrate_feature_unsupported:${feature}`);
  }
}

export class SubstrateJobLauncher implements WorkspaceJobLauncher {
  private readonly api: SubstrateApi;
  private readonly runs: SubstrateRunStore;
  private readonly blobs: BlobStore;
  private readonly config: SubstrateLaunchConfig;
  private readonly workspaceRoot: string;
  private readonly now: () => number;

  constructor(private readonly options: SubstrateJobLauncherOptions) {
    this.api = options.api;
    this.runs = options.runs;
    this.blobs = options.blobs;
    this.config = options.config;
    this.workspaceRoot = resolve(options.workspaceRoot);
    if (this.workspaceRoot === resolve("/")) throw new Error("substrate_launcher_path_invalid");
    this.now = options.now ?? Date.now;
  }

  /** Phase A: no coding-run services on Substrate. */
  supportsServicesFor(_provider: CodingProvider): boolean {
    return false;
  }

  plannedHandle(spec: JobSpec): JobHandle | undefined {
    try {
      this.templatesFor(spec);
      return this.handleFor(substrateRunToken(spec.runId));
    } catch {
      // An invalid spec has no handle; launch() rejects with the real reason.
      return undefined;
    }
  }

  /**
   * Whether the workers have room for both actors right now: one worker for both, or two workers
   * for one each. Any doubt (an unbuildable spec, an unreachable API) answers yes; launch decides.
   */
  async hasCapacityFor(spec: JobSpec): Promise<boolean> {
    try {
      const { agent, tool } = this.templatesFor(spec);
      const workers = await this.api.listWorkers();
      const fits = (worker: (typeof workers)[number], cpu: number, memory: number) =>
        worker.freeCpuMillicores >= cpu && worker.freeMemoryBytes >= memory;
      if (
        workers.some((w) => fits(w, agent.cpuMillicores + tool.cpuMillicores, agent.memoryBytes + tool.memoryBytes))
      ) {
        return true;
      }
      return workers.some(
        (w, i) =>
          fits(w, agent.cpuMillicores, agent.memoryBytes) &&
          workers.some((v, j) => j !== i && fits(v, tool.cpuMillicores, tool.memoryBytes)),
      );
    } catch {
      return true;
    }
  }

  async launch(spec: JobSpec): Promise<JobHandle> {
    const templates = this.templatesFor(spec);
    const token = substrateRunToken(spec.runId);
    const handle = this.handleFor(token);
    const specHash = stableSpecHash(spec);
    const deadline = () => new Date(this.now() + spec.timeoutSec * 1000);
    const claimed = await this.runs.claim({
      runId: spec.runId,
      token,
      specHash,
      phase: "provisioning",
      deadlineAt: deadline(),
    });
    if (!claimed.created) {
      if (claimed.record.specHash !== specHash) throw new Error("job_spec_conflict");
      // Any phase but requeued: another launch owns (or owned) this run; never relaunch it. A
      // still-provisioning row whose launch crashed is left to its deadline, as on Kubernetes.
      if (claimed.record.phase !== "requeued") return handle;
      // Refused for capacity before: provision afresh, unless another replica just did.
      if (!(await this.runs.reclaim(spec.runId, deadline()))) return handle;
    }
    await this.provision(spec, token, templates);
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

  async materializeWorkspace(handle: JobHandle, destination: string, name?: string): Promise<void> {
    // Phase A has no extra repositories, so there is never a named one to collect.
    if (name !== undefined) throw new Error("substrate_workspace_destination_invalid");
    const record = await this.requireRecord(handle);
    if ((await this.observe(record)).status.state !== "succeeded") throw new Error("job_not_succeeded");
    const expected = resolve(this.workspaceRoot, record.runId, "workspace");
    if (resolve(destination) !== expected || !expected.startsWith(`${this.workspaceRoot}${sep}`)) {
      throw new Error("substrate_workspace_destination_invalid");
    }
    const key = BLOB.workspace(record.token);
    const info = await this.blobs.head(key);
    if (!info) throw new Error("substrate_workspace_missing");
    // The archive holds every extracted byte plus headers, so its size bounds the tree.
    const maxBytes = info.sizeBytes;
    await replaceDirectoryFromStaging(
      expected,
      maxBytes,
      "substrate_workspace_destination_invalid",
      async (staging) => {
        const body = await this.blobs.getStream(key);
        const source = body instanceof Readable ? body : Readable.from(body as AsyncIterable<Buffer>);
        await safeExtract(source, staging, { maxBytes, maxEntries: MAX_WORKSPACE_ENTRIES });
      },
    );
  }

  async readTranscript(handle: JobHandle, maxBytes: number): Promise<string | undefined> {
    const record = await this.recordFor(handle);
    if (!record || record.phase === "removed") return undefined;
    const key = BLOB.transcript(record.token);
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
    if (!(await this.observe(record)).result) throw new Error("job_not_terminal");
    await this.deleteActors(record.token);
    await this.deletePolicies(record.token);
    await this.deleteSecret(record.token);
    await this.deleteBlobs(record.token);
    // The row stays as the tombstone, so the run is never relaunched.
    await this.runs.setPhase(record.runId, "removed");
  }

  // -------------------------------------------------------------------------
  // Launch

  private templatesFor(spec: JobSpec): { agent: ActorTemplateSpec; tool: ActorTemplateSpec } {
    validateSpec(spec);
    return { agent: agentTemplate(spec, this.config), tool: toolTemplate(spec, this.config) };
  }

  private handleFor(token: string): JobHandle {
    return { backend: BACKEND, id: `${this.config.atespace}/${token}` };
  }

  private async provision(
    spec: JobSpec,
    token: string,
    templates: { agent: ActorTemplateSpec; tool: ActorTemplateSpec },
  ): Promise<void> {
    const { atespace } = this.config;
    const agent = agentActorName(token);
    const tool = toolActorName(token);
    try {
      const capability = await this.options.resolveCapability(spec.runId);
      if (!CAPABILITY.test(capability)) throw new Error("substrate_capability_invalid");
      await this.api.ensureActorTemplate(templates.agent);
      await this.api.ensureActorTemplate(templates.tool);
      await this.stageInput(spec.inputArtifact, token);
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
      await this.stageSeed(spec, token);
      try {
        await this.options.secrets.createSecret(
          this.config.credentialsNamespace,
          runSecret(token, capability, this.config),
        );
      } catch (error) {
        if (!(error instanceof KubernetesAlreadyExistsError)) throw error;
      }
      await this.api.putEgressPolicy(atespace, agent, agentEgress(token, this.config));
      await this.api.putEgressPolicy(atespace, tool, toolEgress(this.config));
      // The fence already serialized launches of this run, so an existing actor is our own.
      for (const [name, template] of [
        [agent, templates.agent.name],
        [tool, templates.tool.name],
      ] as const) {
        try {
          await this.api.createActor(atespace, name, template);
        } catch (error) {
          if (!(error instanceof SubstrateAlreadyExistsError)) throw error;
        }
      }
      // The tool first: the agent's first tool call needs it.
      await this.api.resumeActor(atespace, tool);
      await this.api.resumeActor(atespace, agent);
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
      if (!isPhaseConflict(error)) throw error;
      // Stopped or timed out while provisioning: whoever moved it may have deleted the actors
      // before they existed, so delete them again.
      await this.deleteActors(token);
    }
  }

  private async stageInput(inputArtifact: string, token: string): Promise<void> {
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
    await this.blobs.put(BLOB.input(token), body, { contentType: "application/json" });
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
    const [atespace, token, ...rest] = handle.id.split("/");
    if (rest.length > 0 || atespace !== this.config.atespace || !token || !TOKEN.test(token)) return undefined;
    return this.runs.getByToken(token);
  }

  private async requireRecord(handle: JobHandle): Promise<SubstrateRunRecord> {
    const record = await this.recordFor(handle);
    if (!record) throw new Error("job_not_found");
    return record;
  }

  /**
   * The job's state, and its result when terminal. Order: a recorded outcome; a reported one (the
   * proxy's `done` blob); the deadline; then the actors. An `exit` without `done` is a collect still
   * in flight, so the run stays running until `done` or the deadline.
   */
  private async observe(record: SubstrateRunRecord): Promise<Observation> {
    if (record.phase === "removed") throw new Error("job_removed");
    const recorded = RECORDED[record.phase];
    if (recorded) return structuredClone(recorded);
    if (record.phase === "requeued") return { status: { state: "pending", capacityRefused: true } };
    const reported = await this.reported(record);
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
    return { status: { state: "running" } };
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
    if (phase === "timed_out") await this.deleteActors(record.token).catch(() => undefined);
    return this.observe(stored);
  }

  /** The outcome the actors reported through the proxy, once the proxy has written `done`. */
  private async reported(record: SubstrateRunRecord): Promise<Observation | undefined> {
    const done = await this.readJson(BLOB.done(record.token), MAX_MARKER_BYTES);
    if (done === undefined) return undefined;
    const workspace = typeof done === "object" && done !== null ? (done as { workspace?: unknown }).workspace : null;
    if (workspace !== "ok") {
      return {
        status: { state: "failed", reason: "substrate_collect_failed" },
        result: {
          exitCode: await this.exitCode(record.token),
          reason: "failed",
          diagnostic: "substrate_collect_failed",
        },
      };
    }
    const artifact = await this.resultArtifact(record);
    if (artifact !== undefined) {
      return { status: { state: "succeeded" }, result: { exitCode: 0, reason: "completed", resultArtifact: artifact } };
    }
    return {
      status: { state: "failed", reason: "worker_exited" },
      result: { exitCode: await this.exitCode(record.token), reason: "failed", diagnostic: "substrate_result_missing" },
    };
  }

  /** The posted result, validated and for this run; undefined when missing or not a valid output. */
  private async resultArtifact(record: SubstrateRunRecord): Promise<string | undefined> {
    const raw = await this.readBlob(BLOB.result(record.token), MAX_CODING_ARTIFACT_BYTES);
    if (raw === undefined) return undefined;
    try {
      const output = parseCodingWorkerOutputJson(raw.toString("utf8"));
      return output.runId === record.runId ? JSON.stringify(output) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The worker's exit code from the proxy's `exit` blob; 1 when absent or not a failure code. */
  private async exitCode(token: string): Promise<number> {
    const exit = (await this.readJson(BLOB.exit(token), MAX_MARKER_BYTES)) as { code?: unknown } | null | undefined;
    const code = exit?.code;
    return typeof code === "number" && Number.isInteger(code) && code > 0 && code <= 255 ? code : 1;
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
  // Cleanup (each step: missing is success)

  private async deleteActors(token: string): Promise<void> {
    await this.api.deleteActor(this.config.atespace, agentActorName(token));
    await this.api.deleteActor(this.config.atespace, toolActorName(token));
  }

  private async deletePolicies(token: string): Promise<void> {
    await this.api.deleteEgressPolicy(this.config.atespace, agentActorName(token));
    await this.api.deleteEgressPolicy(this.config.atespace, toolActorName(token));
  }

  private async deleteSecret(token: string): Promise<void> {
    try {
      await this.options.secrets.deleteSecret(this.config.credentialsNamespace, token);
    } catch (error) {
      if (!(error instanceof KubernetesNotFoundError)) throw error;
    }
  }

  private async deleteBlobs(token: string): Promise<void> {
    for (const key of Object.values(BLOB).map((blob) => blob(token))) {
      try {
        await this.blobs.delete(key);
      } catch (error) {
        if (!isBlobNotFound(error)) throw error;
      }
    }
  }

  /** Best effort after a failed launch: nothing of the attempt is left behind. */
  private async cleanup(token: string): Promise<void> {
    await this.deleteActors(token).catch(() => undefined);
    await this.deletePolicies(token).catch(() => undefined);
    await this.deleteSecret(token).catch(() => undefined);
    await this.deleteBlobs(token).catch(() => undefined);
  }
}
