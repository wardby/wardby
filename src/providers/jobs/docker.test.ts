import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobLauncherContract } from "./contract-suite.js";
import {
  DockerCommandError,
  DockerJobLauncher,
  type DockerArtifactTransfer,
  type DockerCommandOptions,
  type DockerCommandResult,
  type DockerCommandRunner,
} from "./docker.js";
import { buildDockerIsolationPlan, WORKER_PATHS } from "./docker-isolation.js";
import type { JobHandle, JobResult, JobSpec } from "./types.js";

const image = `registry.example/reevo-worker@sha256:${"a".repeat(64)}`;
const capability = "rrp_0123456789abcdef";
const temporaryRoots: string[] = [];

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
  async seedDirectory(): Promise<void> {}
  async seedInput(): Promise<void> {}
}

class FakeDocker implements DockerCommandRunner {
  readonly plan: ReturnType<typeof buildDockerIsolationPlan>;
  readonly calls: { args: readonly string[]; options?: DockerCommandOptions }[] = [];
  private readonly resourceLabels = new Map<string, Record<string, string>>();
  private workerState: { status: string; running: boolean; exitCode?: number; oomKilled?: boolean } = {
    status: "created",
    running: false,
  };
  private keeperRemoved = false;
  private workerRemoved = false;
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
      this.resourceLabels.set(name, labels(args));
      return this.ok();
    }
    if (group === "network" && action === "connect") {
      this.proxyConnected = true;
      return this.ok();
    }
    if (group === "container" && action === "start") {
      if (target === this.plan.names.workerContainer) this.workerState = { status: "running", running: true };
      return this.ok();
    }
    if (group === "container" && action === "stop") {
      this.workerState = { status: "exited", running: false, exitCode: 143 };
      return this.ok();
    }
    if (group === "container" && action === "rm") {
      const name = args.at(-1)!;
      if (name === this.plan.names.workerContainer) this.workerRemoved = true;
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

  private inspect(name: string): DockerCommandResult {
    if (
      (name === this.plan.names.workerContainer && this.workerRemoved) ||
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
    if (name === this.proxy) {
      return this.json({
        NetworkSettings: {
          Networks: this.proxyConnected
            ? {
                bridge: { Gateway: "172.17.0.1" },
                [this.plan.names.network]: { Aliases: ["reevo-proxy"], Gateway: "" },
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
        PidsLimit: 16,
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
    const mounts = [
      [WORKER_PATHS.workspace, true, "workspace"],
      [WORKER_PATHS.git, false, "git"],
      [WORKER_PATHS.input, false, "input"],
      [WORKER_PATHS.output, true, "output"],
    ];
    return {
      Config: {
        User: "10001:10001",
        Image: image,
        Env: ["REEVO_PROXY_URL=http://reevo-proxy:8787", `REEVO_RUN_CAPABILITY=${capability}`],
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
        Memory: 1024 * 1024 * 1024,
        MemorySwap: 1024 * 1024 * 1024,
        PidsLimit: 64,
        NanoCpus: 1_500_000_000,
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
        Tmpfs: { "/tmp": "rw,noexec", "/home/reevo": "rw,noexec" },
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

  private ok(): DockerCommandResult {
    return { stdout: "", stderr: "" };
  }
  private json(value: object): DockerCommandResult {
    return { stdout: JSON.stringify([value]), stderr: "" };
  }
}

async function harness(runId = "docker-run-1") {
  const root = await mkdtemp(join(tmpdir(), "reevo-docker-job-"));
  temporaryRoots.push(root);
  const job = spec(runId);
  const runRoot = join(root, "workspaces", runId);
  await Promise.all([
    mkdir(join(runRoot, "workspace"), { recursive: true }),
    mkdir(join(runRoot, "git"), { recursive: true }),
  ]);
  job.inputArtifact = join(root, "input.json");
  await writeFile(job.inputArtifact, "{}", { mode: 0o600 });
  const docker = new FakeDocker(job);
  const launcher = new DockerJobLauncher({
    stateRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    proxyContainer: "trusted-proxy",
    resolveCapability: async () => capability,
    isRunActive: async () => false,
    docker,
    transfer: new NoopTransfer(),
  });
  return { launcher, docker, spec: job };
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
  it("adds trusted resource labels without forwarding caller labels or artifacts", async () => {
    const { launcher, docker, spec: job } = await harness("docker-labels");
    await launcher.launch(job);
    const encoded = JSON.stringify(docker.calls.map((call) => call.args));
    expect(encoded).not.toContain("must-not-reach-docker");
    expect(encoded).not.toContain(job.inputArtifact);
    expect(encoded).toContain(
      `io.reevo.spec-sha256=${createHash("sha256")
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
});
