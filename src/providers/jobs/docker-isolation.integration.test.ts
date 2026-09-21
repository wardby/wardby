import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertDockerHostSupportsIsolation,
  assertIsolationNetworkInspection,
  assertIsolationNetworkParticipants,
  assertKeeperContainerInspection,
  assertProxyContainerInspection,
  assertStorageVolumeInspection,
  assertWorkerContainerInspection,
  buildDockerIsolationPlan,
  type DockerContainerInspection,
  type DockerHostInfo,
} from "./docker-isolation.js";
import type { JobSpec } from "./types.js";

const execute = promisify(execFile);
const enabled = process.env.WARDBY_DOCKER_ISOLATION_TEST === "1";
const image = process.env.WARDBY_WORKER_IMAGE ?? "";
const token = `${process.pid}-${Date.now()}`;
const proxyContainer = `wardby-proxy-probe-${token}`;
const spec: JobSpec = {
  kind: "coding-agent",
  runId: `acceptance-${token}`,
  image,
  inputArtifact: "artifact://acceptance",
  timeoutSec: 3,
  limits: { cpus: 0.5, memoryMb: 128, pids: 32, diskMb: 64 },
  labels: {},
};
const plan = enabled && image ? buildDockerIsolationPlan(spec, proxyContainer) : undefined;
let currentWorker: string | undefined;
let seedDirectory: string | undefined;
let probeSequence = 0;
const workers = new Set<string>();

async function docker(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await execute("docker", args, {
      encoding: "utf8",
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const details = error as Error & { stderr?: string; stdout?: string };
    throw new Error([details.message, details.stderr, details.stdout].filter(Boolean).join("\n"), { cause: error });
  }
}

async function cleanup(args: string[]): Promise<void> {
  try {
    await docker(args);
  } catch {
    // Cleanup is deliberately idempotent for interrupted acceptance runs.
  }
}

async function waitForLog(container: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await docker(["container", "logs", container])).includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("container_readiness_timeout");
}

function probeCreateArgs(mode: string, name: string): string[] {
  const args = [...plan!.workerCreateArgs];
  args[args.indexOf("--name") + 1] = name;
  args.splice(args.length - 1, 0, "--entrypoint", "node");
  args.push("/opt/wardby/coding-worker/isolation-probe.js", mode);
  return args;
}

async function runProbe(
  mode: string,
): Promise<{ name: string; output: string; exitCode: number; inspection: DockerContainerInspection }> {
  const name = `${plan!.names.workerContainer}-${mode}-${probeSequence++}`;
  currentWorker = name;
  workers.add(name);
  await docker(probeCreateArgs(mode, name), { WARDBY_RUN_CAPABILITY: "rrp_acceptance_only" });
  const inspection = JSON.parse(await docker(["container", "inspect", name]))[0] as DockerContainerInspection;
  await docker(["container", "start", name]);
  const exitCode = Number(await docker(["container", "wait", name]));
  const output = await docker(["container", "logs", name]);
  return { name, output, exitCode, inspection };
}

async function removeCurrentWorker(): Promise<void> {
  if (!currentWorker) return;
  await cleanup(["container", "rm", "--force", currentWorker]);
  workers.delete(currentWorker);
  currentWorker = undefined;
}

