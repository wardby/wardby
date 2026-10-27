import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExclusions, type CollectExclusions } from "../../coding/collect-exclude.js";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition, type ResolvedCodingService } from "../../coding/services/catalog.js";
import { jobLauncherContract } from "./contract-suite.js";
import {
  DockerCommandError,
  DockerJobLauncher,
  dockerTransferEnvironment,
  isMissingDockerResource,
  NodeDockerCommandRunner,
  validateMaterializedWorkspace,
  type DockerArtifactTransfer,
  type DockerCommandOptions,
  type DockerCommandResult,
  type DockerCommandRunner,
  type DockerJobLauncherOptions,
  parseWorkerDiagnosticLine,
} from "./docker.js";
import { buildDockerIsolationPlan, NETWORK_KEEPER_SCRIPT, WORKER_PATHS } from "./docker-isolation.js";
import { dockerServiceContainerName, serviceMemoryMib, serviceTmpfsOptions } from "./docker-services.js";
import { claudeToolSetup } from "./claude-tool-setup.js";
import type { ServiceStateUpdate } from "./service-state.js";
import type { JobHandle, JobResult, JobSpec } from "./types.js";

const image = `registry.example/wardby-worker@sha256:${"a".repeat(64)}`;
const toolImage = `registry.example/wardby-tools@sha256:${"b".repeat(64)}`;
const capability = "rrp_0123456789abcdef";
const temporaryRoots: string[] = [];

describe("Docker artifact transfer", () => {
  it("disables macOS AppleDouble sidecars in streamed workspace archives", () => {
    expect(dockerTransferEnvironment("/usr/bin")).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/tmp",
      LANG: "C",
      LC_ALL: "C",
      COPYFILE_DISABLE: "1",
    });
  });
});

describe("DockerCommandError diagnostics", () => {
  it("keeps the daemon's wording out of the public message but carries it as a cause", () => {
    const error = new DockerCommandError(1, false, false, {
      subcommand: "network",
      stderr: "Error response from daemon: No such container: wardby-coding-proxy",
    });

    expect(error.message).toBe("docker_command_failed:1");
    expect(String((error.cause as Error).message)).toBe(
      "docker network: Error response from daemon: No such container: wardby-coding-proxy",
    );
  });

  it("redacts token-shaped values in the cause and survives empty stderr", () => {
    const withToken = new DockerCommandError(1, false, false, {
      subcommand: "run",
      stderr: "denied: authentication required, token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
    });
    const causeMessage = String((withToken.cause as Error).message);

    expect(causeMessage).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
    expect(causeMessage).toContain("[REDACTED]");
    expect(
      String((new DockerCommandError(1, false, false, { subcommand: "rm", stderr: "" }).cause as Error).message),
    ).toBe("docker rm: (no stderr)");
  });

  it("omits the cause entirely when no detail was captured", () => {
    expect(new DockerCommandError(null).cause).toBeUndefined();
  });
});

describe("Docker cleanup classification", () => {
  it("treats an already-disconnected network attachment as missing", () => {
    expect(isMissingDockerResource("container abc is not connected to network wardby-net-run")).toBe(true);
    expect(isMissingDockerResource("permission denied")).toBe(false);
  });

  it("treats Docker's own 'network ... not found' wording as missing", () => {
    // Verified live against the Docker CLI: `docker network inspect`/`rm`/`disconnect`
    // on a genuinely-missing network reply "network <name> not found", not "no such network".
    expect(isMissingDockerResource("Error response from daemon: network wardby-net-run not found")).toBe(true);
  });
});

const claudeLimits = { cpus: 1.5, memoryMb: 1024, pids: 128, diskMb: 512 };

function spec(runId = "docker-run-1"): JobSpec {
  return {
    kind: "coding-agent",
    runId,
    image,
    inputArtifact: "",
    timeoutSec: 900,
    limits: { cpus: 1.5, memoryMb: 1024, pids: 64, diskMb: 512 },
    labels: { untrusted: "must-not-reach-docker" },
  };
}

function labels(args: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const [key, value] = (args[index + 1] ?? "").split("=", 2);
    if (key && value) result[key] = value;
  }
  return result;
}

class NoopTransfer implements DockerArtifactTransfer {
  materializations = 0;
  exclusions: CollectExclusions[] = [];
  async seedDirectory(): Promise<void> {}
  async seedInput(): Promise<void> {}
  async materializeDirectory(
    _container: string,
    _source: string,
    _destination: string,
    _maxBytes: number,
    exclusions: CollectExclusions,
  ): Promise<void> {
    this.materializations += 1;
    this.exclusions.push(exclusions);
  }
}

class FailingSeedTransfer extends NoopTransfer {
  override async seedDirectory(): Promise<void> {
    throw new Error("seed_failed");
  }
}

class FakeDocker implements DockerCommandRunner {
  readonly plan: ReturnType<typeof buildDockerIsolationPlan>;
  readonly calls: { args: readonly string[]; options?: DockerCommandOptions }[] = [];
  protected readonly resourceLabels = new Map<string, Record<string, string>>();
  private workerState: { status: string; running: boolean; exitCode?: number; oomKilled?: boolean } = {
    status: "created",
    running: false,
  };
  private toolState: { status: string; running: boolean } = { status: "created", running: false };
  private keeperRemoved = false;
  private workerRemoved = false;
  toolRemoved = false;
  private networkRemoved = false;
  private volumeRemoved = false;
  private proxyConnected = false;
  output = "";

  constructor(
    readonly job: JobSpec,
    private readonly proxy = "trusted-proxy",
  ) {
    this.plan = buildDockerIsolationPlan(job, proxy);
  }

  async run(args: readonly string[], options?: DockerCommandOptions): Promise<DockerCommandResult> {
    this.calls.push({ args, options });
    const [group, action, target] = args;
    if (group === "info")
      return this.json({
        OSType: "linux",
        CgroupVersion: "2",
        MemoryLimit: true,
        SwapLimit: true,
        CpuCfsQuota: true,
        PidsLimit: true,
        SecurityOptions: ["name=seccomp,profile=builtin"],
        Plugins: { Volume: ["local"], Network: ["bridge"] },
      });
    if (action === "create") {
      const nameIndex = args.indexOf("--name");
      const name = nameIndex >= 0 ? args[nameIndex + 1] : args.at(-1);
      if (!name) throw new Error("fake_docker_name_missing");
      this.resourceLabels.set(name, labels(args));
      return this.ok();
    }
    if (group === "network" && action === "connect") {
      this.proxyConnected = true;
      return this.ok();
    }
    if (group === "container" && action === "start") {
      if (target === this.plan.names.workerContainer) this.workerState = { status: "running", running: true };
      if (target === this.plan.names.toolContainer) this.toolState = { status: "running", running: true };
      return this.ok();
    }
    if (group === "container" && action === "stop") {
      if (target === this.plan.names.workerContainer)
        this.workerState = { status: "exited", running: false, exitCode: 143 };
      if (target === this.plan.names.toolContainer) this.toolState = { status: "exited", running: false };
      return this.ok();
    }
    if (group === "container" && action === "rm") {
      const name = args.at(-1)!;
      if (name === this.plan.names.workerContainer) this.workerRemoved = true;
      if (name === this.plan.names.toolContainer) this.toolRemoved = true;
      if (name === this.plan.names.keeperContainer) this.keeperRemoved = true;
      return this.ok();
    }
    if (group === "network" && action === "rm") {
      this.networkRemoved = true;
      return this.ok();
    }
    if (group === "volume" && action === "rm") {
      this.volumeRemoved = true;
      return this.ok();
    }
    if (group === "network" && action === "disconnect") return this.ok();
    if (group === "container" && action === "cp") {
      await writeFile(args.at(-1)!, this.output, { mode: 0o600 });
      return this.ok();
    }
    if (group === "container" && action === "logs" && args.at(-1) === this.plan.names.keeperContainer) {
      return { stdout: "wardby_storage_ready\n", stderr: "" };
    }
    if (group === "container" && action === "logs" && args.at(-1) === this.plan.names.toolContainer) {
      return { stdout: "wardby_tool_runner_ready\n", stderr: "" };
    }
    if (group === "container" && action === "exec") {
      return args.includes("node") ? { stdout: this.output, stderr: "" } : this.ok();
    }
    if (action === "inspect") return this.inspect(target);
    throw new Error(`unexpected_docker_command:${args.join(" ")}`);
  }

