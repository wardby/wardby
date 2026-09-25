import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExclusions, type CollectExclusions } from "../../coding/collect-exclude.js";
import { jobLauncherContract } from "./contract-suite.js";
import {
  DockerCommandError,
  DockerJobLauncher,
  dockerTransferEnvironment,
  isMissingDockerResource,
  validateMaterializedWorkspace,
  type DockerArtifactTransfer,
  type DockerCommandOptions,
  type DockerCommandResult,
  type DockerCommandRunner,
  parseWorkerDiagnosticLine,
} from "./docker.js";
import { buildDockerIsolationPlan, WORKER_PATHS } from "./docker-isolation.js";
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
  private readonly resourceLabels = new Map<string, Record<string, string>>();
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
  private output = "";

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

  private workerInspection(): object {
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
            pids: this.job.limits.pids - 16,
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

  private toolInspection(): object {
    const mounts = [
      [WORKER_PATHS.workspace, true, "workspace"],
      [WORKER_PATHS.tool, true, "tool"],
    ];
    const memoryMb = Math.min(512, Math.max(128, Math.floor(this.job.limits.memoryMb / 3)));
    return {
      Config: {
        User: "10001:10001",
        Image: this.job.toolImage,
        Env: [],
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
        PidsLimit: 16,
        NanoCpus: 250_000_000,
        ShmSize: 16 * 1024 * 1024,
        NetworkMode: "none",
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
      NetworkSettings: { Networks: { none: {} }, Ports: {} },
      State: {
        Running: this.toolState.running,
        Status: this.toolState.status,
      },
    };
  }

  private ok(): DockerCommandResult {
    return { stdout: "", stderr: "" };
  }
  private json(value: object): DockerCommandResult {
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

  it("treats Claude's agent and no-network tool runner as one cleanup unit", async () => {
    const created = await harness("docker-claude", { provider: "claude-code", toolImage });
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
    await expect(created.launcher.status(handle)).resolves.toEqual({ state: "running" });
    created.docker.finish();
    await expect(created.launcher.collect(handle)).resolves.toMatchObject({ reason: "completed" });
    await created.launcher.remove(handle);
    expect(created.docker.toolRemoved).toBe(true);
  });

  it("fails the composite job when the Claude tool runner exits", async () => {
    const created = await harness("docker-claude-tool-failure", { provider: "claude-code", toolImage });
    const handle = await created.launcher.launch(created.spec);
    created.docker.failTool();
    await expect(created.launcher.status(handle)).resolves.toEqual({ state: "failed" });
    await expect(created.launcher.collect(handle)).resolves.toMatchObject({ diagnostic: "worker_tool_runner_failed" });
  });

  it("never relaunches an ambiguous provisioning record", async () => {
    const created = await harness("docker-ambiguous", { provider: "claude-code", toolImage });
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