describe.skipIf(!enabled || !image)("Docker isolation acceptance", () => {
  beforeAll(async () => {
    const info = JSON.parse(await docker(["info", "--format", "{{json .}}"]));
    assertDockerHostSupportsIsolation(info as DockerHostInfo);
    await docker(plan!.networkCreateArgs);
    await docker(plan!.storageVolumeCreateArgs);
    await docker(plan!.keeperCreateArgs);
    await docker(["container", "start", plan!.names.keeperContainer]);
    await waitForLog(plan!.names.keeperContainer, "wardby_storage_ready");
    seedDirectory = await mkdtemp(join(tmpdir(), "wardby-isolation-seed-"));
    await writeFile(join(seedDirectory, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(seedDirectory, "input.json"), "{}");
    await docker([
      "container",
      "cp",
      join(seedDirectory, "HEAD"),
      `${plan!.names.keeperContainer}:/run/wardby/storage/git/HEAD`,
    ]);
    await docker([
      "container",
      "cp",
      join(seedDirectory, "input.json"),
      `${plan!.names.keeperContainer}:/run/wardby/storage/input/input.json`,
    ]);

    await docker([
      "container",
      "create",
      "--name",
      proxyContainer,
      "--network",
      "bridge",
      "--entrypoint",
      "node",
      image,
      "-e",
      "require('node:http').createServer((_,r)=>r.end('ok')).listen(8787,'0.0.0.0')",
    ]);
    await docker(plan!.proxyNetworkConnectArgs);
    await docker(["container", "start", proxyContainer]);
  }, 30_000);

  afterAll(async () => {
    await removeCurrentWorker();
    for (const worker of workers) await cleanup(["container", "rm", "--force", worker]);
    await cleanup(["container", "rm", "--force", proxyContainer]);
    if (plan) {
      await cleanup(["container", "rm", "--force", plan.names.keeperContainer]);
      await cleanup(["network", "rm", plan.names.network]);
      await cleanup(["volume", "rm", plan.names.storageVolume]);
    }
    if (seedDirectory) await rm(seedDirectory, { recursive: true, force: true });
  }, 30_000);

  it("attests the effective network and worker configuration", async () => {
    const network = JSON.parse(await docker(["network", "inspect", plan!.names.network]))[0];
    assertIsolationNetworkInspection(network, spec.runId);
    assertIsolationNetworkParticipants(network, [proxyContainer]);
    const volume = JSON.parse(await docker(["volume", "inspect", plan!.names.storageVolume]))[0];
    assertStorageVolumeInspection(volume, spec);
    const keeper = JSON.parse(await docker(["container", "inspect", plan!.names.keeperContainer]))[0];
    assertKeeperContainerInspection(keeper, spec);
    const proxy = JSON.parse(await docker(["container", "inspect", proxyContainer]))[0];
    assertProxyContainerInspection(proxy, spec.runId);
    const result = await runProbe("baseline");
    assertWorkerContainerInspection(result.inspection, spec, "rrp_acceptance_only");
    expect(result.exitCode).toBe(0);
    await removeCurrentWorker();
  }, 30_000);

  it("denies host, daemon, filesystem, metadata, localhost, and public-network access", async () => {
    const result = await runProbe("baseline");
    const probe = JSON.parse(result.output);
    expect(probe).toMatchObject({
      uid: 10001,
      gid: 10001,
      noNewPrivs: "1",
      seccomp: "2",
      effectiveCapabilities: "0000000000000000",
      hasDefaultRoute: false,
      dockerSocketExists: false,
      hostPathExists: false,
      rawSocketCreated: false,
      writes: { workspace: true, git: false, input: false, output: true, root: false },
      connects: { proxy: true, localhost: false, metadata: false, publicInternet: false },
    });
    expect(probe.pidOne).toContain("docker-init");
    await removeCurrentWorker();
  }, 30_000);

  it("contains PID exhaustion to the job cgroup", async () => {
    const result = await runProbe("pids");
    const probe = JSON.parse(result.output);
    expect(result.exitCode).toBe(0);
    expect(probe.spawned).toBeLessThan(spec.limits.pids);
    expect(probe.failure).toMatch(/EAGAIN|error/);
    await removeCurrentWorker();
  }, 30_000);

  it("kills an over-time job without affecting the keeper or proxy", async () => {
    const name = `${plan!.names.workerContainer}-hang-${probeSequence++}`;
    currentWorker = name;
    workers.add(name);
    await docker(probeCreateArgs("hang", name), { WARDBY_RUN_CAPABILITY: "rrp_acceptance_only" });
    await docker(["container", "start", name]);
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, spec.timeoutSec * 1_000));
    await docker(["container", "stop", "--time", "1", name]);
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    expect(await docker(["container", "inspect", "--format", "{{.State.Running}}", name])).toBe("false");
    expect(await docker(["container", "inspect", "--format", "{{.State.Running}}", plan!.names.keeperContainer])).toBe(
      "true",
    );
    expect(await docker(["container", "inspect", "--format", "{{.State.Running}}", proxyContainer])).toBe("true");
    await removeCurrentWorker();
  }, 30_000);

  it("contains OOM termination to the worker", async () => {
    // Docker's OOMKilled field is not set reliably on every hosted runner, but
    // the daemon's own event stream records the kernel cgroup OOM decision.
    const since = Math.floor(Date.now() / 1_000) - 1;
    const result = await runProbe("oom");
    expect(result.exitCode).not.toBe(0);
    const workerId = await docker(["container", "inspect", "--format", "{{.Id}}", currentWorker!]);
    const oomKilled = await docker(["container", "inspect", "--format", "{{.State.OOMKilled}}", currentWorker!]);
    const events = await docker([
      "events",
      "--since",
      String(since),
      "--until",
      String(Math.ceil(Date.now() / 1_000) + 1),
      "--filter",
      "type=container",
      "--filter",
      `container=${workerId}`,
      "--filter",
      "event=oom",
      "--format",
      "{{.Action}}",
    ]);
    const oomEvent = events.split("\n").includes("oom");
    expect(oomEvent || oomKilled === "true", JSON.stringify({ exitCode: result.exitCode, oomKilled, events })).toBe(
      true,
    );
    await removeCurrentWorker();
  }, 30_000);

  it("enforces the shared workspace disk quota", async () => {
    const result = await runProbe("disk");
    const probe = JSON.parse(result.output);
    expect(result.exitCode).toBe(0);
    expect(probe.failure).toBe("ENOSPC");
    expect(probe.writtenMb).toBeLessThanOrEqual(spec.limits.diskMb);
    await removeCurrentWorker();
  }, 30_000);
});
