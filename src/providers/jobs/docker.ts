import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseCodingAgentOutputJson, MAX_CODING_ARTIFACT_BYTES } from "../../coding/protocol.js";
import {
  assertDockerHostSupportsIsolation,
  assertIsolationNetworkInspection,
  assertKeeperContainerInspection,
  assertProxyContainerInspection,
  assertStorageVolumeInspection,
  assertWorkerContainerInspection,
  buildDockerIsolationPlan,
  type DockerContainerInspection,
  type DockerHostInfo,
} from "./docker-isolation.js";
import type { JobHandle, JobResult, JobSpec, JobStatus, WorkspaceJobLauncher } from "./types.js";

const BACKEND = "docker";
const STATE_SCHEMA_VERSION = 1;
const MAX_DOCKER_OUTPUT_BYTES = 1024 * 1024;
const MAX_WORKSPACE_ENTRIES = 100_000;
const TERMINAL_PHASES = new Set<DockerJobRecord["phase"]>(["succeeded", "failed", "stopped", "lost", "removed"]);
const SAFE_WORKER_DIAGNOSTIC = /^(?:worker_[a-z_]+|coding_[a-z_]+|reevo_[a-z_]+)$/;
export interface DockerCommandOptions {
  env?: Record<string, string>;
  maxOutputBytes?: number;
}

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
}

export interface DockerCommandRunner {
  run(args: readonly string[], options?: DockerCommandOptions): Promise<DockerCommandResult>;
}

/** Docker failures never include daemon output in their public message. */
export class DockerCommandError extends Error {
  constructor(
    public readonly exitCode: number | null,
    public readonly notFound = false,
    public readonly outputExceeded = false,
  ) {
    super(outputExceeded ? "docker_output_limit" : `docker_command_failed:${exitCode ?? "spawn"}`);
  }
}

export function isMissingDockerResource(stderr: string): boolean {
  return /no such (?:container|network|volume|object)|is not connected to network/i.test(stderr);
}

export interface NodeDockerCommandRunnerOptions {
  dockerBinary?: string;
  path?: string;
  homeDir: string;
  dockerHost?: string;
  dockerContext?: string;
}

/** Runs Docker with argument arrays and an explicit, minimal environment. */
export class NodeDockerCommandRunner implements DockerCommandRunner {
  private readonly dockerBinary: string;
  private readonly path: string;

  constructor(private readonly options: NodeDockerCommandRunnerOptions) {
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.path = options.path ?? "/usr/local/bin:/usr/bin:/bin";
  }

  async run(args: readonly string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
    if (args.some((argument) => argument.includes("\0"))) throw new Error("docker_argument_invalid");
    const extraEnv = options.env ?? {};
    if (Object.keys(extraEnv).some((key) => key !== "REEVO_RUN_CAPABILITY"))
      throw new Error("docker_environment_invalid");
    const env: NodeJS.ProcessEnv = {
      PATH: this.path,
      HOME: this.options.homeDir,
      LANG: "C",
      LC_ALL: "C",
      ...(this.options.dockerHost ? { DOCKER_HOST: this.options.dockerHost } : {}),
      ...(this.options.dockerContext ? { DOCKER_CONTEXT: this.options.dockerContext } : {}),
      ...extraEnv,
    };
    const maxBytes = options.maxOutputBytes ?? MAX_DOCKER_OUTPUT_BYTES;
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.dockerBinary, [...args], { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      if (!child.stdout || !child.stderr) {
        child.kill("SIGKILL");
        rejectPromise(new DockerCommandError(null));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let exceeded = false;
      let spawnFailed = false;
      const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          exceeded = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on("data", capture(stdout));
      child.stderr.on("data", capture(stderr));
      child.once("error", () => {
        spawnFailed = true;
      });
      child.once("close", (code) => {
        if (exceeded) return rejectPromise(new DockerCommandError(code, false, true));
        if (spawnFailed) return rejectPromise(new DockerCommandError(null));
        const result = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (code !== 0) {
          return rejectPromise(new DockerCommandError(code, isMissingDockerResource(result.stderr)));
        }
        resolvePromise(result);
      });
    });
  }
}

