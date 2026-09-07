import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { DockerJobLauncher } from "./docker.js";
import { isolationNames } from "./docker-isolation.js";
import type { JobSpec } from "./types.js";

const execute = promisify(execFile);
const enabled = process.env.REEVO_DOCKER_JOB_TEST === "1";
const image = process.env.REEVO_DOCKER_JOB_FIXTURE_IMAGE ?? "";
const runId = "docker-smoke";
const token = `${process.pid}-${Date.now()}`;
const proxy = `reevo-job-proxy-${token}`;
let root: string | undefined;

async function docker(args: string[]): Promise<string> {
  const result = await execute("docker", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

async function cleanup(args: string[]): Promise<void> {
  try {
    await docker(args);
  } catch {
    // Cleanup is deliberately idempotent for an interrupted Docker smoke test.
  }
}

describe.skipIf(!enabled || !image)("Docker JobLauncher smoke", () => {
  afterAll(async () => {
    const names = isolationNames(runId);
    await cleanup(["container", "rm", "--force", names.workerContainer]);
    await cleanup(["container", "rm", "--force", names.keeperContainer]);
    await cleanup(["network", "rm", names.network]);
    await cleanup(["volume", "rm", names.storageVolume]);
    await cleanup(["container", "rm", "--force", proxy]);
    if (root) await rm(root, { recursive: true, force: true });
  }, 30_000);

  it("launches, attests, collects a bounded result, and removes an isolated job", async () => {
    root = await mkdtemp(join(tmpdir(), "reevo-docker-job-"));
    const workspace = join(root, "workspaces", runId, "workspace");
    const git = join(root, "workspaces", runId, "git");
    const input = join(root, "input.json");
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(git, { recursive: true })]);
    await Promise.all([
      writeFile(join(workspace, "README.md"), "fixture\n"),
      writeFile(join(git, "HEAD"), "ref: refs/heads/main\n"),
      writeFile(input, "{}"),
    ]);
    await docker([
      "container",
      "create",
      "--name",
      proxy,
      "--network",
      "bridge",
      "--entrypoint",
      "node",
      image,
      "-e",
      "require('node:http').createServer((_,r)=>r.end('ok')).listen(8787,'0.0.0.0')",
    ]);
    await docker(["container", "start", proxy]);

    const launcher = new DockerJobLauncher({
      stateRoot: join(root, "state"),
      workspaceRoot: join(root, "workspaces"),
      proxyContainer: proxy,
      resolveCapability: async () => "rrp_0123456789abcdef",
      isRunActive: async () => false,
    });
    const spec: JobSpec = {
      kind: "coding-agent",
      runId,
      image,
      inputArtifact: input,
      timeoutSec: 30,
      limits: { cpus: 0.5, memoryMb: 128, pids: 32, diskMb: 64 },
      labels: { ignored: "not-a-docker-label" },
    };
    const handle = await launcher.launch(spec);
    let status = await launcher.status(handle);
    for (let attempt = 0; attempt < 50 && (status.state === "pending" || status.state === "running"); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      status = await launcher.status(handle);
    }
    expect(status).toEqual({ state: "succeeded" });
    expect(await launcher.collect(handle)).toEqual({
      exitCode: 0,
      reason: "completed",
      resultArtifact: JSON.stringify({ schemaVersion: 1, runId, outcome: "no_changes", summary: "fixture", tests: [] }),
    });
    await launcher.remove(handle);
    await expect(launcher.status(handle)).rejects.toThrow("job_removed");
  }, 30_000);
});