  finish(): void {
    this.workerState = { status: "exited", running: false, exitCode: 0 };
    this.output = JSON.stringify({
      schemaVersion: 1,
      runId: this.job.runId,
      outcome: "no_changes",
      summary: "done",
      tests: [],
    });
  }

  lose(): void {
    this.workerRemoved = true;
  }

  failTool(): void {
    this.toolState = { status: "exited", running: false };
  }

  private inspect(name: string): DockerCommandResult {
    if (
      (name === this.plan.names.workerContainer && this.workerRemoved) ||
      (name === this.plan.names.toolContainer && this.toolRemoved) ||
      (name === this.plan.names.keeperContainer && this.keeperRemoved) ||
      (name === this.plan.names.network && this.networkRemoved) ||
      (name === this.plan.names.storageVolume && this.volumeRemoved)
    ) {
      throw new DockerCommandError(1, true);
    }
    if (name === this.plan.names.network) {
      return this.json({
        Name: name,
        Driver: "bridge",
        Internal: true,
        EnableIPv6: false,
        Attachable: false,
        Ingress: false,
        Labels: this.resourceLabels.get(name),
        Options: {
          "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
          "com.docker.network.bridge.gateway_mode_ipv6": "isolated",
        },
      });
    }
    if (name === this.plan.names.storageVolume) {
      return this.json({
        Name: name,
        Driver: "local",
        Labels: this.resourceLabels.get(name),
        Options: {
          type: "tmpfs",
          device: "tmpfs",
          o: "size=512m,nr_inodes=131072,uid=10001,gid=10001,mode=0700,nosuid,nodev",
        },
      });
    }
    if (name === this.plan.names.keeperContainer) return this.json(this.keeperInspection());
    if (name === this.plan.names.workerContainer) return this.json(this.workerInspection());
    if (name === this.plan.names.toolContainer) return this.json(this.toolInspection());
    if (name === this.proxy) {
      return this.json({
        NetworkSettings: {
          Networks: this.proxyConnected
            ? {
                bridge: { Gateway: "172.17.0.1" },
                [this.plan.names.network]: { Aliases: ["wardby-proxy"], Gateway: "" },
              }
            : { bridge: { Gateway: "172.17.0.1" } },
        },
      });
    }
    throw new DockerCommandError(1, true);
  }

  private keeperInspection(): object {
    return {
      Config: { User: "10001:10001", Image: image, Labels: this.resourceLabels.get(this.plan.names.keeperContainer) },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Privileged: false,
        Binds: null,
        CapAdd: null,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
        PidsLimit: 32,
        RestartPolicy: { Name: "no" },
        Mounts: [
          {
            Type: "volume",
            Source: this.plan.names.storageVolume,
            Target: WORKER_PATHS.storage,
            VolumeOptions: { NoCopy: true },
          },
        ],
      },
      Mounts: [{ Type: "volume", Name: this.plan.names.storageVolume, Destination: WORKER_PATHS.storage, RW: true }],
      NetworkSettings: { Networks: { none: {} } },
    };
  }

  protected workerInspection(): object {
    const mounts =
      this.job.provider === "claude-code"
        ? [
            [WORKER_PATHS.input, false, "input"],
            [WORKER_PATHS.output, true, "output"],
            [WORKER_PATHS.tool, true, "tool"],
          ]
        : [
            [WORKER_PATHS.workspace, true, "workspace"],
            [WORKER_PATHS.input, false, "input"],
            [WORKER_PATHS.output, true, "output"],
          ];
    const toolMemoryMb = Math.min(512, Math.max(128, Math.floor(this.job.limits.memoryMb / 3)));
    const agentLimits =
      this.job.provider === "claude-code"
        ? {
            cpus: this.job.limits.cpus - 0.25,
            memoryMb: this.job.limits.memoryMb - toolMemoryMb,
            pids: this.job.limits.pids - 64,
          }
        : this.job.limits;
    return {
      Config: {
        User: "10001:10001",
        Image: this.job.image,
        Env: ["WARDBY_PROXY_URL=http://wardby-proxy:8787", `WARDBY_RUN_CAPABILITY=${capability}`],
        Labels: this.resourceLabels.get(this.plan.names.workerContainer),
      },
      HostConfig: {
        ReadonlyRootfs: true,
        Privileged: false,
        Binds: null,
        CapAdd: null,
        CapDrop: ["ALL"],
        CgroupnsMode: "private",
        IpcMode: "none",
        Init: true,
        Memory: agentLimits.memoryMb * 1024 * 1024,
        MemorySwap: agentLimits.memoryMb * 1024 * 1024,
        MemorySwappiness: 0,
        PidsLimit: agentLimits.pids,
        NanoCpus: Math.round(agentLimits.cpus * 1_000_000_000),
        ShmSize: 16 * 1024 * 1024,
        NetworkMode: this.plan.names.network,
        PidMode: "",
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "2" } },
        SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
        Devices: [],
        DeviceRequests: null,
        Dns: [],
        DnsOptions: [],
        DnsSearch: [],
        ExtraHosts: null,
        GroupAdd: null,
        PortBindings: {},
        PublishAllPorts: false,
        Tmpfs: { "/tmp": "rw,noexec", "/home/wardby": "rw,noexec" },
        Mounts: mounts.map(([target, readOnly, subpath]) => ({
          Type: "volume",
          Source: this.plan.names.storageVolume,
          Target: target,
          ReadOnly: !readOnly,
          VolumeOptions: { NoCopy: true, Subpath: subpath },
        })),
      },
      Mounts: mounts.map(([Destination, RW]) => ({
        Type: "volume",
        Name: this.plan.names.storageVolume,
        Destination,
        RW,
      })),
      NetworkSettings: { Networks: { [this.plan.names.network]: {} }, Ports: {} },
      State: {
        Running: this.workerState.running,
        Status: this.workerState.status,
        ExitCode: this.workerState.exitCode,
        OOMKilled: this.workerState.oomKilled,
      },
    };
  }

  protected toolInspection(): object {
    const mounts = [
      [WORKER_PATHS.workspace, true, "workspace"],
      [WORKER_PATHS.tool, true, "tool"],
    ];
    const memoryMb = Math.min(512, Math.max(128, Math.floor(this.job.limits.memoryMb / 3)));
    return {
      Config: {
        User: "10001:10001",
        Image: this.job.toolImage,
        Env: [`WARDBY_TOOL_SETUP=${claudeToolSetup(this.job, capability)}`],
        Labels: this.resourceLabels.get(this.plan.names.toolContainer),
      },
      HostConfig: {
        ReadonlyRootfs: true,
        Privileged: false,
        Binds: null,
        CapAdd: null,
        CapDrop: ["ALL"],
        CgroupnsMode: "private",
        IpcMode: "none",
        Init: true,
        Memory: memoryMb * 1024 * 1024,
        MemorySwap: memoryMb * 1024 * 1024,
        MemorySwappiness: 0,
        PidsLimit: 64,
        NanoCpus: 250_000_000,
        ShmSize: 16 * 1024 * 1024,
        NetworkMode: this.plan.names.network,
        PidMode: "",
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "2" } },
        SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
        Devices: [],
        DeviceRequests: null,
        Dns: [],
        DnsOptions: [],
        DnsSearch: [],
        ExtraHosts: null,
        GroupAdd: null,
        PortBindings: {},
        PublishAllPorts: false,
        Tmpfs: { "/tmp": "rw,noexec", "/home/wardby": "rw,noexec" },
        Mounts: mounts.map(([target, writable, subpath]) => ({
          Type: "volume",
          Source: this.plan.names.storageVolume,
          Target: target,
          ReadOnly: !writable,
          VolumeOptions: { NoCopy: true, Subpath: subpath },
        })),
      },
      Mounts: mounts.map(([Destination, RW]) => ({
        Type: "volume",
        Name: this.plan.names.storageVolume,
        Destination,
        RW,
      })),
      NetworkSettings: { Networks: { [this.plan.names.network]: {} }, Ports: {} },
      State: {
        Running: this.toolState.running,
        Status: this.toolState.status,
      },
    };
  }

  protected ok(): DockerCommandResult {
    return { stdout: "", stderr: "" };
  }
  protected json(value: object): DockerCommandResult {
    return { stdout: JSON.stringify([value]), stderr: "" };
  }
}

