import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobLauncherContract } from "../contract-suite.js";
import { hostTarArchive } from "../kubernetes.js";
import { JobCapacityError, type JobSpec } from "../types.js";
import { SubstrateUnavailableError, type WorkerInfo } from "./api.js";
import { CONFIG, FAKE_CAP, makeHarness, type Harness } from "./launcher.test-support.js";
import { BLOB, agentActorName, toolActorName } from "./names.js";

const BLOB_KINDS = ["input", "toolSetup", "seed", "result", "transcript", "workspace", "exit", "done"] as const;

async function blobKeys(h: Harness): Promise<string[]> {
  const present: string[] = [];
  for (const kind of BLOB_KINDS) if (await h.blobs.head(BLOB[kind](h.token))) present.push(kind);
  return present;
}

/** Writes the reported result (none for `null`) and the proxy's `done` marker. */
async function finish(h: Harness, result: unknown = h.output, workspace = "ok"): Promise<void> {
  if (result !== null) await h.blobs.put(BLOB.result(h.token), Buffer.from(JSON.stringify(result)));
  await h.blobs.put(BLOB.done(h.token), Buffer.from(JSON.stringify({ workspace })));
}

async function putWorkspaceTar(h: Harness, files: Record<string, string>): Promise<void> {
  const source = await mkdtemp(join(tmpdir(), "wardby-substrate-ws-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(source, name, ".."), { recursive: true });
    await writeFile(join(source, name), content);
  }
  const archive = hostTarArchive(source);
  await h.blobs.putStream(BLOB.workspace(h.token), archive.stream);
  expect(await archive.done).toBe(0);
}

jobLauncherContract("substrate", async () => {
  const h = await makeHarness();
  return {
    launcher: h.launcher,
    spec: h.spec,
    finish: async (handle, result) => {
      const t = handle.id.split("/")[1];
      await h.blobs.put(
        BLOB.result(t),
        Buffer.from(JSON.stringify(result?.resultArtifact ? JSON.parse(result.resultArtifact) : h.output)),
      );
      await h.blobs.put(BLOB.done(t), Buffer.from('{"workspace":"ok"}'));
    },
    lose: async (handle) => {
      await h.api.deleteActor("wardby-runs", `${handle.id.split("/")[1]}-agent`);
    },
  };
});

describe("SubstrateJobLauncher", () => {
  it("plans the handle from the run id", async () => {
    const h = await makeHarness();
    expect(h.launcher.plannedHandle(h.spec)).toEqual({ backend: "substrate", id: `wardby-runs/${h.token}` });
  });

  it("launches two running actors from two templates, with policies, a Secret and staged blobs", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    expect(handle).toEqual({ backend: "substrate", id: `wardby-runs/${h.token}` });
    expect(h.api.templates.size).toBe(2);
    expect([...h.api.actors.keys()].sort()).toEqual(
      [`wardby-runs/${agentActorName(h.token)}`, `wardby-runs/${toolActorName(h.token)}`].sort(),
    );
    expect([...h.api.actors.values()].every((actor) => actor.state === "RUNNING")).toBe(true);
    expect(h.api.egressPolicies.size).toBe(2);
    expect([...h.secrets.secrets.keys()]).toEqual([`${CONFIG.credentialsNamespace}/${h.token}`]);
    expect(await blobKeys(h)).toEqual(["input", "toolSetup", "seed"]);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");
    expect(await h.launcher.status(handle)).toEqual({ state: "running" });

    expect((await h.blobs.get(BLOB.input(h.token))).toString()).toBe(await readFile(h.spec.inputArtifact, "utf8"));
    const setup = JSON.parse((await h.blobs.get(BLOB.toolSetup(h.token))).toString()) as {
      toolSetup: string;
      collectExclude: { names: string[]; paths: string[] };
    };
    expect(JSON.parse(setup.toolSetup).schemaVersion).toBe(1);
    expect(setup.collectExclude.paths).toEqual([]);
    expect(setup.collectExclude.names.length).toBeGreaterThan(0);
    expect((await h.blobs.get(BLOB.seed(h.token))).toString("latin1")).toContain("# hello");
  });

  it("is idempotent for the same spec and refuses a different one", async () => {
    const h = await makeHarness();
    const first = await h.launcher.launch(h.spec);
    const created = h.secrets.calls.length;
    expect(await h.launcher.launch(structuredClone(h.spec))).toEqual(first);
    expect(h.secrets.calls.length).toBe(created);
    await expect(h.launcher.launch({ ...h.spec, timeoutSec: 601 })).rejects.toThrow("job_spec_conflict");
  });

  it("refuses for capacity, leaves nothing running, and provisions afresh on a later launch", async () => {
    const h = await makeHarness({ workers: 1 });
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("substrate_capacity: no worker has room");
    expect(h.api.actors.size).toBe(0);
    expect(h.api.egressPolicies.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect(await blobKeys(h)).toEqual([]);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("requeued");
    const handle = h.launcher.plannedHandle(h.spec)!;
    expect(await h.launcher.status(handle)).toEqual({ state: "pending", capacityRefused: true });

    // Room again later: the same spec provisions afresh, with a fresh deadline.
    (h.api as unknown as { options: { workers: number } }).options.workers = 2;
    h.setNow(5_000_000);
    expect(await h.launcher.launch(h.spec)).toEqual(handle);
    expect(h.api.actors.size).toBe(2);
    const record = await h.runs.get(h.spec.runId);
    expect(record?.phase).toBe("running");
    expect(record?.deadlineAt.getTime()).toBe(5_000_000 + 600_000);
  });

  it("succeeds on a reported result and collects the parsed artifact", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await expect(h.launcher.collect(handle)).rejects.toThrow("job_not_terminal");
    await h.blobs.put(BLOB.result(h.token), Buffer.from(JSON.stringify(h.output)));
    // A result without the tool's collect is still running.
    expect(await h.launcher.status(handle)).toEqual({ state: "running" });
    await h.blobs.put(BLOB.done(h.token), Buffer.from('{"workspace":"ok"}'));
    expect(await h.launcher.status(handle)).toEqual({ state: "succeeded" });
    const result = await h.launcher.collect(handle);
    expect(result).toEqual({ exitCode: 0, reason: "completed", resultArtifact: JSON.stringify(h.output) });
  });

  it("fails a run whose worker exited without a result, with the exit code", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await h.blobs.put(BLOB.exit(h.token), Buffer.from('{"code":3}'));
    // Collect still in flight.
    expect(await h.launcher.status(handle)).toEqual({ state: "running" });
    await finish(h, null);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "worker_exited" });
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 3,
      reason: "failed",
      diagnostic: "substrate_result_missing",
    });
  });

  it("fails a result for another run or one that does not parse", async () => {
    for (const result of [{ ...(await makeHarness()).output, runId: "someone-else" }, { nope: true }]) {
      const h = await makeHarness();
      const handle = await h.launcher.launch(h.spec);
      await finish(h, result);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "worker_exited" });
      expect(await h.launcher.collect(handle)).toEqual({
        exitCode: 1,
        reason: "failed",
        diagnostic: "substrate_result_missing",
      });
    }
  });

  it("fails a run whose workspace could not be collected", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await finish(h, h.output, "failed");
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "substrate_collect_failed" });
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "substrate_collect_failed",
    });
  });

  it("fails a crashed agent and keeps the outcome", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    h.api.setState("wardby-runs", agentActorName(h.token), "CRASHED");
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    // Terminal: the deadline passing later does not turn it into a timeout.
    h.setNow(10_000_000);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual({ exitCode: 1, reason: "failed" });
  });

  it("fails a crashed tool actor as a tool-runner failure", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    h.api.setState("wardby-runs", toolActorName(h.token), "CRASHED");
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "worker_tool_runner_failed",
    });
  });

  it("times out past the deadline, deletes the actors, and stays timed out", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    h.setNow(1_000_000 + 600_001);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    expect(h.api.actors.size).toBe(0);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    await h.launcher.stop(handle);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    expect(await h.launcher.collect(handle)).toEqual({ exitCode: 124, reason: "timed_out" });
  });

  it("removes actors, policies, Secret and blobs, keeps a tombstone and never relaunches", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await h.blobs.put(BLOB.transcript(h.token), Buffer.from("{}\n"));
    await h.blobs.put(BLOB.workspace(h.token), Buffer.from("tar"));
    await h.blobs.put(BLOB.exit(h.token), Buffer.from('{"code":0}'));
    await finish(h);
    await h.launcher.remove(handle);
    expect(h.api.actors.size).toBe(0);
    expect(h.api.egressPolicies.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect(await blobKeys(h)).toEqual([]);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("removed");
    // Same rule as every launcher's contract: the same spec gets its handle back, nothing is created.
    expect(await h.launcher.launch(structuredClone(h.spec))).toEqual(handle);
    expect(h.api.actors.size).toBe(0);
    await expect(h.launcher.status(handle)).rejects.toThrow("job_removed");
  });

  it("deletes the actors and records stopped on stop", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await h.launcher.stop(handle, "cancelled");
    expect(h.api.actors.size).toBe(0);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("stopped");
  });

  it("never puts the capability in a template, egress policy, seed or input", async () => {
    const h = await makeHarness();
    const logs: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    const writeOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = (chunk: string | Uint8Array) => (logs.push(String(chunk)), true);
    process.stdout.write = (chunk: string | Uint8Array) => (logs.push(String(chunk)), true);
    try {
      const handle = await h.launcher.launch(h.spec);
      await h.launcher.stop(handle);
      await h.launcher.remove(handle);
      const failing = await makeHarness({ workers: 1 });
      await failing.launcher.launch(failing.spec).catch(() => undefined);
    } finally {
      process.stderr.write = write;
      process.stdout.write = writeOut;
    }
    expect(logs.join("")).not.toContain(FAKE_CAP);

    const fresh = await makeHarness();
    await fresh.launcher.launch(fresh.spec);
    const shared = JSON.stringify([...fresh.api.templates.values(), ...fresh.api.egressPolicies.values()]);
    expect(shared).not.toContain(FAKE_CAP);
    expect(shared).not.toContain("rrg_");
    expect((await fresh.blobs.get(BLOB.seed(fresh.token))).toString("latin1")).not.toContain(FAKE_CAP);
    expect((await fresh.blobs.get(BLOB.input(fresh.token))).toString("latin1")).not.toContain(FAKE_CAP);
    // The Secret is the capability's only home.
    expect(fresh.secrets.secrets.get(`${CONFIG.credentialsNamespace}/${fresh.token}`)?.stringData).toEqual({
      capability: FAKE_CAP,
    });
  });

  it("keeps the capability out of a provisioning failure's error", async () => {
    const h = await makeHarness();
    h.api.putEgressPolicy = async () => {
      throw new SubstrateUnavailableError("substrate_unavailable");
    };
    const error = (await h.launcher.launch(h.spec).then(
      () => new Error("launched"),
      (e: unknown) => e,
    )) as Error;
    expect(error).toBeInstanceOf(SubstrateUnavailableError);
    expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(FAKE_CAP);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("provisioning_failed");
    expect(h.secrets.secrets.size).toBe(0);
    expect(await blobKeys(h)).toEqual([]);
    const handle = h.launcher.plannedHandle(h.spec)!;
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "substrate_provisioning_failed",
    });
  });

  it("rejects what Phase A does not support, before any side effect", async () => {
    const h = await makeHarness();
    const cases: [Partial<JobSpec>, string][] = [
      [{ provider: "codex" }, "substrate_provider_unsupported"],
      [{ provider: undefined }, "substrate_provider_unsupported"],
      [{ image: "registry.example/agent:latest" }, "substrate_image_not_digest"],
      [{ toolImage: "registry.example/tool:latest" }, "substrate_image_not_digest"],
      [{ services: [] }, "substrate_feature_unsupported:services"],
      [{ mcpTools: true }, "substrate_feature_unsupported:mcpTools"],
      [{ dependencyCache: true }, "substrate_feature_unsupported:dependencyCache"],
      [
        { repositories: [{ name: "lib", access: "read", hostPath: "/x" }] },
        "substrate_feature_unsupported:repositories",
      ],
    ];
    for (const [change, code] of cases) {
      await expect(h.launcher.launch({ ...h.spec, ...change })).rejects.toThrow(code);
      expect(h.launcher.plannedHandle({ ...h.spec, ...change })).toBeUndefined();
    }
    expect(await h.runs.get(h.spec.runId)).toBeUndefined();
    expect(h.api.templates.size).toBe(0);
    // Session resume is accepted.
    await expect(h.launcher.launch({ ...h.spec, sessionResume: true })).resolves.toBeDefined();
  });

  it("fails the launch when the workspace is larger than the disk limit", async () => {
    const h = await makeHarness();
    await writeFile(join(h.workspaceRoot, h.spec.runId, "workspace", "big.bin"), Buffer.alloc(65 * 1024 * 1024));
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("substrate_seed_too_large");
    expect(h.api.actors.size).toBe(0);
    expect(await blobKeys(h)).toEqual([]);
  });

  it("fails the launch when the input artifact is too large", async () => {
    const h = await makeHarness();
    await writeFile(h.spec.inputArtifact, Buffer.alloc(512 * 1024 + 1));
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("substrate_input_artifact_invalid");
  });

  it("materializes the collected workspace into the run's own folder only", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await putWorkspaceTar(h, { "README.md": "# changed\n", "src/a.ts": "export {};\n" });
    const destination = join(h.workspaceRoot, h.spec.runId, "workspace");
    await expect(h.launcher.materializeWorkspace(handle, destination)).rejects.toThrow("job_not_succeeded");
    await finish(h);
    await expect(h.launcher.materializeWorkspace(handle, join(h.workspaceRoot, "other"))).rejects.toThrow(
      "substrate_workspace_destination_invalid",
    );
    await expect(h.launcher.materializeWorkspace(handle, destination, "lib")).rejects.toThrow(
      "substrate_workspace_destination_invalid",
    );
    await h.launcher.materializeWorkspace(handle, destination);
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("# changed\n");
    expect(await readFile(join(destination, "src", "a.ts"), "utf8")).toBe("export {};\n");
  });

  it("reads the transcript within its bound", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    expect(await h.launcher.readTranscript(handle, 100)).toBeUndefined();
    await h.blobs.put(BLOB.transcript(h.token), Buffer.from('{"type":"x"}\n'));
    expect(await h.launcher.readTranscript(handle, 100)).toBe('{"type":"x"}\n');
    await expect(h.launcher.readTranscript(handle, 4)).rejects.toThrow("transcript_too_large");
  });

  it("checks capacity against the workers, and says yes when in doubt", async () => {
    const h = await makeHarness();
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
    const workers = (list: WorkerInfo[]) => {
      h.api.listWorkers = async () => list;
    };
    workers([{ pool: "p", freeCpuMillicores: 100, freeMemoryBytes: 2 ** 30 }]);
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(false);
    workers([{ pool: "p", freeCpuMillicores: 1000, freeMemoryBytes: 2 ** 30 }]);
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
    workers([]);
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(false);
    h.api.listWorkers = async () => {
      throw new SubstrateUnavailableError("substrate_unavailable");
    };
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
    expect(h.launcher.supportsServicesFor("claude-code")).toBe(false);
  });
});