export interface DockerArtifactTransfer {
  seedDirectory(sourceDirectory: string, container: string, destination: string): Promise<void>;
  seedInput(sourceFile: string, container: string): Promise<void>;
  materializeDirectory(container: string, source: string, destination: string, maxBytes: number): Promise<void>;
}

export function dockerTransferEnvironment(path: string): NodeJS.ProcessEnv {
  return { PATH: path, LANG: "C", LC_ALL: "C", COPYFILE_DISABLE: "1" };
}

/** Streams tar archives into the unprivileged keeper; no host bind mounts are used. */
export class NodeDockerArtifactTransfer implements DockerArtifactTransfer {
  constructor(
    private readonly dockerBinary = "docker",
    private readonly path = "/usr/local/bin:/usr/bin:/bin",
  ) {}

  async seedDirectory(sourceDirectory: string, container: string, destination: string): Promise<void> {
    const metadata = await lstat(sourceDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("docker_seed_directory_invalid");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const archive = spawn("tar", ["-C", sourceDirectory, "-cf", "-", "."], {
        env: dockerTransferEnvironment(this.path),
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const extract = spawn(
        this.dockerBinary,
        [
          "container",
          "exec",
          "--interactive",
          "--user",
          "10001:10001",
          container,
          "tar",
          "-C",
          destination,
          "--no-same-owner",
          "--no-same-permissions",
          "-xf",
          "-",
        ],
        { env: dockerTransferEnvironment(this.path), shell: false, stdio: ["pipe", "ignore", "ignore"] },
      );
      let failed = false;
      const fail = () => {
        if (failed) return;
        failed = true;
        archive.kill("SIGKILL");
        extract.kill("SIGKILL");
        rejectPromise(new Error("docker_seed_failed"));
      };
      archive.once("error", fail);
      extract.once("error", fail);
      if (!archive.stdout || !extract.stdin) return fail();
      archive.stdout.pipe(extract.stdin);
      archive.once("close", (code) => {
        if (code !== 0) fail();
      });
      extract.once("close", (code) => {
        if (code !== 0) fail();
        else if (!failed) resolvePromise();
      });
    });
  }

  async seedInput(sourceFile: string, container: string): Promise<void> {
    const metadata = await lstat(sourceFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CODING_ARTIFACT_BYTES) {
      throw new Error("docker_input_artifact_invalid");
    }
    const docker = new NodeDockerCommandRunner({
      dockerBinary: this.dockerBinary,
      homeDir: "/tmp",
      path: this.path,
    });
    await docker.run(["container", "cp", sourceFile, `${container}:/run/reevo/storage/input/input.json`]);
  }

  async materializeDirectory(container: string, source: string, destination: string, maxBytes: number): Promise<void> {
    const target = resolve(destination);
    const parent = dirname(target);
    const [parentReal, targetReal, targetStat] = await Promise.all([realpath(parent), realpath(target), lstat(target)]);
    if (
      !targetStat.isDirectory() ||
      targetStat.isSymbolicLink() ||
      targetReal !== resolve(parentReal, target.slice(parent.length + 1))
    ) {
      throw new Error("docker_workspace_destination_invalid");
    }

    const staging = await mkdtemp(join(parentReal, ".reevo-workspace-stage-"));
    const backup = await mkdtemp(join(parentReal, ".reevo-workspace-backup-"));
    await rm(backup, { recursive: true });
    let targetMoved = false;
    try {
      await new NodeDockerCommandRunner({ dockerBinary: this.dockerBinary, homeDir: "/tmp", path: this.path }).run([
        "container",
        "cp",
        `${container}:${source}/.`,
        staging,
      ]);
      await validateMaterializedWorkspace(staging, maxBytes);
      await rename(targetReal, backup);
      targetMoved = true;
      await rename(staging, targetReal);
      targetMoved = false;
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (targetMoved) await rename(backup, targetReal).catch(() => undefined);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(backup, { recursive: true, force: true });
    }
  }
}

export async function validateMaterializedWorkspace(root: string, maxBytes: number): Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("docker_workspace_limit_invalid");
  let entries = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > MAX_WORKSPACE_ENTRIES) throw new Error("docker_workspace_entry_limit");
      if (entry.name.toLowerCase() === ".git") throw new Error("docker_workspace_nested_repository");
      const fullPath = resolve(directory, entry.name);
      const metadata = await lstat(fullPath);
      if (metadata.isSymbolicLink()) {
        const target = await readlink(fullPath);
        const resolvedTarget = resolve(directory, target);
        if (isAbsolute(target) || (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`))) {
          throw new Error("docker_workspace_symlink_escape");
        }
      } else if (metadata.isDirectory()) {
        await visit(fullPath);
      } else if (metadata.isFile()) {
        bytes += metadata.size;
        if (bytes > maxBytes) throw new Error("docker_workspace_size_limit");
      } else {
        throw new Error("docker_workspace_special_file");
      }
    }
  };
  await visit(root);
}

export interface DockerJobLauncherOptions {
  stateRoot: string;
  workspaceRoot: string;
  proxyContainer: string;
  resolveCapability: (runId: string) => Promise<string>;
  /** Consult the durable application state before a startup sweep deletes resources. */
  isRunActive: (runId: string, handle: JobHandle) => Promise<boolean>;
  docker?: DockerCommandRunner;
  transfer?: DockerArtifactTransfer;
  now?: () => number;
}

type DockerJobPhase = "provisioning" | "active" | "succeeded" | "failed" | "stopped" | "lost" | "removed";

interface DockerJobRecord {
  schemaVersion: number;
  runId: string;
  spec: JobSpec;
  specHash: string;
  handle: JobHandle;
  jobId: string;
  createdAt: number;
  deadlineAt: number;
  capabilityHash: string;
  phase: DockerJobPhase;
  result?: JobResult;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableSpecHash(spec: JobSpec): string {
  return hash(
    JSON.stringify({
      ...spec,
      labels: Object.fromEntries(Object.entries(spec.labels).sort(([left], [right]) => left.localeCompare(right))),
    }),
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isTerminal(record: DockerJobRecord): boolean {
  return TERMINAL_PHASES.has(record.phase);
}

function statusFor(record: DockerJobRecord): JobStatus {
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

function resultFor(phase: Exclude<DockerJobPhase, "provisioning" | "active" | "removed">): JobResult {
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

function ensureCapability(value: string): string {
  if (!/^rrp_[A-Za-z0-9_-]{16,512}$/.test(value)) throw new Error("docker_capability_invalid");
  return value;
}

function appendLabels(args: readonly string[], labels: Record<string, string>): string[] {
  const entrypointIndex = args.indexOf("--entrypoint");
  const imageIndex = entrypointIndex >= 0 ? entrypointIndex + 2 : args.length - 1;
  if (!args[imageIndex]) throw new Error("docker_plan_invalid");
  const trusted = Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  return [...args.slice(0, imageIndex), ...trusted, ...args.slice(imageIndex)];
}

function stateFileName(runId: string): string {
  return `${hash(runId)}.json`;
}

function resourceLabels(record: DockerJobRecord): Record<string, string> {
  return {
    "io.reevo.managed": "true",
    "io.reevo.component": "coding-worker",
    "io.reevo.run-sha256": hash(record.runId),
    "io.reevo.run-id": record.runId,
    "io.reevo.job-id": record.jobId,
    "io.reevo.spec-sha256": record.specHash,
    "io.reevo.created-at": new Date(record.createdAt).toISOString(),
    "io.reevo.schema": String(STATE_SCHEMA_VERSION),
  };
}

function labelsMatch(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

function capabilityFromInspection(container: DockerContainerInspection): string | undefined {
  return container.Config?.Env?.find((value) => value.startsWith("REEVO_RUN_CAPABILITY="))?.slice(
    "REEVO_RUN_CAPABILITY=".length,
  );
}

function dockerState(inspection: {
  State?: { Running?: boolean; Status?: string; ExitCode?: number; OOMKilled?: boolean };
}): DockerJobPhase | undefined {
  const state = inspection.State;
  if (!state) return undefined;
  if (state.Running || state.Status === "restarting") return "active";
  if (state.Status === "created") return "provisioning";
  if (state.Status === "exited") {
    if (state.OOMKilled) return "failed";
    return state.ExitCode === 0 ? "succeeded" : "failed";
  }
  return undefined;
}

function terminalResult(
  phase: DockerJobPhase,
  inspection?: { State?: { ExitCode?: number; OOMKilled?: boolean } },
): JobResult | undefined {
  if (phase === "succeeded") return { exitCode: 0, reason: "completed" };
  if (phase === "failed")
    return {
      exitCode: inspection?.State?.OOMKilled ? 137 : Math.max(1, inspection?.State?.ExitCode ?? 1),
      reason: "failed",
    };
  if (phase === "stopped" || phase === "lost") return resultFor(phase);
  return undefined;
}

export class DockerJobLauncher implements WorkspaceJobLauncher {
  private readonly stateRoot: string;
  private readonly workspaceRoot: string;
  private readonly docker: DockerCommandRunner;
  private readonly transfer: DockerArtifactTransfer;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ready: Promise<void>;

  constructor(private readonly options: DockerJobLauncherOptions) {
    this.stateRoot = resolve(options.stateRoot);
    this.workspaceRoot = resolve(options.workspaceRoot);
    if (this.stateRoot === resolve("/") || this.workspaceRoot === resolve("/"))
      throw new Error("docker_launcher_path_invalid");
    this.docker = options.docker ?? new NodeDockerCommandRunner({ homeDir: join(this.stateRoot, ".home") });
    this.transfer = options.transfer ?? new NodeDockerArtifactTransfer();
    this.now = options.now ?? Date.now;
    this.ready = this.initialize();
  }

  async launch(spec: JobSpec): Promise<JobHandle> {
    await this.ready;
    return this.withRun(spec.runId, async () => this.launchLocked(spec));
  }

  async status(handle: JobHandle): Promise<JobStatus> {
    await this.ready;
    const record = await this.findRecord(handle);
    if (!record) throw new Error("job_not_found");
    return this.withRun(record.runId, async () => {
      const current = await this.readRecord(record.runId);
      if (!current) throw new Error("job_not_found");
      if (current.phase === "removed") throw new Error("job_removed");
      await this.refresh(current);
      return clone(statusFor(current));
    });
  }

  async collect(handle: JobHandle): Promise<JobResult> {
    await this.ready;
    const record = await this.findRecord(handle);
    if (!record) throw new Error("job_not_found");
    return this.withRun(record.runId, async () => {
      const current = await this.requireRecord(record.runId);
      if (current.phase === "removed") throw new Error("job_removed");
      await this.refresh(current);
      if (!isTerminal(current)) throw new Error("job_not_terminal");
      if (!current.result) current.result = resultFor(current.phase as "succeeded" | "failed" | "stopped" | "lost");
      if (current.phase === "failed" && !current.result.diagnostic) {
        const diagnostic = await this.readWorkerFailureDiagnostic(current);
        if (diagnostic) {
          current.result = { ...current.result, diagnostic };
          await this.writeRecord(current);
        }
      }
      if (current.phase === "succeeded" && !current.result.resultArtifact) {
        const artifact = await this.readResultArtifact(current);
        current.result = { ...current.result, resultArtifact: artifact };
        await this.writeRecord(current);
      }
      return clone(current.result);
    });
  }

  async materializeWorkspace(handle: JobHandle, destination: string): Promise<void> {
    await this.ready;
    const record = await this.findRecord(handle);
    if (!record) throw new Error("job_not_found");
    await this.withRun(record.runId, async () => {
      const current = await this.requireRecord(record.runId);
      await this.refresh(current);
      if (current.phase !== "succeeded") throw new Error("job_not_succeeded");
      const expected = resolve(this.workspaceRoot, current.runId, "workspace");
      if (resolve(destination) !== expected || !expected.startsWith(`${this.workspaceRoot}${sep}`)) {
        throw new Error("docker_workspace_destination_invalid");
      }
      await this.transfer.materializeDirectory(
        this.keeperName(current),
        "/run/reevo/storage/workspace",
        expected,
        current.spec.limits.diskMb * 1024 * 1024,
      );
    });
  }

  async stop(handle: JobHandle, _reason?: string): Promise<void> {
    await this.ready;
    const record = await this.findRecord(handle);
    if (!record) return;
    await this.withRun(record.runId, async () => {
      const current = await this.readRecord(record.runId);
      if (!current || isTerminal(current)) return;
      await this.stopRecord(current, false);
    });
  }

  async remove(handle: JobHandle): Promise<void> {
    await this.ready;
    const record = await this.findRecord(handle);
    if (!record) return;
    await this.withRun(record.runId, async () => {
      const current = await this.requireRecord(record.runId);
      if (current.phase === "removed") return;
      await this.refresh(current);
      if (!isTerminal(current)) throw new Error("job_not_terminal");
      await this.cleanupResources(current);
      current.phase = "removed";
      await this.writeRecord(current);
      this.clearDeadline(current);
    });
  }

  private async initialize(): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(this.stateRoot, ".home"), { recursive: true, mode: 0o700 });
    await realpath(this.stateRoot);
    const records = await this.allRecords();
    for (const record of records) {
      if (record.phase === "removed") continue;
      if (record.deadlineAt <= this.now()) {
        const active = await this.options.isRunActive(record.runId, clone(record.handle));
        if (active) await this.withRun(record.runId, async () => this.stopRecord(record, true));
        else await this.withRun(record.runId, async () => this.sweepExpired(record));
      } else if (!isTerminal(record)) {
        this.scheduleDeadline(record);
      }
    }
  }

  private async launchLocked(spec: JobSpec): Promise<JobHandle> {
    const plan = buildDockerIsolationPlan(spec, this.options.proxyContainer);
    const specHash = stableSpecHash(spec);
    const existing = await this.readRecord(spec.runId);
    if (existing) {
      if (existing.specHash !== specHash) throw new Error("job_spec_conflict");
      if (existing.phase === "removed" || isTerminal(existing)) return clone(existing.handle);
      const capability = ensureCapability(await this.options.resolveCapability(spec.runId));
      if (hash(capability) !== existing.capabilityHash) throw new Error("docker_capability_changed");
      if (existing.phase === "active") {
        await this.refresh(existing);
        return clone(existing.handle);
      }
      return this.provision(existing, plan, capability);
    }
    await this.validateInputArtifact(spec.inputArtifact);
    const capability = ensureCapability(await this.options.resolveCapability(spec.runId));
    const record: DockerJobRecord = {
      schemaVersion: STATE_SCHEMA_VERSION,
      runId: spec.runId,
      spec: clone(spec),
      specHash,
      handle: { backend: BACKEND, id: plan.names.workerContainer },
      jobId: `job-${hash(`${spec.runId}:${specHash}`).slice(0, 24)}`,
      createdAt: this.now(),
      deadlineAt: this.now() + plan.deadlineMs,
      capabilityHash: hash(capability),
      phase: "provisioning",
    };
    // This durable record is the idempotency fence before any Docker side effect.
    await this.writeRecord(record);
    return this.provision(record, plan, capability);
  }

  private async provision(
    record: DockerJobRecord,
    plan: ReturnType<typeof buildDockerIsolationPlan>,
    capability: string,
  ): Promise<JobHandle> {
    await this.assertHost();
    const labels = resourceLabels(record);
    await this.createAndAssert(
      appendLabels(plan.networkCreateArgs, labels),
      ["network", "inspect", plan.names.network],
      (value) => {
        const inspected = value as Parameters<typeof assertIsolationNetworkInspection>[0];
        assertIsolationNetworkInspection(inspected, record.runId);
        if (!labelsMatch(inspected.Labels, labels)) throw new Error("docker_resource_attestation_failed");
      },
    );
    await this.createAndAssert(
      appendLabels(plan.storageVolumeCreateArgs, labels),
      ["volume", "inspect", plan.names.storageVolume],
      (value) => {
        const inspected = value as Parameters<typeof assertStorageVolumeInspection>[0];
        assertStorageVolumeInspection(inspected, record.spec);
        if (!labelsMatch(inspected.Labels, labels)) throw new Error("docker_resource_attestation_failed");
      },
    );
    await this.createAndAssert(
      appendLabels(plan.keeperCreateArgs, labels),
      ["container", "inspect", plan.names.keeperContainer],
      (value) => {
        const inspected = value as DockerContainerInspection;
        assertKeeperContainerInspection(inspected, record.spec);
        if (!labelsMatch(inspected.Config?.Labels, labels)) throw new Error("docker_resource_attestation_failed");
      },
    );
    await this.startContainer(plan.names.keeperContainer);
    await this.waitForStorage(plan.names.keeperContainer);
    await this.seedRun(record, plan.names.keeperContainer);
    await this.run(plan.proxyNetworkConnectArgs);
    const proxy = await this.inspect<DockerContainerInspection>(["container", "inspect", this.options.proxyContainer]);
    assertProxyContainerInspection(proxy, record.runId);
    const workerArgs = appendLabels(plan.workerCreateArgs, labels);
    await this.createAndAssert(
      workerArgs,
      ["container", "inspect", plan.names.workerContainer],
      (value) => {
        const inspected = value as DockerContainerInspection;
        assertWorkerContainerInspection(inspected, record.spec, capability);
        if (!labelsMatch(inspected.Config?.Labels, labels)) throw new Error("docker_resource_attestation_failed");
      },
      { env: { REEVO_RUN_CAPABILITY: capability } },
    );
    await this.startContainer(plan.names.workerContainer);
    record.phase = "active";
    await this.writeRecord(record);
    this.scheduleDeadline(record);
    return clone(record.handle);
  }

  private async refresh(record: DockerJobRecord): Promise<void> {
    if (isTerminal(record)) return;
    if (record.deadlineAt <= this.now()) {
      await this.stopRecord(record, true);
      return;
    }
    let inspection: DockerContainerInspection & {
      State?: { Running?: boolean; Status?: string; ExitCode?: number; OOMKilled?: boolean };
    };
    try {
      inspection = await this.inspect(["container", "inspect", record.handle.id]);
    } catch (error) {
      if (error instanceof DockerCommandError && error.notFound) {
        record.phase = "lost";
        record.result = resultFor("lost");
        await this.writeRecord(record);
        this.clearDeadline(record);
        return;
      }
      throw new Error("docker_status_unavailable", { cause: error });
    }
    if (!labelsMatch(inspection.Config?.Labels, resourceLabels(record)))
      throw new Error("docker_resource_attestation_failed");
    const capability = capabilityFromInspection(inspection);
    if (!capability || hash(capability) !== record.capabilityHash)
      throw new Error("docker_resource_attestation_failed");
    assertWorkerContainerInspection(inspection, record.spec, capability);
    const phase = dockerState(inspection);
    if (!phase || phase === "provisioning" || phase === "active") return;
    record.phase = phase;
    record.result = terminalResult(phase, inspection);
    await this.writeRecord(record);
    this.clearDeadline(record);
  }

  private async stopRecord(record: DockerJobRecord, timedOut: boolean): Promise<void> {
    if (isTerminal(record)) return;
    try {
      await this.run(["container", "stop", "--time", "10", record.handle.id]);
    } catch (error) {
      if (!(error instanceof DockerCommandError && error.notFound))
        throw new Error("docker_stop_failed", { cause: error });
    }
    record.phase = timedOut ? "failed" : "stopped";
    record.result = timedOut ? { exitCode: 124, reason: "timed_out" } : resultFor("stopped");
    await this.writeRecord(record);
    this.clearDeadline(record);
  }

  private async sweepExpired(record: DockerJobRecord): Promise<void> {
    // The DB verifier ran immediately before this call; never sweep by label alone.
    try {
      await this.cleanupResources(record);
    } catch (error) {
      if (!(error instanceof DockerCommandError && error.notFound)) throw error;
    }
    record.phase = "removed";
    await this.writeRecord(record);
    this.clearDeadline(record);
  }

  private async cleanupResources(record: DockerJobRecord): Promise<void> {
    const plan = buildDockerIsolationPlan(record.spec, this.options.proxyContainer);
    const labels = resourceLabels(record);
    await this.removeContainerIfAttested(plan.names.workerContainer, labels);
    await this.runIgnoreMissing(["network", "disconnect", plan.names.network, this.options.proxyContainer]);
    await this.removeContainerIfAttested(plan.names.keeperContainer, labels);
    await this.removeNetworkIfAttested(plan.names.network, labels);
    await this.removeVolumeIfAttested(plan.names.storageVolume, labels);
  }

  private async removeContainerIfAttested(name: string, labels: Record<string, string>): Promise<void> {
    try {
      const inspected = await this.inspect<DockerContainerInspection>(["container", "inspect", name]);
      if (!labelsMatch(inspected.Config?.Labels, labels)) throw new Error("docker_resource_attestation_failed");
      await this.runIgnoreMissing(["container", "rm", "--force", name]);
    } catch (error) {
      if (!(error instanceof DockerCommandError && error.notFound)) throw error;
    }
  }

  private async removeNetworkIfAttested(name: string, labels: Record<string, string>): Promise<void> {
    try {
      const inspected = await this.inspect<{ Labels?: Record<string, string> }>(["network", "inspect", name]);
      if (!labelsMatch(inspected.Labels, labels)) throw new Error("docker_resource_attestation_failed");
      await this.runIgnoreMissing(["network", "rm", name]);
    } catch (error) {
      if (!(error instanceof DockerCommandError && error.notFound)) throw error;
    }
  }

  private async removeVolumeIfAttested(name: string, labels: Record<string, string>): Promise<void> {
    try {
      const inspected = await this.inspect<{ Labels?: Record<string, string> }>(["volume", "inspect", name]);
      if (!labelsMatch(inspected.Labels, labels)) throw new Error("docker_resource_attestation_failed");
      await this.runIgnoreMissing(["volume", "rm", name]);
    } catch (error) {
      if (!(error instanceof DockerCommandError && error.notFound)) throw error;
    }
  }

  private async seedRun(record: DockerJobRecord, keeper: string): Promise<void> {
    const runRoot = resolve(this.workspaceRoot, record.runId);
    if (!runRoot.startsWith(`${this.workspaceRoot}/`)) throw new Error("docker_workspace_path_invalid");
    await this.transfer.seedDirectory(resolve(runRoot, "workspace"), keeper, "/run/reevo/storage/workspace");
    await this.transfer.seedDirectory(resolve(runRoot, "git"), keeper, "/run/reevo/storage/git");
    await this.transfer.seedInput(record.spec.inputArtifact, keeper);
  }

  private async readResultArtifact(record: DockerJobRecord): Promise<string> {
    const staging = await mkdtemp(join(this.stateRoot, ".reevo-result-"));
    const target = join(staging, "result.json");
    try {
      await this.run(["container", "cp", `${this.keeperName(record)}:/run/reevo/storage/output/result.json`, target]);
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CODING_ARTIFACT_BYTES) {
        throw new Error("docker_result_artifact_invalid");
      }
      const raw = await readFile(target, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_CODING_ARTIFACT_BYTES) throw new Error("docker_result_artifact_invalid");
      const output = parseCodingAgentOutputJson(raw);
      if (output.runId !== record.runId) throw new Error("docker_result_run_mismatch");
      return JSON.stringify(output);
    } catch (error) {
      if (error instanceof Error && error.message === "docker_result_run_mismatch") throw error;
      throw new Error("docker_result_artifact_invalid", { cause: error });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async readWorkerFailureDiagnostic(record: DockerJobRecord): Promise<string | undefined> {
    try {
      const logs = await this.run(["container", "logs", "--tail", "8", record.handle.id]);
      const raw = `${logs.stdout}\n${logs.stderr}`;
      for (const line of raw.split("\n").reverse()) {
        try {
          const value = JSON.parse(line) as { error?: unknown };
          if (typeof value.error === "string" && SAFE_WORKER_DIAGNOSTIC.test(value.error)) return value.error;
        } catch {
          // Worker output is untrusted; only parse one fixed JSON shape.
        }
      }
    } catch {
      // Diagnostics are optional and must never affect terminal cleanup.
    }
    return undefined;
  }

  private keeperName(record: DockerJobRecord): string {
    return buildDockerIsolationPlan(record.spec, this.options.proxyContainer).names.keeperContainer;
  }

  private async assertHost(): Promise<void> {
    const info = await this.inspect<DockerHostInfo>(["info", "--format", "{{json .}}"]);
    assertDockerHostSupportsIsolation(info);
  }

  private async createAndAssert(
    createArgs: readonly string[],
    inspectArgs: readonly string[],
    assert: (value: unknown) => void,
    options?: DockerCommandOptions,
  ): Promise<void> {
    try {
      await this.run(createArgs, options);
    } catch {
      // A retry may find a resource created before the previous process crashed.
    }
    assert(await this.inspect(inspectArgs));
  }

  private async waitForStorage(keeper: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await this.run([
          "container",
          "exec",
          "--user",
          "10001:10001",
          keeper,
          "test",
          "-d",
          "/run/reevo/storage/output",
        ]);
        return;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw new Error("docker_storage_not_ready");
  }

  private async validateInputArtifact(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CODING_ARTIFACT_BYTES) {
      throw new Error("docker_input_artifact_invalid");
    }
  }

  private async run(args: readonly string[], options?: DockerCommandOptions): Promise<DockerCommandResult> {
    return this.docker.run(args, options);
  }

  private async runIgnoreMissing(args: readonly string[]): Promise<void> {
    try {
      await this.run(args);
    } catch (error) {
      if (!(error instanceof DockerCommandError && error.notFound)) throw error;
    }
  }

  private async startContainer(name: string): Promise<void> {
    try {
      await this.run(["container", "start", name]);
    } catch (error) {
      if (!(error instanceof DockerCommandError)) throw error;
      const inspection = await this.inspect<{ State?: { Running?: boolean } }>(["container", "inspect", name]);
      if (inspection.State?.Running !== true) throw new Error("docker_start_failed", { cause: error });
    }
  }

  private async inspect<T>(args: readonly string[]): Promise<T> {
    const output = (await this.run(args, { maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES })).stdout;
    let decoded: unknown;
    try {
      decoded = JSON.parse(output);
    } catch {
      throw new Error("docker_inspection_invalid");
    }
    return (Array.isArray(decoded) ? decoded[0] : decoded) as T;
  }

  private async findRecord(handle: JobHandle): Promise<DockerJobRecord | undefined> {
    if (handle.backend !== BACKEND) throw new Error("job_backend_mismatch");
    return (await this.allRecords()).find((record) => record.handle.id === handle.id);
  }

  private async requireRecord(runId: string): Promise<DockerJobRecord> {
    const record = await this.readRecord(runId);
    if (!record) throw new Error("job_not_found");
    return record;
  }

  private async readRecord(runId: string): Promise<DockerJobRecord | undefined> {
    try {
      const decoded = JSON.parse(await readFile(join(this.stateRoot, stateFileName(runId)), "utf8")) as DockerJobRecord;
      if (
        decoded.schemaVersion !== STATE_SCHEMA_VERSION ||
        decoded.runId !== runId ||
        decoded.handle?.backend !== BACKEND ||
        !decoded.handle.id ||
        !decoded.specHash ||
        !decoded.capabilityHash
      ) {
        throw new Error("docker_state_invalid");
      }
      return decoded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async allRecords(): Promise<DockerJobRecord[]> {
    const entries = await readdir(this.stateRoot, { withFileTypes: true });
    if (entries.length > 10_000) throw new Error("docker_state_limit");
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
        .map(async (entry) => JSON.parse(await readFile(join(this.stateRoot, entry.name), "utf8")) as DockerJobRecord),
    );
    if (
      records.some(
        (record) =>
          record.schemaVersion !== STATE_SCHEMA_VERSION || stateFileName(record.runId) !== hash(record.runId) + ".json",
      )
    ) {
      throw new Error("docker_state_invalid");
    }
    return records;
  }

  private async writeRecord(record: DockerJobRecord): Promise<void> {
    const path = join(this.stateRoot, stateFileName(record.runId));
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`);
      await file.sync();
      await file.close();
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async withRun<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queued = previous.then(() => next);
    this.locks.set(runId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(runId) === queued) this.locks.delete(runId);
    }
  }

  private scheduleDeadline(record: DockerJobRecord): void {
    this.clearDeadline(record);
    const delay = Math.max(0, record.deadlineAt - this.now());
    const timer = setTimeout(() => {
      void this.withRun(record.runId, async () => {
        const current = await this.readRecord(record.runId);
        if (current && !isTerminal(current) && current.deadlineAt <= this.now()) await this.stopRecord(current, true);
      }).catch(() => undefined);
    }, delay);
    timer.unref();
    this.timers.set(record.runId, timer);
  }

  private clearDeadline(record: DockerJobRecord): void {
    const timer = this.timers.get(record.runId);
    if (timer) clearTimeout(timer);
    this.timers.delete(record.runId);
  }
}