async function harness(runId = "docker-run-1", override: Partial<JobSpec> = {}) {
  const root = await mkdtemp(join(tmpdir(), "wardby-docker-job-"));
  temporaryRoots.push(root);
  const job = { ...spec(runId), ...override };
  const runRoot = join(root, "workspaces", runId);
  await Promise.all([
    mkdir(join(runRoot, "workspace"), { recursive: true }),
    mkdir(join(runRoot, "git"), { recursive: true }),
  ]);
  job.inputArtifact = join(root, "input.json");
  await writeFile(job.inputArtifact, "{}", { mode: 0o600 });
  const docker = new FakeDocker(job);
  const transfer = new NoopTransfer();
  const launcher = new DockerJobLauncher({
    stateRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    proxyContainer: "trusted-proxy",
    resolveCapability: async () => capability,
    isRunActive: async () => false,
    docker,
    transfer,
  });
  return { launcher, docker, spec: job, transfer, runRoot, root };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

jobLauncherContract("Docker", async () => {
  const created = await harness();
  return {
    ...created,
    finish: async (_handle: JobHandle, _result?: JobResult) => created.docker.finish(),
    lose: async (_handle: JobHandle) => created.docker.lose(),
  };
});

describe("DockerJobLauncher", () => {
  it("observes provisioning failures before cleaning up the keeper", async () => {
    const created = await harness("docker-provision-failure");
    const observations: Array<{ runId: string; keeperContainer: string }> = [];
    const launcher = new DockerJobLauncher({
      stateRoot: join(created.root, "failure-state"),
      workspaceRoot: join(created.root, "workspaces"),
      proxyContainer: "trusted-proxy",
      resolveCapability: async () => capability,
      isRunActive: async () => false,
      docker: created.docker,
      transfer: new FailingSeedTransfer(),
      onProvisionFailure: async (context) => {
        observations.push(context);
      },
    });

    await expect(launcher.launch(created.spec)).rejects.toThrow("seed_failed");
    expect(observations).toEqual([
      { runId: created.spec.runId, keeperContainer: created.docker.plan.names.keeperContainer },
    ]);
  });

  it("materializes only a succeeded job into its exact trusted workspace", async () => {
    const created = await harness("docker-materialize");
    const handle = await created.launcher.launch(created.spec);
    await expect(created.launcher.materializeWorkspace(handle, join(created.runRoot, "other"))).rejects.toThrow(
      "job_not_succeeded",
    );
    created.docker.finish();
    await expect(created.launcher.materializeWorkspace(handle, join(created.runRoot, "other"))).rejects.toThrow(
      "docker_workspace_destination_invalid",
    );
    await created.launcher.materializeWorkspace(handle, join(created.runRoot, "workspace"));
    expect(created.transfer.materializations).toBe(1);
  });

  it("passes the job's collection exclusions to the workspace transfer", async () => {
    const created = await harness("docker-collect-exclude", {
      collectExclude: collectExclusions(["web/dist"]),
    });
    const handle = await created.launcher.launch(created.spec);
    created.docker.finish();
    await created.launcher.materializeWorkspace(handle, join(created.runRoot, "workspace"));
    expect(created.transfer.exclusions).toEqual([collectExclusions(["web/dist"])]);
  });

  it("adds trusted resource labels without forwarding caller labels or artifacts", async () => {
    const { launcher, docker, spec: job } = await harness("docker-labels");
    await launcher.launch(job);
    const encoded = JSON.stringify(docker.calls.map((call) => call.args));
    expect(encoded).not.toContain("must-not-reach-docker");
    expect(encoded).not.toContain(job.inputArtifact);
    expect(encoded).toContain(
      `io.wardby.spec-sha256=${createHash("sha256")
        .update(JSON.stringify({ ...job, labels: { untrusted: "must-not-reach-docker" } }))
        .digest("hex")}`,
    );
  });

  it("marks a timed-out job as a stable terminal failure", async () => {
    const created = await harness("docker-timeout");
    let now = 1_000;
    const launcher = new DockerJobLauncher({
      stateRoot: join(temporaryRoots.at(-1)!, "timed-state"),
      workspaceRoot: join(temporaryRoots.at(-1)!, "workspaces"),
      proxyContainer: "trusted-proxy",
      resolveCapability: async () => capability,
      isRunActive: async () => false,
      docker: created.docker,
      transfer: new NoopTransfer(),
      now: () => now,
    });
    const handle = await launcher.launch(created.spec);
    now += created.spec.timeoutSec * 1_000;
    expect(await launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    expect(await launcher.collect(handle)).toEqual({ exitCode: 124, reason: "timed_out" });
  });

  it("treats Claude's agent and its run-network tool runner as one cleanup unit", async () => {
    const created = await harness("docker-claude", { provider: "claude-code", toolImage, limits: claudeLimits });
    const handle = await created.launcher.launch(created.spec);
    const createdContainers = created.docker.calls
      .filter((call) => call.args[0] === "container" && call.args[1] === "create")
      .map((call) => call.args[call.args.indexOf("--name") + 1]);
    expect(createdContainers).toEqual([
      created.docker.plan.names.keeperContainer,
      created.docker.plan.names.toolContainer,
      created.docker.plan.names.workerContainer,
    ]);
    expect(JSON.stringify(created.docker.calls)).not.toContain(`WARDBY_RUN_CAPABILITY=${capability}`);
    const toolCreate = created.docker.calls.find(
      (call) =>
        call.args[0] === "container" &&
        call.args[1] === "create" &&
        call.args.includes(created.docker.plan.names.toolContainer),
    )!;
    expect(Object.keys(toolCreate.options?.env ?? {})).toEqual(["WARDBY_TOOL_SETUP"]);
    expect(JSON.parse(toolCreate.options!.env!.WARDBY_TOOL_SETUP).schemaVersion).toBe(1);
    await expect(created.launcher.status(handle)).resolves.toEqual({ state: "running" });
    created.docker.finish();
    await expect(created.launcher.collect(handle)).resolves.toMatchObject({ reason: "completed" });
    await created.launcher.remove(handle);
    expect(created.docker.toolRemoved).toBe(true);
  });

  it("collects the worker's dependency cache report with its result", async () => {
    const created = await harness("docker-claude-depcache", {
      provider: "claude-code",
      toolImage,
      limits: claudeLimits,
    });
    const handle = await created.launcher.launch(created.spec);
    created.docker.finish();
    const finished = JSON.parse(created.docker.output);
    created.docker.output = JSON.stringify({
      ...finished,
      dependencyCache: { projects: [{ path: ".", result: "cold" }] },
    });
    const collected = await created.launcher.collect(handle);
    expect(JSON.parse(collected.resultArtifact!).dependencyCache).toEqual({
      projects: [{ path: ".", result: "cold" }],
    });
  });

  it("reads the session transcript from the keeper, bounded", async () => {
    const created = await harness("docker-transcript", { provider: "claude-code", toolImage, limits: claudeLimits });
    const handle = await created.launcher.launch(created.spec);
    created.docker.output = '{"a":1}\n';
    await expect(created.launcher.readTranscript(handle, 1024)).resolves.toBe('{"a":1}\n');
    expect(
      created.docker.calls.some((c) => c.args.join(" ").includes(":/run/wardby/storage/output/session.jsonl")),
    ).toBe(true);
    await expect(created.launcher.readTranscript(handle, 3)).rejects.toThrow("transcript_too_large");
  });

  it("returns undefined for a transcript when the copy fails", async () => {
    const created = await harness("docker-transcript-missing", {
      provider: "claude-code",
      toolImage,
      limits: claudeLimits,
    });
    const handle = await created.launcher.launch(created.spec);
    const run = created.docker.run.bind(created.docker);
    created.docker.run = async (args, options) => {
      if (args[0] === "container" && args[1] === "cp") throw new Error("no such file");
      return run(args, options);
    };
    await expect(created.launcher.readTranscript(handle, 1024)).resolves.toBeUndefined();
  });

  it("fails the composite job when the Claude tool runner exits", async () => {
    const created = await harness("docker-claude-tool-failure", {
      provider: "claude-code",
      toolImage,
      limits: claudeLimits,
    });
    const handle = await created.launcher.launch(created.spec);
    created.docker.failTool();
    await expect(created.launcher.status(handle)).resolves.toEqual({ state: "failed" });
    await expect(created.launcher.collect(handle)).resolves.toMatchObject({ diagnostic: "worker_tool_runner_failed" });
  });

  it("never looks for a network keeper in a Claude run without services", async () => {
    const created = await harness("docker-claude-no-netns", {
      provider: "claude-code",
      toolImage,
      limits: claudeLimits,
    });
    const handle = await created.launcher.launch(created.spec);
    await expect(created.launcher.status(handle)).resolves.toEqual({ state: "running" });
    const netns = created.docker.plan.names.networkKeeperContainer;
    expect(created.docker.calls.some((call) => call.args.includes(netns))).toBe(false);
  });

  it("never relaunches an ambiguous provisioning record", async () => {
    const created = await harness("docker-ambiguous", { provider: "claude-code", toolImage, limits: claudeLimits });
    const plan = created.docker.plan;
    const specHash = createHash("sha256")
      .update(JSON.stringify({ ...created.spec, labels: { untrusted: "must-not-reach-docker" } }))
      .digest("hex");
    const record = {
      schemaVersion: 1,
      runId: created.spec.runId,
      spec: created.spec,
      specHash,
      handle: { backend: "docker", id: plan.names.workerContainer },
      jobId: "job-ambiguous",
      createdAt: 0,
      deadlineAt: Date.now() + 60_000,
      capabilityHash: "irrelevant",
      phase: "provisioning",
    };
    const stateFile = `${createHash("sha256").update(created.spec.runId).digest("hex")}.json`;
    await mkdir(join(created.root, "ambiguous-state"), { recursive: true });
    await writeFile(join(created.root, "ambiguous-state", stateFile), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const recovered = new DockerJobLauncher({
      stateRoot: join(created.root, "ambiguous-state"),
      workspaceRoot: join(created.root, "workspaces"),
      proxyContainer: "trusted-proxy",
      resolveCapability: async () => capability,
      isRunActive: async () => false,
      docker: created.docker,
      transfer: new NoopTransfer(),
    });
    const handle = await recovered.launch(created.spec);
    expect(handle).toEqual(record.handle);
    expect(created.docker.calls.some((call) => call.args[0] === "container" && call.args[1] === "create")).toBe(false);
    await expect(recovered.status(handle)).resolves.toEqual({ state: "lost" });
  });

  it("does not crash the process when a stale record's startup cleanup hits an unrecognized docker error", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-docker-job-"));
    temporaryRoots.push(root);
    const stateRoot = join(root, "state");
    await mkdir(stateRoot, { recursive: true });
    const runId = "docker-stale-network";
    const job = spec(runId);
    const plan = buildDockerIsolationPlan(job, "trusted-proxy");
    const record = {
      schemaVersion: 1,
      runId,
      spec: job,
      specHash: "irrelevant-for-startup-sweep",
      handle: { backend: "docker", id: plan.names.workerContainer },
      jobId: "job-stale",
      createdAt: 0,
      deadlineAt: 0,
      capabilityHash: "irrelevant-for-startup-sweep",
      phase: "active",
    };
    const fileName = `${createHash("sha256").update(runId).digest("hex")}.json`;
    await writeFile(join(stateRoot, fileName), `${JSON.stringify(record)}\n`, { mode: 0o600 });

    // Mirrors real Docker: `network inspect` on a genuinely-missing network
    // replies "network <name> not found", not "no such network" — a wording
    // isMissingDockerResource doesn't recognize (confirmed live against the
    // Docker CLI). Container inspect for an already-gone container replies
    // "No such container: <name>", which the classifier does recognize.
    class StaleCleanupDocker implements DockerCommandRunner {
      async run(args: readonly string[]): Promise<DockerCommandResult> {
        const [group, action] = args;
        if (group === "container" && action === "inspect") throw new DockerCommandError(1, true);
        if (group === "network" && action === "disconnect") return { stdout: "", stderr: "" };
        if (group === "network" && action === "inspect") throw new DockerCommandError(1, false);
        throw new Error(`unexpected_docker_command:${args.join(" ")}`);
      }
    }

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      new DockerJobLauncher({
        stateRoot,
        workspaceRoot: join(root, "workspaces"),
        proxyContainer: "trusted-proxy",
        resolveCapability: async () => capability,
        isRunActive: async () => false,
        docker: new StaleCleanupDocker(),
        transfer: new NoopTransfer(),
      });
      // Startup runs real fs I/O (mkdir/readdir/readFile) ahead of the sweep,
      // which needs real macrotask ticks to settle, not just microtasks.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });
});

describe("Docker launcher parity for runs without services", () => {
  // Recorded before services existed on Docker. Never update these snapshots:
  // a run without services must issue exactly these Docker commands.
  const stable = (argument: string) => argument.replace(/^(io\.wardby\.(?:spec-sha256|job-id))=.*$/, "$1=<varies>");

  async function parityLauncher(runId: string) {
    const created = await harness(runId);
    const launcher = new DockerJobLauncher({
      stateRoot: join(created.root, "parity-state"),
      workspaceRoot: join(created.root, "workspaces"),
      proxyContainer: "trusted-proxy",
      resolveCapability: async () => capability,
      isRunActive: async () => false,
      docker: created.docker,
      transfer: new NoopTransfer(),
      now: () => 1_000,
    });
    return { ...created, launcher };
  }

  it("launches, observes, finishes and removes with the same commands", async () => {
    const created = await parityLauncher("docker-parity");
    const handle = await created.launcher.launch(created.spec);
    await created.launcher.status(handle);
    created.docker.finish();
    await created.launcher.status(handle);
    await created.launcher.remove(handle);
    expect(
      created.docker.calls.map((call) => ({ args: call.args.map(stable), options: call.options })),
    ).toMatchSnapshot();
  });

  it("stops and removes with the same commands", async () => {
    const created = await parityLauncher("docker-parity-stop");
    const handle = await created.launcher.launch(created.spec);
    await created.launcher.stop(handle);
    await created.launcher.remove(handle);
    expect(
      created.docker.calls.map((call) => ({ args: call.args.map(stable), options: call.options })),
    ).toMatchSnapshot();
  });
});

describe("Docker workspace validation", () => {
  it("rejects nested Git control paths, escaping symlinks, and oversized output", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-docker-output-"));
    temporaryRoots.push(root);
    await mkdir(join(root, ".git"));
    await expect(validateMaterializedWorkspace(root, 1024)).rejects.toThrow("docker_workspace_nested_repository");
    await rm(join(root, ".git"), { recursive: true });
    await symlink("/etc/passwd", join(root, "escape"));
    await expect(validateMaterializedWorkspace(root, 1024)).rejects.toThrow("docker_workspace_symlink_escape");
    await rm(join(root, "escape"));
    await writeFile(join(root, "large.txt"), "123456");
    await expect(validateMaterializedWorkspace(root, 5)).rejects.toThrow("docker_workspace_size_limit");
  });
});

describe("parseWorkerDiagnosticLine", () => {
  it("keeps the fixed error code and safe output issues", () => {
    expect(
      parseWorkerDiagnosticLine(
        JSON.stringify({ error: "coding_output_invalid", issues: ["tag:invalid_string", "$:unrecognized_keys"] }),
      ),
    ).toEqual({ diagnostic: "coding_output_invalid", diagnosticIssues: ["tag:invalid_string", "$:unrecognized_keys"] });
    expect(parseWorkerDiagnosticLine(JSON.stringify({ error: "coding_turn_failed" }))).toEqual({
      diagnostic: "coding_turn_failed",
    });
  });

  it("drops the whole issues list when any entry is not a safe path and code", () => {
    for (const issues of [
      ["tag:invalid_string", "summary:sk-live-SECRET"],
      ["tag:invalid_string", "Tag With Spaces:custom"],
      ["tag:invalid_string", 7],
      Array.from({ length: 9 }, () => "tag:invalid_string"),
      [],
      "tag:invalid_string",
    ]) {
      expect(parseWorkerDiagnosticLine(JSON.stringify({ error: "coding_output_invalid", issues }))).toEqual({
        diagnostic: "coding_output_invalid",
      });
    }
  });

  it("ignores lines that are not the fixed worker shape", () => {
    expect(parseWorkerDiagnosticLine("not json")).toBeUndefined();
    expect(parseWorkerDiagnosticLine("null")).toBeUndefined();
    expect(parseWorkerDiagnosticLine(JSON.stringify({ error: "provider said: sk-SECRET" }))).toBeUndefined();
    expect(parseWorkerDiagnosticLine(JSON.stringify({ issues: ["tag:invalid_string"] }))).toBeUndefined();
  });
});

const POSTGRES = resolvedFromDefinition(
  BUILTIN_CODING_SERVICES.find((service) => service.name === "postgres" && service.version === "16")!,
);
const NETWORK_KEEPER_ID = "f".repeat(64);

/** FakeDocker plus a network keeper and service containers with scriptable image and readiness behaviour. */
class ServicesFakeDocker extends FakeDocker {
  readonly present = new Set<string>();
  pullFails = false;
  readinessFailures = 0;
  serviceExitsOnStart = false;
  /** Docker refuses to create the service container. */
  serviceCreateFails = false;
  /** The service container disappears during its first probe. */
  serviceVanishesOnProbe = false;
  /** The service inspection shows a privileged container. */
  serviceDrifts = false;
  /** Overrides the tool runner's reported network mode (a Claude run's tool runner in the keeper's namespace). */
  toolNetworkMode = `container:${NETWORK_KEEPER_ID}`;
  /** How long a pull takes on the harness clock. */
  pullTakesMs = 0;
  /** The harness clock; pulls advance it. */
  clock = { now: Date.now() };
  readonly running = new Set<string>();
  readonly removed = new Set<string>();
  readonly netns: string;
  readonly serviceContainers: Map<string, ResolvedCodingService>;

  constructor(job: JobSpec) {
    super(job);
    this.netns = this.plan.names.networkKeeperContainer;
    this.serviceContainers = new Map(
      (job.services ?? []).map((service) => [dockerServiceContainerName(job.runId, service.name), service]),
    );
  }

  override async run(args: readonly string[], options?: DockerCommandOptions): Promise<DockerCommandResult> {
    const [group, action] = args;
    // Real Docker has no worker until it is created; cleanup of a failed launch must see "no such container".
    if (
      group === "container" &&
      action === "inspect" &&
      (args[2] === this.plan.names.workerContainer || args[2] === this.plan.names.toolContainer) &&
      !this.resourceLabels.has(args[2])
    ) {
      this.calls.push({ args, options });
      throw new DockerCommandError(1, true);
    }
    if (group === "image") {
      this.calls.push({ args, options });
      const image = args.at(-1)!;
      if (action === "inspect") {
        if (this.present.has(image)) return { stdout: "sha256:present\n", stderr: "" };
        throw new DockerCommandError(1, false);
      }
      if (action === "pull") {
        this.clock.now += this.pullTakesMs;
        if (this.pullFails) throw new DockerCommandError(1, false);
        this.present.add(image);
        return this.ok();
      }
    }
    if (group === "container" && action === "create" && this.serviceCreateFails) {
      const name = args[args.indexOf("--name") + 1];
      if (this.serviceContainers.has(name)) {
        this.calls.push({ args, options });
        throw new DockerCommandError(125, false);
      }
    }
    if (group === "container" && action !== "create") {
      const name = action === "exec" || action === "inspect" ? args[2] : args.at(-1)!;
      if (name === this.netns || this.serviceContainers.has(name)) {
        this.calls.push({ args, options });
        if (action === "start") {
          if (!(this.serviceContainers.has(name) && this.serviceExitsOnStart)) this.running.add(name);
          return this.ok();
        }
        if (action === "stop") {
          this.running.delete(name);
          return this.ok();
        }
        if (action === "rm") {
          this.running.delete(name);
          this.removed.add(name);
          return this.ok();
        }
        if (action === "exec") {
          if (this.serviceVanishesOnProbe) {
            this.removed.add(name);
            throw new DockerCommandError(1, false);
          }
          if (this.readinessFailures > 0) {
            this.readinessFailures -= 1;
            throw new DockerCommandError(1, false);
          }
          return this.ok();
        }
        if (action === "inspect") {
          if (this.removed.has(name) || !this.resourceLabels.has(name)) throw new DockerCommandError(1, true);
          return this.json(name === this.netns ? this.networkKeeperInspection() : this.serviceInspection(name));
        }
      }
    }
    return super.run(args, options);
  }

  protected override workerInspection(): object {
    // A Claude run's agent stays on the run network; only Codex's worker shares the keeper's namespace.
    if (this.job.provider === "claude-code") return super.workerInspection();
    const base = super.workerInspection() as { HostConfig: object };
    return {
      ...base,
      HostConfig: { ...base.HostConfig, NetworkMode: `container:${NETWORK_KEEPER_ID}` },
      NetworkSettings: { Networks: {}, Ports: {} },
    };
  }

  protected override toolInspection(): object {
    const base = super.toolInspection() as { HostConfig: object };
    return {
      ...base,
      HostConfig: { ...base.HostConfig, NetworkMode: this.toolNetworkMode },
      NetworkSettings: { Networks: {}, Ports: {} },
    };
  }

  private networkKeeperInspection(): object {
    const running = this.running.has(this.netns);
    return {
      Id: NETWORK_KEEPER_ID,
      Config: {
        User: "10001:10001",
        Image: this.job.image,
        Labels: this.resourceLabels.get(this.netns),
        Entrypoint: ["node"],
        Cmd: ["-e", NETWORK_KEEPER_SCRIPT],
      },
      HostConfig: {
        NetworkMode: this.plan.names.network,
        ReadonlyRootfs: true,
        Privileged: false,
        Binds: null,
        CapAdd: null,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
        CgroupnsMode: "private",
        IpcMode: "none",
        PidMode: "",
        Init: true,
        PidsLimit: 32,
        Memory: 64 * 1024 * 1024,
        MemorySwap: 64 * 1024 * 1024,
        MemorySwappiness: null,
        NanoCpus: 100_000_000,
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "2" } },
        Dns: [],
        DnsOptions: [],
        DnsSearch: [],
        ExtraHosts: null,
        PortBindings: {},
        PublishAllPorts: false,
      },
      Mounts: [],
      NetworkSettings: { Networks: { [this.plan.names.network]: {} }, Ports: {} },
      State: { Running: running, Status: running ? "running" : "created" },
    };
  }

  private serviceInspection(name: string): object {
    const service = this.serviceContainers.get(name)!;
    const memory = serviceMemoryMib(service) * 1024 * 1024;
    const running = this.running.has(name);
    return {
      Id: "e".repeat(64),
      Config: {
        User: "10001:10001",
        Image: service.image,
        Env: ["PATH=/usr/bin:/bin", ...Object.entries(service.serviceEnv).map(([key, value]) => `${key}=${value}`)],
        Labels: this.resourceLabels.get(name),
      },
      HostConfig: {
        NetworkMode: `container:${NETWORK_KEEPER_ID}`,
        ReadonlyRootfs: true,
        Privileged: false,
        Binds: null,
        CapAdd: null,
        CapDrop: ["ALL"],
        ...(this.serviceDrifts ? { Privileged: true } : {}),
        CgroupnsMode: "private",
        IpcMode: "private",
        PidMode: "",
        ShmSize: 64 * 1024 * 1024,
        Memory: memory,
        MemorySwap: memory,
        MemorySwappiness: 0,
        PidsLimit: 512,
        NanoCpus: service.resources.cpuMillicores * 1_000_000,
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "2" } },
        SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
        Devices: [],
        DeviceRequests: null,
        Dns: [],
        DnsOptions: [],
        DnsSearch: [],
        ExtraHosts: null,
        GroupAdd: null,
        PortBindings: {},
        PublishAllPorts: false,
        Tmpfs: serviceTmpfsOptions(service),
      },
      Mounts: [],
      NetworkSettings: { Networks: {}, Ports: {} },
      State: { Running: running, Status: running ? "running" : "exited" },
    };
  }
}

async function servicesHarness(
  runId: string,
  override: Partial<JobSpec> = {},
  options: Partial<DockerJobLauncherOptions> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wardby-docker-job-"));
  temporaryRoots.push(root);
  const job: JobSpec = { ...spec(runId), services: [POSTGRES], ...override };
  const runRoot = join(root, "workspaces", runId);
  await Promise.all([
    mkdir(join(runRoot, "workspace"), { recursive: true }),
    mkdir(join(runRoot, "git"), { recursive: true }),
  ]);
  job.inputArtifact = join(root, "input.json");
  await writeFile(job.inputArtifact, "{}", { mode: 0o600 });
  const docker = new ServicesFakeDocker(job);
  const sleeps: number[] = [];
  const launcher = new DockerJobLauncher({
    stateRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    proxyContainer: "trusted-proxy",
    resolveCapability: async () => capability,
    isRunActive: async () => false,
    docker,
    transfer: new NoopTransfer(),
    now: () => docker.clock.now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      docker.clock.now += milliseconds;
    },
    ...options,
  });
  return { launcher, docker, spec: job, sleeps, root };
}

function createdContainers(docker: FakeDocker): string[] {
  return docker.calls
    .filter((call) => call.args[0] === "container" && call.args[1] === "create")
    .map((call) => call.args[call.args.indexOf("--name") + 1]);
}

function commands(docker: FakeDocker, group: string, action: string): Array<readonly string[]> {
  return docker.calls.filter((call) => call.args[0] === group && call.args[1] === action).map((call) => call.args);
}

describe("Docker launcher with services", () => {
  it("starts services for Codex and Claude Code runs", async () => {
    const { launcher } = await harness("docker-supports-services");
    expect(launcher.supportsServicesFor("codex")).toBe(true);
    expect(launcher.supportsServicesFor("claude-code")).toBe(true);
  });

  it("starts the network keeper, then each service, then the worker in the keeper's namespace", async () => {
    const created = await servicesHarness("docker-services");
    created.docker.present.add(POSTGRES.image);
    const handle = await created.launcher.launch(created.spec);
    const service = dockerServiceContainerName(created.spec.runId, "postgres");
    const names = created.docker.plan.names;
    expect(createdContainers(created.docker)).toEqual([
      names.keeperContainer,
      names.networkKeeperContainer,
      service,
      names.workerContainer,
    ]);
    const workerCreate = commands(created.docker, "container", "create").at(-1)!;
    expect(workerCreate[workerCreate.indexOf("--network") + 1]).toBe(`container:${names.networkKeeperContainer}`);
    expect(commands(created.docker, "container", "exec")).toEqual([
      ["container", "exec", service, ...POSTGRES.readiness.command],
    ]);
    const probe = created.docker.calls.find((call) => call.args[1] === "exec" && call.args[2] === service);
    expect(probe?.options?.timeoutMs).toBe(POSTGRES.readiness.timeoutSeconds * 1_000);
    expect(commands(created.docker, "image", "pull")).toEqual([]);
    await expect(created.launcher.status(handle)).resolves.toEqual({ state: "running" });
  });

  it("pulls a service image only when it is missing, with a bound", async () => {
    const created = await servicesHarness("docker-services-pull");
    await created.launcher.launch(created.spec);
    expect(commands(created.docker, "image", "pull")).toEqual([["image", "pull", "--quiet", POSTGRES.image]]);
    const pull = created.docker.calls.find((call) => call.args[0] === "image" && call.args[1] === "pull");
    expect(pull?.options?.timeoutMs).toBe(300_000);
  });

  it("passes readiness after transient failures, waiting periodSeconds between probes", async () => {
    const created = await servicesHarness("docker-services-retry");
    created.docker.readinessFailures = 2;
    await created.launcher.launch(created.spec);
    expect(commands(created.docker, "container", "exec")).toHaveLength(3);
    expect(created.sleeps).toEqual([2_000, 2_000]);
  });

  describe("service state reporting", () => {
    function reporting() {
      const updates: ServiceStateUpdate[] = [];
      return { updates, onServiceState: async (update: ServiceStateUpdate) => void updates.push(update) };
    }

    it("reports pending, each probe attempt, then ready", async () => {
      const { updates, onServiceState } = reporting();
      const created = await servicesHarness("docker-services-report", {}, { onServiceState });
      created.docker.readinessFailures = 2;
      await created.launcher.launch(created.spec);
      const base = { runId: "docker-services-report", name: "postgres" };
      expect(updates).toEqual([
        { ...base, state: "pending" },
        { ...base, state: "probing", attempts: 0 },
        { ...base, state: "probing", attempts: 1 },
        { ...base, state: "probing", attempts: 2 },
        { ...base, state: "ready", attempts: 3 },
      ]);
    });

    it("reports probe_failed with the attempt count when readiness never passes", async () => {
      const { updates, onServiceState } = reporting();
      const created = await servicesHarness("docker-services-report-unready", {}, { onServiceState });
      created.docker.present.add(POSTGRES.image);
      created.docker.readinessFailures = Number.POSITIVE_INFINITY;
      await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
      expect(updates.at(-1)).toEqual({
        runId: "docker-services-report-unready",
        name: "postgres",
        state: "failed",
        reason: "probe_failed",
        attempts: POSTGRES.readiness.failureThreshold,
      });
    });

    it.each([
      [
        "exited",
        (docker: any) => {
          docker.present.add(POSTGRES.image);
          docker.serviceExitsOnStart = true;
        },
      ],
      [
        "image_unavailable",
        (docker: any) => {
          docker.pullFails = true;
        },
      ],
    ] as const)("reports failed with reason %s", async (reason, arrange) => {
      const { updates, onServiceState } = reporting();
      const created = await servicesHarness(`docker-services-report-${reason}`, {}, { onServiceState });
      arrange(created.docker);
      await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
      expect(updates.at(-1)).toMatchObject({ name: "postgres", state: "failed", reason });
    });

    it("reports timed_out when the start-up budget runs out while probing", async () => {
      const { updates, onServiceState } = reporting();
      const created = await servicesHarness(
        "docker-services-report-budget",
        {},
        { serviceReadyTimeoutMs: 5_000, onServiceState },
      );
      created.docker.present.add(POSTGRES.image);
      created.docker.readinessFailures = Number.POSITIVE_INFINITY;
      await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
      expect(updates.at(-1)).toMatchObject({ name: "postgres", state: "failed", reason: "timed_out" });
    });

    it("reports start_failed when Docker refuses to create the service", async () => {
      const { updates, onServiceState } = reporting();
      const created = await servicesHarness("docker-services-report-create", {}, { onServiceState });
      created.docker.present.add(POSTGRES.image);
      created.docker.serviceCreateFails = true;
      await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
      expect(updates.at(-1)).toMatchObject({ name: "postgres", state: "failed", reason: "start_failed" });
    });

    it("a throwing reporter does not mask the original launch failure", async () => {
      const created = await servicesHarness(
        "docker-services-report-throws-failed",
        {},
        {
          onServiceState: async () => {
            throw new Error("db down");
          },
        },
      );
      created.docker.pullFails = true;
      await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
    });

    it("a throwing reporter never fails the launch", async () => {
      const created = await servicesHarness(
        "docker-services-report-throws",
        {},
        {
          onServiceState: async () => {
            throw new Error("db down");
          },
        },
      );
      await expect(created.launcher.launch(created.spec)).resolves.toBeDefined();
    });
  });

  it("fails the launch as coding_service_unready after failureThreshold probes and never creates the worker", async () => {
    const created = await servicesHarness("docker-services-unready");
    created.docker.present.add(POSTGRES.image);
    created.docker.readinessFailures = Number.POSITIVE_INFINITY;
    const error = await created.launcher.launch(created.spec).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("coding_service_unready:postgres");
    // Probe output never surfaces: the probe path's error carries no cause at all.
    expect((error as Error).cause).toBeUndefined();
    expect(commands(created.docker, "container", "exec")).toHaveLength(POSTGRES.readiness.failureThreshold);
    expect(created.sleeps).toHaveLength(POSTGRES.readiness.failureThreshold - 1);
    expect(createdContainers(created.docker)).not.toContain(created.docker.plan.names.workerContainer);
  });

  it("fails at once, as coding_service_unready, when a service exits", async () => {
    const created = await servicesHarness("docker-services-exit");
    created.docker.present.add(POSTGRES.image);
    created.docker.serviceExitsOnStart = true;
    await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
    expect(commands(created.docker, "container", "exec")).toEqual([]);
  });

  it("fails as coding_service_unready when the image can't be pulled", async () => {
    const created = await servicesHarness("docker-services-pull-failure");
    created.docker.pullFails = true;
    await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
    expect(createdContainers(created.docker)).not.toContain(dockerServiceContainerName(created.spec.runId, "postgres"));
  });

  it("fails as coding_service_unready when the start-up budget runs out, clipping probes and waits to it", async () => {
    const created = await servicesHarness("docker-services-budget", {}, { serviceReadyTimeoutMs: 5_000 });
    created.docker.present.add(POSTGRES.image);
    created.docker.readinessFailures = Number.POSITIVE_INFINITY;
    await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
    // failureThreshold (30) would allow far longer; the 5 s budget stops it after three probes.
    expect(created.sleeps).toEqual([2_000, 2_000, 1_000]);
    const probes = created.docker.calls.filter((call) => call.args[1] === "exec");
    expect(probes.map((call) => call.options?.timeoutMs)).toEqual([2_000, 2_000, 1_000]);
    expect(createdContainers(created.docker)).not.toContain(created.docker.plan.names.workerContainer);
    expect(created.docker.removed).toEqual(
      new Set([
        dockerServiceContainerName(created.spec.runId, "postgres"),
        created.docker.plan.names.networkKeeperContainer,
      ]),
    );
  });

  it("stops service start-up at the run's deadline when that comes before the budget", async () => {
    const created = await servicesHarness("docker-services-deadline", { timeoutSec: 3 });
    created.docker.present.add(POSTGRES.image);
    created.docker.readinessFailures = Number.POSITIVE_INFINITY;
    await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
    expect(created.sleeps).toEqual([2_000, 1_000]);
  });

  it("doesn't count an image pull against the budget, but bounds it by the run's deadline", async () => {
    const created = await servicesHarness(
      "docker-services-pull-budget",
      { timeoutSec: 600 },
      {
        serviceReadyTimeoutMs: 5_000,
      },
    );
    created.docker.pullTakesMs = 60_000;
    created.docker.readinessFailures = 1;
    await created.launcher.launch(created.spec);
    expect(created.sleeps).toEqual([2_000]);
    const pull = created.docker.calls.find((call) => call.args[0] === "image" && call.args[1] === "pull");
    expect(pull?.options?.timeoutMs).toBe(300_000);

    const short = await servicesHarness("docker-services-pull-deadline", { timeoutSec: 60 });
    await short.launcher.launch(short.spec);
    const clipped = short.docker.calls.find((call) => call.args[0] === "image" && call.args[1] === "pull");
    expect(clipped?.options?.timeoutMs).toBe(60_000);
  });

  it("fails as coding_service_unready, without a cause, when a service vanishes between probes", async () => {
    const created = await servicesHarness("docker-services-vanish");
    created.docker.present.add(POSTGRES.image);
    created.docker.serviceVanishesOnProbe = true;
    const error = await created.launcher.launch(created.spec).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("coding_service_unready:postgres");
    expect((error as Error).cause).toBeUndefined();
    expect(commands(created.docker, "container", "exec")).toHaveLength(1);
  });

  it("fails as coding_service_unready when Docker refuses to create a service, with the create failure as the cause", async () => {
    const created = await servicesHarness("docker-services-create-failure");
    created.docker.present.add(POSTGRES.image);
    created.docker.serviceCreateFails = true;
    const error = await created.launcher.launch(created.spec).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("coding_service_unready:postgres");
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(DockerCommandError);
    // The create call fails with exit code 125; the follow-up inspect's "not found" (exit
    // code 1, notFound) must not paper over it as the cause.
    expect((cause as DockerCommandError).exitCode).toBe(125);
    expect((cause as DockerCommandError).notFound).toBe(false);
    expect(createdContainers(created.docker)).not.toContain(created.docker.plan.names.workerContainer);
  });

  it("keeps a service attestation failure an isolation error, never coding_service_unready", async () => {
    const created = await servicesHarness("docker-services-drift");
    created.docker.present.add(POSTGRES.image);
    created.docker.serviceDrifts = true;
    await expect(created.launcher.launch(created.spec)).rejects.toThrow("docker_isolation_unsupported");
    expect(commands(created.docker, "container", "start").map((args) => args.at(-1))).not.toContain(
      dockerServiceContainerName(created.spec.runId, "postgres"),
    );
  });

  it("puts serviceEnv only in the service's own create arguments", async () => {
    const created = await servicesHarness("docker-services-env");
    await created.launcher.launch(created.spec);
    const carrying = created.docker.calls.filter((call) => JSON.stringify(call).includes("POSTGRES_PASSWORD"));
    expect(carrying.map((call) => call.args.slice(0, 4))).toEqual([
      ["container", "create", "--name", dockerServiceContainerName(created.spec.runId, "postgres")],
    ]);
  });

  const claudeRun = { provider: "claude-code", toolImage, limits: claudeLimits } as const;

  it("starts a Claude run's services before its tool runner, which joins the keeper's namespace, and keeps the agent on the run network", async () => {
    const created = await servicesHarness("docker-services-claude", claudeRun);
    created.docker.present.add(POSTGRES.image);
    const handle = await created.launcher.launch(created.spec);
    const names = created.docker.plan.names;
    const service = dockerServiceContainerName(created.spec.runId, "postgres");
    expect(createdContainers(created.docker)).toEqual([
      names.keeperContainer,
      names.networkKeeperContainer,
      service,
      names.toolContainer,
      names.workerContainer,
    ]);
    const creates = commands(created.docker, "container", "create");
    const toolCreate = creates.find((args) => args.includes(names.toolContainer))!;
    const agentCreate = creates.find((args) => args.includes(names.workerContainer))!;
    expect(toolCreate[toolCreate.indexOf("--network") + 1]).toBe(`container:${names.networkKeeperContainer}`);
    expect(agentCreate[agentCreate.indexOf("--network") + 1]).toBe(names.network);
    // The tool runner starts only after the service's readiness probe passed.
    const sequence = created.docker.calls.map((call) => call.args);
    const probed = sequence.findIndex((args) => args[1] === "exec" && args[2] === service);
    const toolStarted = sequence.findIndex((args) => args[1] === "start" && args.at(-1) === names.toolContainer);
    expect(probed).toBeGreaterThanOrEqual(0);
    expect(toolStarted).toBeGreaterThan(probed);
    await expect(created.launcher.status(handle)).resolves.toEqual({ state: "running" });
  });

  it("gives a Claude run's tool runner the services' test variables only through its setup, never in arguments", async () => {
    const created = await servicesHarness("docker-services-claude-env", claudeRun);
    await created.launcher.launch(created.spec);
    const names = created.docker.plan.names;
    const carrying = created.docker.calls.filter((call) => JSON.stringify(call).includes("DATABASE_URL"));
    expect(carrying.map((call) => call.args.slice(0, 4))).toEqual([
      ["container", "create", "--name", names.toolContainer],
    ]);
    expect(JSON.stringify(carrying[0].args)).not.toContain("DATABASE_URL");
    const setup = JSON.parse(carrying[0].options!.env!.WARDBY_TOOL_SETUP) as { env: Record<string, string> };
    expect(setup.env).toMatchObject(POSTGRES.testEnv);
    // serviceEnv still reaches only the service's own create arguments.
    const serviceCarrying = created.docker.calls.filter((call) => JSON.stringify(call).includes("POSTGRES_PASSWORD"));
    expect(serviceCarrying.map((call) => call.args.slice(0, 4))).toEqual([
      ["container", "create", "--name", dockerServiceContainerName(created.spec.runId, "postgres")],
    ]);
  });

  it("never creates a Claude run's tool runner or agent when a service never becomes ready", async () => {
    const created = await servicesHarness("docker-services-claude-unready", claudeRun);
    created.docker.present.add(POSTGRES.image);
    created.docker.readinessFailures = Number.POSITIVE_INFINITY;
    await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
    const names = created.docker.plan.names;
    expect(createdContainers(created.docker)).not.toContain(names.toolContainer);
    expect(createdContainers(created.docker)).not.toContain(names.workerContainer);
    expect(created.docker.removed).toEqual(
      new Set([dockerServiceContainerName(created.spec.runId, "postgres"), names.networkKeeperContainer]),
    );
  });

  it("re-attests a Claude run's tool runner against the network keeper on every status", async () => {
    const created = await servicesHarness("docker-services-claude-drift", claudeRun);
    const handle = await created.launcher.launch(created.spec);
    await expect(created.launcher.status(handle)).resolves.toEqual({ state: "running" });
    created.docker.toolNetworkMode = `container:${"0".repeat(64)}`;
    await expect(created.launcher.status(handle)).rejects.toThrow("docker_isolation_unsupported");
  });

  it("removes a Claude run's tool runner before its services and the network keeper", async () => {
    const created = await servicesHarness("docker-services-claude-remove", claudeRun);
    const handle = await created.launcher.launch(created.spec);
    created.docker.finish();
    await expect(created.launcher.status(handle)).resolves.toEqual({ state: "succeeded" });
    await created.launcher.remove(handle);
    const names = created.docker.plan.names;
    const service = dockerServiceContainerName(created.spec.runId, "postgres");
    expect(commands(created.docker, "container", "rm").map((args) => args.slice(2))).toEqual([
      ["--force", names.workerContainer],
      ["--force", names.toolContainer],
      ["--force", "--volumes", service],
      ["--force", names.networkKeeperContainer],
      ["--force", names.keeperContainer],
    ]);
  });

  it("stops a Claude run's agent, tool runner and services when the run is stopped", async () => {
    const created = await servicesHarness("docker-services-claude-stop", claudeRun);
    const handle = await created.launcher.launch(created.spec);
    await created.launcher.stop(handle);
    const names = created.docker.plan.names;
    const service = dockerServiceContainerName(created.spec.runId, "postgres");
    expect(commands(created.docker, "container", "stop").map((args) => args.at(-1))).toEqual([
      names.workerContainer,
      names.toolContainer,
      service,
    ]);
  });

  it("removes services and the network keeper with the run's other resources, in namespace order", async () => {
    const created = await servicesHarness("docker-services-remove");
    const handle = await created.launcher.launch(created.spec);
    created.docker.finish();
    await expect(created.launcher.status(handle)).resolves.toEqual({ state: "succeeded" });
    await created.launcher.remove(handle);
    const names = created.docker.plan.names;
    const service = dockerServiceContainerName(created.spec.runId, "postgres");
    expect(commands(created.docker, "container", "rm").map((args) => args.slice(2))).toEqual([
      ["--force", names.workerContainer],
      ["--force", "--volumes", service],
      ["--force", names.networkKeeperContainer],
      ["--force", names.keeperContainer],
    ]);
    expect(created.docker.removed).toEqual(new Set([service, names.networkKeeperContainer]));
  });

  it("removes the services of a launch that failed readiness", async () => {
    const created = await servicesHarness("docker-services-unready-cleanup");
    created.docker.readinessFailures = Number.POSITIVE_INFINITY;
    await expect(created.launcher.launch(created.spec)).rejects.toThrow("coding_service_unready:postgres");
    expect(created.docker.removed).toEqual(
      new Set([
        dockerServiceContainerName(created.spec.runId, "postgres"),
        created.docker.plan.names.networkKeeperContainer,
      ]),
    );
  });

  it("stops the services when the run is stopped", async () => {
    const created = await servicesHarness("docker-services-stop");
    const handle = await created.launcher.launch(created.spec);
    await created.launcher.stop(handle);
    const service = dockerServiceContainerName(created.spec.runId, "postgres");
    expect(commands(created.docker, "container", "stop").map((args) => args.at(-1))).toEqual([
      created.docker.plan.names.workerContainer,
      service,
    ]);
    expect(created.docker.running.has(service)).toBe(false);
  });

  it("sweeps an expired run's services when the launcher restarts", async () => {
    const created = await servicesHarness("docker-services-sweep");
    const handle = await created.launcher.launch(created.spec);
    const restarted = new DockerJobLauncher({
      stateRoot: join(created.root, "state"),
      workspaceRoot: join(created.root, "workspaces"),
      proxyContainer: "trusted-proxy",
      resolveCapability: async () => capability,
      isRunActive: async () => false,
      docker: created.docker,
      transfer: new NoopTransfer(),
      now: () => Date.now() + 24 * 60 * 60 * 1_000,
    });
    await expect(restarted.status(handle)).rejects.toThrow("job_removed");
    expect(created.docker.removed).toEqual(
      new Set([
        dockerServiceContainerName(created.spec.runId, "postgres"),
        created.docker.plan.names.networkKeeperContainer,
      ]),
    );
  });
});

describe("NodeDockerCommandRunner timeouts", () => {
  it("kills a command that outlives its timeout", async () => {
    const runner = new NodeDockerCommandRunner({ dockerBinary: "sleep", homeDir: tmpdir() });
    const started = Date.now();
    await expect(runner.run(["5"], { timeoutMs: 100 })).rejects.toThrow(/^docker_command_failed:/);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
