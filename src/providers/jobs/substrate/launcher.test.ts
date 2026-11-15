import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { logger, setLogLineFilter } from "../../../core/logger.js";
import { jobLauncherContract } from "../contract-suite.js";
import { hostTarArchive } from "../kubernetes.js";
import { createSubstrateRoutes } from "../../coding-proxy/substrate/routes.js";
import { deriveRegistryToken } from "../../../coding/registry/token.js";
import { collectExclusions } from "../../../coding/collect-exclude.js";
import type { CodexWorkerSetup } from "../codex-worker-setup.js";
import { JobCapacityError, type JobSpec } from "../types.js";
import { SubstrateExhaustedError, SubstrateUnavailableError, type WorkerInfo } from "./api.js";
import { inputHasGitHistory } from "./launcher.js";
import { agentEgress, agentTemplate, codexTemplate, toolEgress, toolTemplate } from "./specs.js";
import {
  CODEX_IMAGE,
  CONFIG,
  FAKE_CAP,
  FAKE_MCP,
  makeHarness,
  PYTHON_TOOL_IMAGE,
  SMALL_WORKER,
  type Harness,
} from "./launcher.test-support.js";
import { BLOB, REPO_BLOB, agentActorName, toolActorName } from "./names.js";

const BLOB_KINDS = [
  "input",
  "toolSetup",
  "seed",
  "result",
  "transcript",
  "workspace",
  "exit",
  "done",
  "started",
] as const;

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

/** Posts these files as the tool actor's workspace tar for the run with this token. */
async function putWorkspaceTarFor(h: Harness, token: string, files: Record<string, string>): Promise<void> {
  const source = await mkdtemp(join(tmpdir(), "wardby-substrate-ws-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(source, name, ".."), { recursive: true });
    await writeFile(join(source, name), content);
  }
  const archive = hostTarArchive(source);
  await h.blobs.putStream(BLOB.workspace(token), archive.stream);
  expect(await archive.done).toBe(0);
}

async function putWorkspaceTar(h: Harness, files: Record<string, string>): Promise<void> {
  await putWorkspaceTarFor(h, h.token, files);
}

/** Records every argument of the fake API's launch and cleanup calls, by method. */
function recordCalls(h: Harness): { method: string; args: unknown[] }[] {
  const calls: { method: string; args: unknown[] }[] = [];
  for (const method of [
    "ensureActorTemplate",
    "getActorTemplate",
    "createActor",
    "getActor",
    "putEgressPolicy",
    "resumeActor",
    "suspendActor",
    "deleteActor",
    "deleteEgressPolicy",
  ] as const) {
    const original = h.api[method].bind(h.api) as (...args: unknown[]) => Promise<unknown>;
    (h.api as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      calls.push({ method, args: structuredClone(args) });
      return original(...args);
    };
  }
  return calls;
}

const named = (calls: { method: string; args: unknown[] }[], method: string) =>
  calls.filter((call) => call.method === method);

jobLauncherContract(
  "substrate codex",
  async () => {
    const h = await makeHarness({ provider: "codex" });
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
  },
  async () => {
    const h = await makeHarness({ provider: "codex" });
    return {
      launcher: h.launcher,
      spec: h.spec,
      destination: join(h.workspaceRoot, h.spec.runId, "workspace"),
      finish: (handle) => finish({ ...h, token: handle.id.split("/")[1] }),
      // The one actor's posted workspace: what the Codex bridge tars from /workspace.
      fillJobWorkspace: (handle, files) => putWorkspaceTarFor(h, handle.id.split("/")[1], files),
    };
  },
);

jobLauncherContract(
  "substrate",
  async () => {
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
  },
  async () => {
    const h = await makeHarness();
    return {
      launcher: h.launcher,
      spec: h.spec,
      destination: join(h.workspaceRoot, h.spec.runId, "workspace"),
      finish: (handle) => finish({ ...h, token: handle.id.split("/")[1] }),
      // The tool actor's posted workspace: what the bridge tars from /workspace (a root .git included).
      fillJobWorkspace: (handle, files) => putWorkspaceTarFor(h, handle.id.split("/")[1], files),
    };
  },
);

jobLauncherContract(
  "substrate with MCP tools",
  async () => {
    const h = await makeHarness({ mcpTokenFor: () => FAKE_MCP });
    return {
      launcher: h.launcher,
      spec: { ...h.spec, mcpTools: true },
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
  },
  async () => {
    const h = await makeHarness({ mcpTokenFor: () => FAKE_MCP });
    return {
      launcher: h.launcher,
      spec: { ...h.spec, mcpTools: true },
      destination: join(h.workspaceRoot, h.spec.runId, "workspace"),
      finish: (handle) => finish({ ...h, token: handle.id.split("/")[1] }),
      fillJobWorkspace: (handle, files) => putWorkspaceTarFor(h, handle.id.split("/")[1], files),
    };
  },
);

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
    // The registry settings point at the proxy host the tool actor's egress allows, not the k8s alias.
    expect(setup.toolSetup).toContain(`http://${CONFIG.proxyHost}:${CONFIG.proxyPort}`);
    expect(setup.toolSetup).not.toContain("wardby-proxy");
    expect(setup.collectExclude.paths).toEqual([]);
    expect(setup.collectExclude.names.length).toBeGreaterThan(0);
    // Without git history the tool bridge uploads the workspace as it is.
    expect(setup).not.toHaveProperty("collectResultBundle");
    expect((await h.blobs.get(BLOB.seed(h.token))).toString("latin1")).toContain("# hello");
    // A run without extra repositories is unchanged.
    expect(setup).not.toHaveProperty("repositories");
    expect(await h.runs.get("run-1")).not.toHaveProperty("repositories");
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
    const h = await makeHarness({ workers: 1, workerSize: SMALL_WORKER });
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
    h.api.options.workers = 2;
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
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 3,
      reason: "failed",
      diagnostic: "substrate_result_missing",
    });
  });

  it("fails a run without a result with the worker's own diagnostic, as the Kubernetes launcher does", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await h.blobs.put(BLOB.exit(h.token), Buffer.from('{"code":1,"diagnostic":"coding_turn_limit"}'));
    await finish(h, null);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "coding_turn_limit",
    });

    const issues = await makeHarness();
    const issuesHandle = await issues.launcher.launch(issues.spec);
    await issues.blobs.put(
      BLOB.exit(issues.token),
      Buffer.from('{"code":2,"diagnostic":"coding_output_invalid","diagnosticIssues":["summary:too_big"]}'),
    );
    await finish(issues, null);
    expect(await issues.launcher.collect(issuesHandle)).toEqual({
      exitCode: 2,
      reason: "failed",
      diagnostic: "coding_output_invalid",
      diagnosticIssues: ["summary:too_big"],
    });
  });

  it("re-validates the exit report's diagnostic and falls back to substrate_result_missing", async () => {
    for (const exit of [
      { code: 1, diagnostic: "provider said sk-SECRET" },
      { code: 1, diagnostic: 7 },
      { code: 1, diagnosticIssues: ["summary:too_big"] },
    ]) {
      const h = await makeHarness();
      const handle = await h.launcher.launch(h.spec);
      await h.blobs.put(BLOB.exit(h.token), Buffer.from(JSON.stringify(exit)));
      await finish(h, null);
      expect(await h.launcher.collect(handle)).toEqual({
        exitCode: 1,
        reason: "failed",
        diagnostic: "substrate_result_missing",
      });
    }
    // An unsafe issues list is dropped, the safe code kept (the shared parser's rule).
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await h.blobs.put(
      BLOB.exit(h.token),
      Buffer.from('{"code":1,"diagnostic":"coding_output_invalid","diagnosticIssues":["sk-SECRET"]}'),
    );
    await finish(h, null);
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "coding_output_invalid",
    });
  });

  it("fails a result for another run or one that does not parse", async () => {
    for (const result of [{ ...(await makeHarness()).output, runId: "someone-else" }, { nope: true }]) {
      const h = await makeHarness();
      const handle = await h.launcher.launch(h.spec);
      await finish(h, result);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
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

  describe("fails fast instead of waiting for the deadline", () => {
    const START = 1_000_000;
    /** The proxy's records of a started run: the agent fetched its input, the tool polled (tool setup gone). */
    const started = async (h: Harness): Promise<void> => {
      await h.blobs.put(BLOB.started(h.token), Buffer.from("{}"));
      await h.blobs.delete(BLOB.toolSetup(h.token));
    };

    it("fails a run whose workspace never arrives within the collect grace after the worker exited", async () => {
      const h = await makeHarness();
      const handle = await h.launcher.launch(h.spec);
      await started(h);
      h.setNow(START + 60_000);
      await h.blobs.put(BLOB.exit(h.token), Buffer.from('{"code":3}'));
      h.setNow(START + 60_000 + 120_000);
      expect(await h.launcher.status(handle)).toEqual({ state: "running" });
      h.setNow(START + 60_000 + 120_001);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
      expect(h.api.actors.size).toBe(0);
      expect(await h.launcher.collect(handle)).toEqual({
        exitCode: 3,
        reason: "failed",
        diagnostic: "substrate_collect_timeout",
      });
      // Terminal: a late `done` changes nothing.
      await finish(h, h.output);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
      expect((await h.launcher.collect(handle)).diagnostic).toBe("substrate_collect_timeout");
    });

    it("reports the worker's own diagnostic on a collect timeout, and honours a configured grace", async () => {
      const h = await makeHarness({ collectGraceMs: 10_000 });
      const handle = await h.launcher.launch(h.spec);
      await started(h);
      await h.blobs.put(BLOB.exit(h.token), Buffer.from('{"code":1,"diagnostic":"coding_turn_limit"}'));
      h.setNow(START + 10_001);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
      expect(await h.launcher.collect(handle)).toEqual({
        exitCode: 1,
        reason: "failed",
        diagnostic: "coding_turn_limit",
      });
    });

    it("fails a run whose agent never fetched its input within the startup timeout", async () => {
      const h = await makeHarness();
      const handle = await h.launcher.launch(h.spec);
      h.setNow(START + 300_000);
      expect(await h.launcher.status(handle)).toEqual({ state: "running" });
      h.setNow(START + 300_001);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
      expect(h.api.actors.size).toBe(0);
      expect(await h.launcher.collect(handle)).toEqual({
        exitCode: 1,
        reason: "failed",
        diagnostic: "substrate_startup_timeout",
      });
      h.setNow(START + 10_000_000);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    });

    it("fails a run whose tool never made its first events poll (tool setup still there)", async () => {
      const h = await makeHarness({ startupTimeoutMs: 60_000 });
      const handle = await h.launcher.launch(h.spec);
      await h.blobs.put(BLOB.started(h.token), Buffer.from("{}"));
      h.setNow(START + 60_001);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
      expect((await h.launcher.collect(handle)).diagnostic).toBe("substrate_startup_timeout");
    });

    it("keeps a started run running past the startup timeout, until its deadline", async () => {
      const h = await makeHarness();
      const handle = await h.launcher.launch(h.spec);
      await started(h);
      h.setNow(START + 599_000);
      expect(await h.launcher.status(handle)).toEqual({ state: "running" });
      h.setNow(START + 600_001);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    });

    it("counts the startup timeout from when the run became running, not from the launch claim", async () => {
      const h = await makeHarness();
      const handle = await h.launcher.launch(h.spec);
      // The row's last write is the move to running (memory store: the harness clock at that moment).
      const record = await h.runs.get(h.spec.runId);
      expect(record?.updatedAt).toEqual(new Date(START));
      h.setNow(START + 200_000);
      expect(await h.launcher.status(handle)).toEqual({ state: "running" });
    });
  });

  it("removes actors, policies, Secret and blobs, keeps a tombstone and never relaunches", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await h.blobs.put(BLOB.transcript(h.token), Buffer.from("{}\n"));
    await h.blobs.put(BLOB.workspace(h.token), Buffer.from("tar"));
    await h.blobs.put(BLOB.exit(h.token), Buffer.from('{"code":0}'));
    await h.blobs.put(BLOB.started(h.token), Buffer.from("{}"));
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

  it("deletes a removed run's relay rows (tool traffic) on every path, not only after a collect", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    const channel = await h.relay.openChannel(h.token);
    await h.relay.fromAgent(h.token, channel, 1, '{"jsonrpc":"2.0","method":"tool"}');
    await h.relay.fromTool(h.token, channel, 1, '{"jsonrpc":"2.0","result":"output"}');
    // Stopped mid-run: the tool bridge never posts workspace or workspace-failed.
    await h.launcher.stop(handle, "cancelled");
    expect(h.relay.hasRelayRows(h.token)).toBe(true);
    await h.launcher.remove(handle);
    expect(h.relay.hasRelayRows(h.token)).toBe(false);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("removed");
  });

  it("deletes done last on remove: a failed outcome deletion leaves done, never done without what it reports", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await finish(h);
    const order: string[] = [];
    const deleteBlob = h.blobs.delete.bind(h.blobs);
    let failResult = true;
    h.blobs.delete = async (key) => {
      order.push(key.split("/").pop()!);
      if (failResult && key === BLOB.result(h.token)) throw new Error("blob_down");
      return deleteBlob(key);
    };
    await expect(h.launcher.remove(handle)).rejects.toThrow("blob_down");
    expect(await blobKeys(h)).toEqual(["result", "done"]);
    expect(await h.launcher.status(handle)).toEqual({ state: "succeeded" });
    failResult = false;
    order.length = 0;
    await h.launcher.remove(handle);
    expect(order.at(-1)).toBe("done.json");
    expect(order.indexOf("result.json")).toBeLessThan(order.indexOf("done.json"));
    expect(await blobKeys(h)).toEqual([]);
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
      const failing = await makeHarness({ workers: 1, workerSize: SMALL_WORKER });
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

  it("creates each actor before its egress policy (Substrate's foreign key), and both policies before any resume", async () => {
    const h = await makeHarness();
    const order: string[] = [];
    for (const method of ["createActor", "putEgressPolicy", "resumeActor"] as const) {
      const original = h.api[method].bind(h.api) as (...args: unknown[]) => Promise<void>;
      (h.api as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        order.push(`${method} ${String(args[1]).replace(h.token, "T")}`);
        return original(...args);
      };
    }
    await h.launcher.launch(h.spec);
    expect(order).toEqual([
      "createActor T-agent",
      "createActor T-tool",
      "putEgressPolicy T-agent",
      "putEgressPolicy T-tool",
      "resumeActor T-tool",
      "resumeActor T-agent",
    ]);
    expect(h.callFailures).toEqual([]);
  });

  it("names the Substrate call that failed, with fixed fields only", async () => {
    const h = await makeHarness();
    h.api.putEgressPolicy = async () => {
      throw new SubstrateUnavailableError("substrate_unavailable");
    };
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(SubstrateUnavailableError);
    expect(h.callFailures).toEqual([
      { runId: h.spec.runId, substrateCall: "putEgressPolicy", errorCode: "substrate_unavailable" },
    ]);
    expect(JSON.stringify(h.callFailures)).not.toContain(FAKE_CAP);

    // An existing actor (a relaunch of the same run) is not a failure.
    const r = await makeHarness();
    await r.api.ensureActorTemplate(agentTemplate(r.spec, CONFIG));
    await r.api.createActor(CONFIG.atespace, agentActorName(r.token), agentTemplate(r.spec, CONFIG).name);
    await r.launcher.launch(r.spec);
    expect(r.callFailures).toEqual([]);
  });

  it("recreates a template whose golden snapshot failed, once per launch", async () => {
    const h = await makeHarness();
    const agent = agentTemplate(h.spec, CONFIG);
    await h.api.ensureActorTemplate(agent);
    h.api.failGoldenSnapshot(CONFIG.atespace, agent.name);
    const deleted: string[] = [];
    const deleteTemplate = h.api.deleteActorTemplate.bind(h.api);
    h.api.deleteActorTemplate = async (atespace, name) => {
      deleted.push(name);
      return deleteTemplate(atespace, name);
    };
    await h.launcher.launch(h.spec);
    expect(deleted).toEqual([agent.name]);
    expect(await h.api.getActorTemplate(CONFIG.atespace, agent.name)).toEqual({ goldenSnapshotFailed: false });
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");

    // Still failed after the recreate (a broken image): no second delete in the same launch.
    const r = await makeHarness();
    const getTemplate = r.api.getActorTemplate.bind(r.api);
    r.api.getActorTemplate = async (atespace, name) => ({
      ...(await getTemplate(atespace, name))!,
      goldenSnapshotFailed: true,
    });
    let deletes = 0;
    r.api.deleteActorTemplate = async () => {
      deletes += 1;
    };
    await r.launcher.launch(r.spec);
    expect(deletes).toBe(2); // one per template (agent and tool), never repeated
  });

  it("rejects what Phase A does not support, before any side effect", async () => {
    const h = await makeHarness();
    const cases: [Partial<JobSpec>, string][] = [
      [{ provider: undefined }, "substrate_provider_unsupported"],
      [{ image: "registry.example/agent:latest" }, "substrate_image_not_digest"],
      [{ toolImage: "registry.example/tool:latest" }, "substrate_image_not_digest"],
      [{ services: [] }, "substrate_feature_unsupported:services"],
      [{ dependencyCache: true }, "substrate_feature_unsupported:dependencyCache"],
      // An agent's custom tool image (workerImageRef) is a digest but carries no bridge.
      [{ toolImage: `registry.example/byo@sha256:${"e".repeat(64)}` }, "substrate_feature_unsupported:workerImage"],
    ];
    for (const [change, code] of cases) {
      await expect(h.launcher.launch({ ...h.spec, ...change })).rejects.toThrow(code);
      expect(h.launcher.plannedHandle({ ...h.spec, ...change })).toBeUndefined();
    }
    expect(await h.runs.get(h.spec.runId)).toBeUndefined();
    expect(h.api.templates.size).toBe(0);
    // Session resume is accepted, and so is another configured (per-toolchain) bridge tool image.
    expect(h.launcher.plannedHandle({ ...h.spec, toolImage: PYTHON_TOOL_IMAGE })).toBeDefined();
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

  it("refuses a nested .git with history on, and leaves no bundle behind", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await putWorkspaceTar(h, {
      "README.md": "# changed\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/wardby-result.bundle": "# v2 git bundle\n",
      "vendor/lib/.git/HEAD": "ref: refs/heads/main\n",
    });
    await finish(h);
    const destination = join(h.workspaceRoot, h.spec.runId, "workspace");
    const trusted = await mkdtemp(join(tmpdir(), "wardby-substrate-bundle-"));
    const bundleDestination = join(trusted, "result.bundle");
    await expect(
      h.launcher.materializeWorkspace(handle, destination, undefined, {
        gitHistory: { bundleDestination, maxBundleBytes: 1024 },
      }),
    ).rejects.toThrow("docker_workspace_nested_repository");
    await expect(lstat(bundleDestination)).rejects.toThrow(/ENOENT/);
    // The trusted workspace is untouched.
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("# hello\n");
  });

  it("refuses a history run's bundle over its limit (capped at the archive size) and leaves no bundle file", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await putWorkspaceTar(h, {
      "README.md": "# changed\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/wardby-result.bundle": "b".repeat(4096),
    });
    await finish(h);
    const destination = join(h.workspaceRoot, h.spec.runId, "workspace");
    const trusted = await mkdtemp(join(tmpdir(), "wardby-substrate-bundle-"));
    const bundleDestination = join(trusted, "result.bundle");
    await expect(
      h.launcher.materializeWorkspace(handle, destination, undefined, {
        gitHistory: { bundleDestination, maxBundleBytes: 1024 },
      }),
    ).rejects.toThrow("vcs_result_bundle_too_large");
    await expect(readFile(bundleDestination)).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("# hello\n");
    // A configured limit far above the archive is capped at its size, and a bundle within it is taken.
    const taken = await h.launcher.materializeWorkspace(handle, destination, undefined, {
      gitHistory: { bundleDestination, maxBundleBytes: Number.MAX_SAFE_INTEGER },
    });
    expect(taken).toEqual({ bundle: true });
    expect((await readFile(bundleDestination)).length).toBe(4096);
  });

  it("tells the tool bridge to upload only the result bundle on a git-history run", async () => {
    const h = await makeHarness();
    const gitHistory = { repositories: [{ path: "/workspace", baseCommit: "a".repeat(40), excludeCommits: [] }] };
    await writeFile(h.spec.inputArtifact, JSON.stringify({ schemaVersion: 1, task: "say hello", gitHistory }));
    await h.launcher.launch(h.spec);
    const setup = JSON.parse((await h.blobs.get(BLOB.toolSetup(h.token))).toString()) as Record<string, unknown>;
    expect(setup.collectResultBundle).toBe(true);
  });

  it("reads git history from the worker input only when it is an object", () => {
    expect(inputHasGitHistory(Buffer.from(JSON.stringify({ gitHistory: { repositories: [] } })))).toBe(true);
    for (const input of ["{}", '{"gitHistory":null}', '{"gitHistory":true}', "[]", "null", "not json"]) {
      expect(inputHasGitHistory(Buffer.from(input))).toBe(false);
    }
  });

  it("takes the bundle from a history run's workspace whose .git holds only the bundle", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    // The tool bridge's shape on a history run: the files, then only ./.git/wardby-result.bundle
    // (no .git directory entry, no other .git file).
    const source = await mkdtemp(join(tmpdir(), "wardby-substrate-ws-"));
    await mkdir(join(source, ".git"));
    await writeFile(join(source, "README.md"), "# changed\n");
    await writeFile(join(source, ".git", "wardby-result.bundle"), "# v2 git bundle\n");
    const tarPath = join(source, "..", `${h.token}-workspace.tar`);
    await promisify(execFile)(
      "tar",
      ["-c", "-f", tarPath, "-C", source, "--no-recursion", "./README.md", "./.git/wardby-result.bundle"],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    await h.blobs.put(BLOB.workspace(h.token), await readFile(tarPath));
    await finish(h);
    const destination = join(h.workspaceRoot, h.spec.runId, "workspace");
    const trusted = await mkdtemp(join(tmpdir(), "wardby-substrate-bundle-"));
    const bundleDestination = join(trusted, "result.bundle");
    expect(
      await h.launcher.materializeWorkspace(handle, destination, undefined, {
        gitHistory: { bundleDestination, maxBundleBytes: 1024 },
      }),
    ).toEqual({ bundle: true });
    expect(await readFile(bundleDestination, "utf8")).toBe("# v2 git bundle\n");
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("# changed\n");
    expect(await readdir(destination)).not.toContain(".git");
  });

  it("seeds a history run's root .git with the workspace", async () => {
    const h = await makeHarness();
    await mkdir(join(h.workspaceRoot, h.spec.runId, "workspace", ".git"));
    await writeFile(join(h.workspaceRoot, h.spec.runId, "workspace", ".git", "HEAD"), "ref: refs/heads/main\n");
    await h.launcher.launch(h.spec);
    expect((await h.blobs.get(BLOB.seed(h.token))).toString("latin1")).toContain("./.git/HEAD");
  });

  it("reads the transcript within its bound", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    expect(await h.launcher.readTranscript(handle, 100)).toBeUndefined();
    await h.blobs.put(BLOB.transcript(h.token), Buffer.from('{"type":"x"}\n'));
    expect(await h.launcher.readTranscript(handle, 100)).toBe('{"type":"x"}\n');
    await expect(h.launcher.readTranscript(handle, 4)).rejects.toThrow("transcript_too_large");
  });

  it("checks capacity by placing both actors on the workers' free room, and says yes when in doubt", async () => {
    const h = await makeHarness();
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
    const agent = agentTemplate(h.spec, CONFIG);
    const tool = toolTemplate(h.spec, CONFIG);
    const worker = (cpu: number, memory: number): WorkerInfo => ({
      pool: "p",
      labels: {},
      freeCpuMillicores: cpu,
      freeMemoryBytes: memory,
    });
    const check = async (list: WorkerInfo[]) => {
      h.api.listWorkers = async () => list;
      return h.launcher.hasCapacityFor(h.spec);
    };
    const both = { cpu: agent.cpuMillicores + tool.cpuMillicores, memory: agent.memoryBytes + tool.memoryBytes };
    // One worker holds both, or each on its own worker.
    expect(await check([worker(both.cpu, both.memory)])).toBe(true);
    expect(
      await check([worker(agent.cpuMillicores, agent.memoryBytes), worker(tool.cpuMillicores, tool.memoryBytes)]),
    ).toBe(true);
    // One short in CPU or in memory.
    expect(await check([worker(both.cpu - 1, both.memory)])).toBe(false);
    expect(await check([worker(both.cpu, both.memory - 1)])).toBe(false);
    // The agent (larger) takes the roomier worker; the tool then fits nowhere.
    expect(
      await check([worker(agent.cpuMillicores + 10, both.memory), worker(tool.cpuMillicores - 1, both.memory)]),
    ).toBe(false);
    expect(await check([])).toBe(false);
    h.api.listWorkers = async () => {
      throw new SubstrateUnavailableError("substrate_unavailable");
    };
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
    expect(h.launcher.supportsServicesFor("claude-code")).toBe(false);
  });

  it("agrees with the launch: one big worker fits both, one small worker fits neither run", async () => {
    const big = await makeHarness({ workers: 1 });
    expect(await big.launcher.hasCapacityFor(big.spec)).toBe(true);
    await big.launcher.launch(big.spec);
    expect([...big.api.actors.values()].every((actor) => actor.state === "RUNNING" && actor.worker === 0)).toBe(true);

    const small = await makeHarness({ workers: 1, workerSize: SMALL_WORKER });
    expect(await small.launcher.hasCapacityFor(small.spec)).toBe(false);
    await expect(small.launcher.launch(small.spec)).rejects.toBeInstanceOf(JobCapacityError);
  });

  it("counts only the workers the configured selector matches", async () => {
    const selector = { "wardby.dev/pool": "runs" };
    const other = await makeHarness({
      workers: 1,
      workerLabels: { "wardby.dev/pool": "other" },
      config: { workerSelector: selector },
    });
    expect(await other.launcher.hasCapacityFor(other.spec)).toBe(false);
    const matching = await makeHarness({
      workers: 1,
      workerLabels: { "wardby.dev/pool": "runs", zone: "a" },
      config: { workerSelector: selector },
    });
    expect(await matching.launcher.hasCapacityFor(matching.spec)).toBe(true);
    // No selector: every worker counts.
    const any = await makeHarness({ workers: 1, workerLabels: { "wardby.dev/pool": "other" } });
    expect(await any.launcher.hasCapacityFor(any.spec)).toBe(true);
  });

  it("does not count a success reported after the deadline (with 5 s of skew)", async () => {
    const late = await makeHarness();
    const handle = await late.launcher.launch(late.spec);
    late.setNow(1_000_000 + 600_000 + 5_001);
    await finish(late);
    expect(await late.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    expect(late.api.actors.size).toBe(0);
    expect(await late.launcher.collect(handle)).toEqual({ exitCode: 124, reason: "timed_out" });
    expect((await late.runs.get(late.spec.runId))?.phase).toBe("timed_out");

    const onTime = await makeHarness();
    const second = await onTime.launcher.launch(onTime.spec);
    onTime.setNow(1_000_000 + 600_000 + 5_000);
    await finish(onTime);
    onTime.setNow(1_000_000 + 900_000);
    expect(await onTime.launcher.status(second)).toEqual({ state: "succeeded" });
  });

  it("cleans up every resource independently when one deletion fails", async () => {
    const h = await makeHarness({ workers: 1, workerSize: SMALL_WORKER });
    const deleteActor = h.api.deleteActor.bind(h.api);
    h.api.deleteActor = async (atespace, name) => {
      if (name === agentActorName(h.token)) throw new SubstrateUnavailableError("substrate_unavailable");
      return deleteActor(atespace, name);
    };
    const deleteBlob = h.blobs.delete.bind(h.blobs);
    h.blobs.delete = async (key) => {
      if (key === BLOB.input(h.token)) throw new Error("blob_down");
      return deleteBlob(key);
    };
    h.secrets.deleteSecret = async () => {
      throw new Error("k8s_down");
    };
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect([...h.api.actors.keys()]).toEqual([`wardby-runs/${agentActorName(h.token)}`]);
    expect(h.api.egressPolicies.size).toBe(0);
    expect(await blobKeys(h)).toEqual(["input"]);
    expect(h.secrets.secrets.size).toBe(1);

    // remove(): every deletion is tried, the first failure is reported, the run is not yet removed.
    const r = await makeHarness();
    const handle = await r.launcher.launch(r.spec);
    await finish(r);
    const rDeleteActor = r.api.deleteActor.bind(r.api);
    let fail = true;
    r.api.deleteActor = async (atespace, name) => {
      if (fail && name === agentActorName(r.token)) throw new SubstrateUnavailableError("substrate_unavailable");
      return rDeleteActor(atespace, name);
    };
    await expect(r.launcher.remove(handle)).rejects.toThrow("substrate_unavailable");
    expect([...r.api.actors.keys()]).toEqual([`wardby-runs/${agentActorName(r.token)}`]);
    expect(r.api.egressPolicies.size).toBe(0);
    expect(r.secrets.secrets.size).toBe(0);
    // The outcome is kept until every other deletion succeeds, so the run still reads as it ended.
    expect(await blobKeys(r)).toEqual(["result", "done"]);
    expect(await r.launcher.status(handle)).toEqual({ state: "succeeded" });
    expect((await r.runs.get(r.spec.runId))?.phase).toBe("running");
    fail = false;
    await r.launcher.remove(handle);
    expect(r.api.actors.size).toBe(0);
    expect((await r.runs.get(r.spec.runId))?.phase).toBe("removed");
  });

  it("cleans up and records provisioning_failed when marking the run running fails", async () => {
    const h = await makeHarness();
    const setPhase = h.runs.setPhase.bind(h.runs);
    h.runs.setPhase = async (runId, phase, from) => {
      if (phase === "running") throw new Error("db_down");
      return setPhase(runId, phase, from);
    };
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("db_down");
    expect(h.api.actors.size).toBe(0);
    expect(h.api.egressPolicies.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect(await blobKeys(h)).toEqual([]);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("provisioning_failed");
  });
});

describe("Codex (single actor)", () => {
  const START = 1_000_000;
  const codex = () => makeHarness({ provider: "codex" });
  /** The proxy's records of a started single-shape run: the agent fetched its input, which deleted the setup. */
  const started = async (h: Harness): Promise<void> => {
    await h.blobs.put(BLOB.started(h.token), Buffer.from("{}"));
    await h.blobs.delete(BLOB.toolSetup(h.token));
  };

  it("launches one actor from one Codex template, with the agent's rule only, and records the single shape", async () => {
    const h = await codex();
    expect(h.spec.toolImage).toBeUndefined();
    expect(h.spec.image).toBe(CODEX_IMAGE);
    const calls = recordCalls(h);
    const handle = await h.launcher.launch(h.spec);
    expect(handle).toEqual({ backend: "substrate", id: `wardby-runs/${h.token}` });

    const templates = named(calls, "ensureActorTemplate");
    expect(templates).toHaveLength(1);
    const template = templates[0].args[0] as ReturnType<typeof codexTemplate>;
    expect(template).toEqual(codexTemplate(h.spec, CONFIG));
    expect(template.name).toMatch(/^wardby-codex-[0-9a-f]{16}$/);
    expect(named(calls, "createActor").map((call) => call.args)).toEqual([
      [CONFIG.atespace, agentActorName(h.token), template.name],
    ]);
    expect(named(calls, "putEgressPolicy").map((call) => call.args)).toEqual([
      [CONFIG.atespace, agentActorName(h.token), agentEgress(h.token, CONFIG)],
    ]);
    expect(named(calls, "resumeActor").map((call) => call.args)).toEqual([[CONFIG.atespace, agentActorName(h.token)]]);
    expect([...h.api.actors.keys()]).toEqual([`wardby-runs/${agentActorName(h.token)}`]);
    expect(h.api.actors.get(`wardby-runs/${toolActorName(h.token)}`)).toBeUndefined();
    expect(JSON.stringify([...h.api.egressPolicies.values()])).not.toContain("X-Wardby-Actor-Jwt");
    expect(JSON.stringify([...h.api.egressPolicies.values()])).not.toContain("actorJwt");

    const record = await h.runs.get(h.spec.runId);
    expect(record?.actorShape).toBe("single");
    expect(record?.phase).toBe("running");
    expect(await h.launcher.status(handle)).toEqual({ state: "running" });
    expect(await blobKeys(h)).toEqual(["input", "toolSetup", "seed"]);

    const raw = (await h.blobs.get(BLOB.toolSetup(h.token))).toString();
    const setup = JSON.parse(raw) as CodexWorkerSetup;
    expect(setup).toEqual({
      schemaVersion: 1,
      registryToken: deriveRegistryToken(FAKE_CAP),
      collectExclude: collectExclusions([]),
    });
    expect(raw).not.toContain(FAKE_CAP);
  });

  it("asks the Codex bridge for the result bundle only on a git-history run", async () => {
    const h = await codex();
    await writeFile(h.spec.inputArtifact, JSON.stringify({ schemaVersion: 1, task: "x", gitHistory: {} }));
    await h.launcher.launch(h.spec);
    const setup = JSON.parse((await h.blobs.get(BLOB.toolSetup(h.token))).toString()) as CodexWorkerSetup;
    expect(setup.collectResultBundle).toBe(true);
  });

  it("never puts the capability or the registry token in a call, a failure report, a warm event or a log", async () => {
    const registryToken = deriveRegistryToken(FAKE_CAP);
    const logs: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    const writeOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = (chunk: string | Uint8Array) => (logs.push(String(chunk)), true);
    process.stdout.write = (chunk: string | Uint8Array) => (logs.push(String(chunk)), true);
    const outputs: string[] = [];
    let h: Harness;
    try {
      h = await makeHarness({ provider: "codex", warmRounds: { parkTtlMs: 60_000, parkMax: 2 } });
      const calls = recordCalls(h);
      const warm = { fromRunId: "run-prior", headSha: "a".repeat(40), fingerprint: "b".repeat(64) };
      const handle = await h.launcher.launch({ ...h.spec, warm });
      await h.launcher.status(handle);
      await finish(h);
      await h.launcher.retain(handle, { headSha: "a".repeat(40), fingerprint: "b".repeat(64) });

      const failing = await makeHarness({ provider: "codex" });
      const failingCalls = recordCalls(failing);
      failing.api.putEgressPolicy = async () => {
        throw new SubstrateUnavailableError("substrate_unavailable");
      };
      const error = (await failing.launcher.launch(failing.spec).catch((e: unknown) => e)) as Error;
      expect(failing.callFailures).toEqual([
        { runId: failing.spec.runId, substrateCall: "putEgressPolicy", errorCode: "substrate_unavailable" },
      ]);
      outputs.push(
        JSON.stringify(calls),
        JSON.stringify(failingCalls),
        JSON.stringify(h.callFailures),
        JSON.stringify(failing.callFailures),
        JSON.stringify(h.warmEvents),
        JSON.stringify(failing.warmEvents),
        JSON.stringify({ message: error.message, stack: error.stack }),
        JSON.stringify(await h.runs.get(h.spec.runId)),
      );
    } finally {
      process.stderr.write = write;
      process.stdout.write = writeOut;
    }
    outputs.push(logs.join(""));
    for (const output of outputs) {
      expect(output).not.toContain(FAKE_CAP);
      expect(output).not.toContain(registryToken);
    }

    // The per-run Secret is the capability's only home, as for Claude Code.
    const fresh = await codex();
    await fresh.launcher.launch(fresh.spec);
    expect(fresh.secrets.secrets.get(`${CONFIG.credentialsNamespace}/${fresh.token}`)?.stringData).toEqual({
      capability: FAKE_CAP,
    });
    const shared = JSON.stringify([...fresh.api.templates.values(), ...fresh.api.egressPolicies.values()]);
    expect(shared).not.toContain(FAKE_CAP);
    expect(shared).not.toContain("rrg_");
  });

  describe("observes the one actor", () => {
    it("fails a crashed agent", async () => {
      const h = await codex();
      const handle = await h.launcher.launch(h.spec);
      h.api.setState("wardby-runs", agentActorName(h.token), "CRASHED");
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
      expect(await h.launcher.collect(handle)).toEqual({ exitCode: 1, reason: "failed" });
      expect((await h.runs.get(h.spec.runId))?.phase).toBe("crashed");
    });

    it("loses a run whose agent is gone, and never looks for a tool actor", async () => {
      const h = await codex();
      const handle = await h.launcher.launch(h.spec);
      const calls = recordCalls(h);
      expect(await h.launcher.status(handle)).toEqual({ state: "running" });
      expect(named(calls, "getActor").map((call) => call.args[1])).toEqual([agentActorName(h.token)]);
      await h.api.deleteActor("wardby-runs", agentActorName(h.token));
      expect(await h.launcher.status(handle)).toEqual({ state: "lost" });
      expect((await h.runs.get(h.spec.runId))?.phase).toBe("lost");
    });

    it("deletes the one actor on stop", async () => {
      const h = await codex();
      const handle = await h.launcher.launch(h.spec);
      const calls = recordCalls(h);
      await h.launcher.stop(handle, "cancelled");
      expect(h.api.actors.size).toBe(0);
      expect(named(calls, "deleteActor").map((call) => call.args[1])).toEqual([agentActorName(h.token)]);
      expect((await h.runs.get(h.spec.runId))?.phase).toBe("stopped");
    });

    it("times out past the deadline and deletes the actor", async () => {
      const h = await codex();
      const handle = await h.launcher.launch(h.spec);
      const calls = recordCalls(h);
      h.setNow(START + 600_001);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
      expect(h.api.actors.size).toBe(0);
      expect(named(calls, "deleteActor").map((call) => call.args[1])).toEqual([agentActorName(h.token)]);
      expect(await h.launcher.collect(handle)).toEqual({ exitCode: 124, reason: "timed_out" });
    });

    it("fails a run whose workspace never arrives within the collect grace after the worker exited", async () => {
      const h = await codex();
      const handle = await h.launcher.launch(h.spec);
      await started(h);
      h.setNow(START + 60_000);
      await h.blobs.put(BLOB.exit(h.token), Buffer.from('{"code":3}'));
      h.setNow(START + 60_000 + 120_000);
      expect(await h.launcher.status(handle)).toEqual({ state: "running" });
      h.setNow(START + 60_000 + 120_001);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
      expect(h.api.actors.size).toBe(0);
      expect(await h.launcher.collect(handle)).toEqual({
        exitCode: 3,
        reason: "failed",
        diagnostic: "substrate_collect_timeout",
      });
    });

    it("fails a run that never reached the proxy within the startup timeout, and keeps a started one running", async () => {
      const h = await codex();
      const handle = await h.launcher.launch(h.spec);
      h.setNow(START + 300_001);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
      expect((await h.launcher.collect(handle)).diagnostic).toBe("substrate_startup_timeout");
      expect(h.api.actors.size).toBe(0);

      const ok = await codex();
      const running = await ok.launcher.launch(ok.spec);
      await started(ok);
      ok.setNow(START + 599_000);
      expect(await ok.launcher.status(running)).toEqual({ state: "running" });
    });

    it("is not failed as startup_timeout once its agent fetched the input through the proxy's routes", async () => {
      const h = await codex();
      const handle = await h.launcher.launch(h.spec);
      expect(await h.blobs.head(BLOB.toolSetup(h.token))).not.toBeNull();
      // The proxy's routes on the same blob store, reading the shape from the run's row.
      const routes = createSubstrateRoutes({
        atespace: CONFIG.atespace,
        relay: h.relay,
        blobs: h.blobs,
        ledger: {
          findSessionByCapabilityHash: async () =>
            ({ runId: h.spec.runId, status: "active", deadlineAt: new Date(Date.now() + 60_000) }) as never,
        },
        verifyActor: async () => ({ ok: false, code: "invalid" }),
        tokenForRun: async (runId) => (await h.runs.get(runId))?.token ?? "",
        actorShapeForToken: async (token) => {
          const record = await h.runs.get(h.spec.runId);
          return record?.token === token && record.actorShape === "single" ? "single" : "pair";
        },
        limits: { resultBytes: 1024, transcriptBytes: 1024, workspaceBytes: 1024 },
        log: { info: () => undefined, warn: () => undefined },
      });
      const server = createServer((req, res) => void routes(req, res));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/substrate/runs/${h.token}`;
        const setup = await fetch(`${base}/tool-setup`, { headers: { "x-api-key": FAKE_CAP } });
        expect(setup.status).toBe(200);
        await setup.arrayBuffer();
        const input = await fetch(`${base}/input`, { headers: { "x-api-key": FAKE_CAP } });
        expect(input.status).toBe(200);
        await input.arrayBuffer();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
      }
      expect(await h.blobs.head(BLOB.started(h.token))).not.toBeNull();
      expect(await h.blobs.head(BLOB.toolSetup(h.token))).toBeNull();
      h.setNow(START + 599_000);
      expect(await h.launcher.status(handle)).toEqual({ state: "running" });
    });

    it("succeeds on a reported result and collects the artifact", async () => {
      const h = await codex();
      const handle = await h.launcher.launch(h.spec);
      await finish(h);
      expect(await h.launcher.status(handle)).toEqual({ state: "succeeded" });
      expect(await h.launcher.collect(handle)).toEqual({
        exitCode: 0,
        reason: "completed",
        resultArtifact: JSON.stringify(h.output),
      });
    });
  });

  it("refuses what a Codex run on Substrate does not support, before any side effect", async () => {
    const h = await codex();
    const calls = recordCalls(h);
    const cases: [Partial<JobSpec>, string][] = [
      [{ toolImage: `registry.example/tool@sha256:${"b".repeat(64)}` }, "substrate_spec_invalid"],
      [{ image: "registry.example/substrate-codex:latest" }, "substrate_image_not_digest"],
      // An agent's custom Codex image (workerImageRef) is a digest but carries no bridge.
      [{ image: `registry.example/byo@sha256:${"e".repeat(64)}` }, "substrate_feature_unsupported:workerImage"],
      [{ services: [] }, "substrate_feature_unsupported:services"],
      [{ dependencyCache: true }, "substrate_feature_unsupported:dependencyCache"],
      [{ provider: "other" as JobSpec["provider"] }, "substrate_provider_unsupported"],
    ];
    for (const [change, code] of cases) {
      await expect(h.launcher.launch({ ...h.spec, ...change })).rejects.toThrow(code);
      expect(h.launcher.plannedHandle({ ...h.spec, ...change })).toBeUndefined();
    }
    expect(calls).toEqual([]);
    expect(await h.runs.get(h.spec.runId)).toBeUndefined();
    expect(h.api.templates.size).toBe(0);
    expect(h.secrets.calls).toEqual([]);
    expect(await blobKeys(h)).toEqual([]);
  });

  it("checks capacity for the one actor, and requeues a launch refused for capacity", async () => {
    const h = await codex();
    const template = codexTemplate(h.spec, CONFIG);
    const worker = (cpu: number, memory: number): WorkerInfo => ({
      pool: "p",
      labels: {},
      freeCpuMillicores: cpu,
      freeMemoryBytes: memory,
    });
    const listWorkers = h.api.listWorkers.bind(h.api);
    h.api.listWorkers = async () => [worker(template.cpuMillicores, template.memoryBytes)];
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
    h.api.listWorkers = async () => [worker(template.cpuMillicores - 1, template.memoryBytes)];
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(false);
    h.api.listWorkers = listWorkers;

    const createActor = h.api.createActor.bind(h.api);
    let exhausted = true;
    h.api.createActor = async (...args) => {
      if (exhausted) throw new SubstrateExhaustedError("no worker has room");
      return createActor(...args);
    };
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("requeued");
    expect(h.api.actors.size).toBe(0);
    expect(h.api.egressPolicies.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect(await blobKeys(h)).toEqual([]);

    exhausted = false;
    h.setNow(5_000_000);
    await h.launcher.launch(h.spec);
    const record = await h.runs.get(h.spec.runId);
    expect(record?.phase).toBe("running");
    expect(record?.actorShape).toBe("single");
    expect([...h.api.actors.keys()]).toEqual([`wardby-runs/${agentActorName(h.token)}`]);
  });

  it("removes the one actor, its policy, the Secret and every blob, never a tool actor", async () => {
    const h = await codex();
    const handle = await h.launcher.launch(h.spec);
    await h.blobs.put(BLOB.workspace(h.token), Buffer.from("tar"));
    await h.blobs.put(BLOB.exit(h.token), Buffer.from('{"code":0}'));
    await h.blobs.put(BLOB.started(h.token), Buffer.from("{}"));
    await finish(h);
    const calls = recordCalls(h);
    await h.launcher.remove(handle);
    expect(named(calls, "deleteActor").map((call) => call.args[1])).toEqual([agentActorName(h.token)]);
    expect(named(calls, "deleteEgressPolicy").map((call) => call.args[1])).toEqual([agentActorName(h.token)]);
    expect(h.api.actors.size).toBe(0);
    expect(h.api.egressPolicies.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect(await blobKeys(h)).toEqual([]);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("removed");
  });

  it("never parks: retain removes a succeeded Codex run", async () => {
    const h = await codex();
    const handle = await h.launcher.launch(h.spec);
    await finish(h);
    expect(await h.launcher.retain(handle, { headSha: "a".repeat(40), fingerprint: "b".repeat(64) })).toBe(false);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("removed");
    expect(h.api.actors.size).toBe(0);
  });

  it("launches a Codex spec carrying warm cold, without looking for a park or recording a cold reason", async () => {
    for (const warmRounds of [undefined, { parkTtlMs: 60_000, parkMax: 2 }]) {
      const h = await makeHarness({ provider: "codex", ...(warmRounds ? { warmRounds } : {}) });
      const looked: string[] = [];
      const get = h.runs.get.bind(h.runs);
      h.runs.get = async (runId) => (looked.push(runId), get(runId));
      const warm = { fromRunId: "run-prior", headSha: "a".repeat(40), fingerprint: "b".repeat(64) };
      const handle = await h.launcher.launch({ ...h.spec, warm });
      expect(looked).not.toContain("run-prior");
      const record = await get(h.spec.runId);
      expect(record?.phase).toBe("running");
      expect(record?.actorShape).toBe("single");
      expect(record?.coldReason).toBeUndefined();
      expect(h.warmEvents).toEqual([]);
      expect(await h.launcher.warmOutcome(handle)).toBeUndefined();
      expect([...h.api.actors.keys()]).toEqual([`wardby-runs/${agentActorName(h.token)}`]);
    }
  });
});

/** Every file the blob store holds, with its contents. */
async function allBlobs(h: Harness): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, await readFile(path, "utf8"));
    }
  };
  await walk(join(h.root, "blobs"), "");
  return out;
}

describe("MCP tools", () => {
  const agentPolicy = (h: Harness) => h.api.egressPolicies.get(`${CONFIG.atespace}/${agentActorName(h.token)}`);
  const secretOf = (h: Harness) => h.secrets.secrets.get(`${CONFIG.credentialsNamespace}/${h.token}`);

  it("Claude Code: the agent's rule injects the MCP token, the tool's does not, and the Secret holds it", async () => {
    const h = await makeHarness({ mcpTokenFor: () => FAKE_MCP });
    await h.launcher.launch({ ...h.spec, mcpTools: true });
    expect(agentPolicy(h)).toEqual(agentEgress(h.token, CONFIG, { mcp: true }));
    expect(h.api.egressPolicies.get(`${CONFIG.atespace}/${toolActorName(h.token)}`)).toEqual(toolEgress(CONFIG));
    expect(secretOf(h)!.stringData).toEqual({ capability: FAKE_CAP, mcpToken: FAKE_MCP });
    // The templates are the same as without MCP tools: nothing per run, nothing MCP.
    const plain = await makeHarness();
    await plain.launcher.launch(plain.spec);
    expect([...h.api.templates.keys()].sort()).toEqual([...plain.api.templates.keys()].sort());
    expect(h.api.templates.size).toBe(2);
  });

  it("Codex (single): the one actor's rule injects it", async () => {
    const h = await makeHarness({ provider: "codex", mcpTokenFor: () => FAKE_MCP });
    await h.launcher.launch({ ...h.spec, mcpTools: true });
    expect(h.api.egressPolicies.size).toBe(1);
    expect(agentPolicy(h)).toEqual(agentEgress(h.token, CONFIG, { mcp: true }));
    expect(secretOf(h)!.stringData).toEqual({ capability: FAKE_CAP, mcpToken: FAKE_MCP });
    const plain = await makeHarness({ provider: "codex" });
    await plain.launcher.launch(plain.spec);
    expect([...h.api.templates.keys()]).toEqual([...plain.api.templates.keys()]);
  });

  it("without mcpTools the token is never asked for and nothing changes", async () => {
    for (const provider of ["claude-code", "codex"] as const) {
      const asked: string[] = [];
      const h = await makeHarness({ provider, mcpTokenFor: (id) => (asked.push(id), FAKE_MCP) });
      await h.launcher.launch(h.spec);
      expect(asked).toEqual([]);
      expect(secretOf(h)!.stringData).toEqual({ capability: FAKE_CAP });
      expect(secretOf(h)!.stringData).not.toHaveProperty("mcpToken");
      expect(agentPolicy(h)).toEqual(agentEgress(h.token, CONFIG));
    }
  });

  it.each([
    ["missing", undefined],
    ["not an MCP token", "rmt_short"],
    ["a capability", FAKE_CAP],
  ])("refuses an MCP token that is %s before any actor exists", async (_label, value) => {
    for (const provider of ["claude-code", "codex"] as const) {
      const h = await makeHarness({ provider, mcpTokenFor: () => value });
      const error = await h.launcher.launch({ ...h.spec, mcpTools: true }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toBe("substrate_mcp_token_invalid");
      if (value !== undefined) expect(error!.message).not.toContain(value);
      expect(h.api.actors.size).toBe(0);
      expect(h.api.templates.size).toBe(0);
      expect(h.api.egressPolicies.size).toBe(0);
      expect(h.secrets.secrets.size).toBe(0);
      expect((await h.runs.get(h.spec.runId))?.phase).toBe("provisioning_failed");
      expect(h.callFailures).toEqual([]);
    }
  });

  it("keeps the MCP token out of templates, policies, blobs, failure reports, events and logs", async () => {
    // Every server log line, as written (the logger writes to fd 2 directly, so process.stderr is not seen).
    const logs: string[] = [];
    setLogLineFilter((line) => (logs.push(line), line));
    const outputs: string[] = [];
    try {
      for (const provider of ["claude-code", "codex"] as const) {
        const h = await makeHarness({ provider, mcpTokenFor: () => FAKE_MCP });
        const calls = recordCalls(h);
        const spec = { ...h.spec, mcpTools: true as const };
        const handle = await h.launcher.launch(spec);
        expect(await h.launcher.status(handle)).toEqual({ state: "running" });
        // A failing Substrate call is reported too: its record carries no token.
        const failing = await makeHarness({ provider, mcpTokenFor: () => FAKE_MCP });
        const failingCalls = recordCalls(failing);
        failing.api.resumeActor = async () => {
          throw new SubstrateUnavailableError("substrate_unavailable");
        };
        await expect(failing.launcher.launch({ ...failing.spec, mcpTools: true })).rejects.toThrow();
        expect(failing.callFailures.length).toBeGreaterThan(0);
        // The same failure on a launcher without a sink goes to the server log: captured too.
        const logged = await makeHarness({ provider, mcpTokenFor: () => FAKE_MCP });
        (logged.launcher as unknown as { options: { onSubstrateCallFailed?: unknown } }).options.onSubstrateCallFailed =
          undefined;
        logged.api.resumeActor = async () => {
          throw new SubstrateUnavailableError("substrate_unavailable");
        };
        await expect(logged.launcher.launch({ ...logged.spec, mcpTools: true })).rejects.toThrow();
        outputs.push(
          JSON.stringify(calls),
          JSON.stringify(failingCalls),
          JSON.stringify(h.callFailures),
          JSON.stringify(failing.callFailures),
          JSON.stringify(h.warmEvents),
          JSON.stringify(failing.warmEvents),
          JSON.stringify([...h.api.templates.values(), ...h.api.egressPolicies.values()]),
          JSON.stringify(await h.runs.get(h.spec.runId)),
        );
        for (const harness of [h, failing]) for (const body of (await allBlobs(harness)).values()) outputs.push(body);
        // It is in the Secret (the only place).
        expect(JSON.stringify(secretOf(h))).toContain(FAKE_MCP);
      }
    } finally {
      setLogLineFilter((line) => line);
    }
    outputs.push(logs.join(""));
    for (const output of outputs) {
      expect(output).not.toContain(FAKE_MCP);
      expect(output).not.toContain(FAKE_CAP);
    }
    // The log capture is live: the failure was logged (when warn is enabled).
    if (logger.isLevelEnabled("warn")) expect(logs.join("")).toContain("substrate_call_failed");
  });

  it("remove() deletes the Secret, MCP token included", async () => {
    for (const provider of ["claude-code", "codex"] as const) {
      const h = await makeHarness({ provider, mcpTokenFor: () => FAKE_MCP });
      const handle = await h.launcher.launch({ ...h.spec, mcpTools: true });
      expect(h.secrets.secrets.size).toBe(1);
      await finish(h);
      await h.launcher.remove(handle);
      expect(h.secrets.secrets.size).toBe(0);
    }
  });
});

describe("extra repositories", () => {
  const REPOS = [
    { name: "extra-alpha", access: "write" },
    { name: "extra-beta", access: "read" },
  ] as const;
  const repos = () => REPOS.map((r) => ({ ...r }));
  const NO_HISTORY_LIST = [
    { name: "extra-alpha", access: "write" },
    { name: "extra-beta", access: "read" },
  ];

  /** Whether any seed of the run (the default one or an extra's) is in the blob store. */
  async function anySeed(h: Harness): Promise<boolean> {
    for (const key of [BLOB.seed(h.token), ...REPOS.map((r) => REPO_BLOB.seed(h.token, r.name))]) {
      if (await h.blobs.head(key)) return true;
    }
    return false;
  }

  const hasReposVolume = (template: { volumes: { name: string }[] } | undefined) =>
    template?.volumes.some((volume) => volume.name === "repos") ?? false;

  it("launches with a /repos volume on the tool actor, the default seed unchanged and one seed per extra", async () => {
    const h = await makeHarness({ repositories: repos() });
    await h.launcher.launch(h.spec);
    expect((await h.runs.get("run-1"))?.phase).toBe("running");
    expect(await blobKeys(h)).toEqual(["input", "toolSetup", "seed"]);
    for (const name of ["extra-alpha", "extra-beta"]) {
      expect((await h.blobs.get(REPO_BLOB.seed(h.token, name))).toString("latin1")).toContain(`# ${name}`);
    }
    const seed = (await h.blobs.get(BLOB.seed(h.token))).toString("latin1");
    expect(seed).toContain("# hello");
    expect(seed).not.toContain("# extra-alpha");
    const { repositories: _repositories, ...plain } = h.spec;
    const agent = agentTemplate(plain, CONFIG);
    const tool = toolTemplate(h.spec, CONFIG);
    expect(h.api.templates.get(`${CONFIG.atespace}/${agent.name}`)).toEqual(agent);
    expect(hasReposVolume(h.api.templates.get(`${CONFIG.atespace}/${tool.name}`))).toBe(true);
    expect(tool.name).not.toBe(toolTemplate(plain, CONFIG).name);
  });

  it("records names and access on the row, never the host path", async () => {
    const h = await makeHarness({ repositories: repos() });
    await h.launcher.launch(h.spec);
    const row = await h.runs.get("run-1");
    expect(row?.repositories).toEqual(REPOS);
    expect(JSON.stringify(row)).not.toContain(h.workspaceRoot);
  });

  it("lists the repositories in the tool setup, with a bundle only for a writable history extra", async () => {
    const history = await makeHarness({ repositories: repos() });
    await writeFile(
      history.spec.inputArtifact,
      JSON.stringify({
        schemaVersion: 1,
        task: "say hello",
        gitHistory: {
          repositories: [
            { path: "/workspace", baseCommit: "a".repeat(40), excludeCommits: [] },
            { path: "/repos/extra-alpha", baseCommit: "b".repeat(40), excludeCommits: [] },
          ],
        },
      }),
    );
    await history.launcher.launch(history.spec);
    const withHistory = (await history.blobs.get(BLOB.toolSetup(history.token))).toString();
    expect(JSON.parse(withHistory)).toMatchObject({
      repositories: [
        { name: "extra-alpha", access: "write", collectResultBundle: true },
        { name: "extra-beta", access: "read" },
      ],
      collectResultBundle: true,
    });
    expect(JSON.parse(withHistory).repositories[1]).not.toHaveProperty("collectResultBundle");
    expect(withHistory).not.toContain(history.workspaceRoot);

    const h = await makeHarness({ repositories: repos() });
    await h.launcher.launch(h.spec);
    const raw = (await h.blobs.get(BLOB.toolSetup(h.token))).toString();
    const setup = JSON.parse(raw) as { repositories: unknown };
    expect(setup.repositories).toEqual(NO_HISTORY_LIST);
    expect(setup).not.toHaveProperty("collectResultBundle");
    expect(raw).not.toContain(h.workspaceRoot);
  });

  it("Codex: the one actor gets the /repos volume and its setup the repositories", async () => {
    const h = await makeHarness({ provider: "codex", repositories: repos() });
    await h.launcher.launch(h.spec);
    const template = codexTemplate(h.spec, CONFIG);
    expect(hasReposVolume(h.api.templates.get(`${CONFIG.atespace}/${template.name}`))).toBe(true);
    expect(h.api.templates.size).toBe(1);
    const raw = (await h.blobs.get(BLOB.toolSetup(h.token))).toString();
    expect((JSON.parse(raw) as CodexWorkerSetup).repositories).toEqual(NO_HISTORY_LIST);
    expect(raw).not.toContain(h.workspaceRoot);
    for (const name of ["extra-alpha", "extra-beta"]) {
      expect((await h.blobs.get(REPO_BLOB.seed(h.token, name))).toString("latin1")).toContain(`# ${name}`);
    }
  });

  const valid = (h: Harness) => h.spec.repositories!;
  const MALFORMED: [string, (h: Harness) => unknown][] = [
    ["an empty list", () => []],
    ["a duplicate name", (h) => [valid(h)[0], { ...valid(h)[1], name: "extra-alpha" }]],
    ["the reserved name workspace", (h) => [{ ...valid(h)[0], name: "workspace" }]],
    ["an upper-case name", (h) => [{ ...valid(h)[0], name: "Extra" }]],
    [
      "17 entries",
      (h) =>
        Array.from({ length: 17 }, (_, i) => ({
          name: `extra-${i}`,
          access: "read",
          hostPath: join(h.workspaceRoot, "run-1", "repos", `extra-${i}`, "workspace"),
        })),
    ],
    ["an entry with a ref", (h) => [{ ...valid(h)[0], ref: "main" }]],
    ["an unknown access", (h) => [{ ...valid(h)[0], access: "admin" }]],
  ];

  it.each(MALFORMED)("refuses a malformed repository list before any side effect: %s", async (_label, list) => {
    for (const provider of ["claude-code", "codex"] as const) {
      const h = await makeHarness({ provider, repositories: repos() });
      const calls = recordCalls(h);
      const spec = { ...h.spec, repositories: list(h) as JobSpec["repositories"] };
      await expect(h.launcher.launch(spec)).rejects.toThrow("substrate_spec_invalid");
      expect(h.launcher.plannedHandle(spec)).toBeUndefined();
      expect(await h.runs.get("run-1")).toBeUndefined();
      expect(h.api.templates.size).toBe(0);
      expect(calls).toEqual([]);
      expect(await blobKeys(h)).toEqual([]);
    }
  });

  const MISPLACED: [string, (h: Harness) => string][] = [
    ["another run's folder", (h) => join(h.workspaceRoot, "run-2", "repos", "extra-alpha", "workspace")],
    ["the run's own workspace", (h) => join(h.workspaceRoot, "run-1", "workspace")],
    ["another extra's folder", (h) => join(h.workspaceRoot, "run-1", "repos", "extra-beta", "workspace")],
    ["a relative path", () => "repos/extra-alpha/workspace"],
  ];

  it.each(MISPLACED)(
    "refuses a host path that is not the run's own repos/<name>/workspace: %s",
    async (_label, hostPath) => {
      for (const provider of ["claude-code", "codex"] as const) {
        const h = await makeHarness({ provider, repositories: repos() });
        const [alpha, beta] = valid(h);
        const spec = { ...h.spec, repositories: [{ ...alpha, hostPath: hostPath(h) }, beta] };
        await expect(h.launcher.launch(spec)).rejects.toThrow("substrate_workspace_path_invalid");
        expect(await h.runs.get("run-1")).toBeUndefined();
        expect(h.api.templates.size).toBe(0);
        expect(await blobKeys(h)).toEqual([]);
        expect(await anySeed(h)).toBe(false);
      }
    },
  );

  it("fails provisioning when an extra's prepared folder is missing, and leaves no blob", async () => {
    const h = await makeHarness({ repositories: repos() });
    await rm(join(h.workspaceRoot, "run-1", "repos", "extra-beta"), { recursive: true, force: true });
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("substrate_seed_failed");
    expect((await h.runs.get("run-1"))?.phase).toBe("provisioning_failed");
    expect(h.api.actors.size).toBe(0);
    expect(await anySeed(h)).toBe(false);
    expect(await blobKeys(h)).toEqual([]);
  });

  it("shares one disk budget across the default repository and the extras", async () => {
    const MiB = 1024 * 1024;
    const alone = await makeHarness({ repositories: repos() });
    await writeFile(join(alone.workspaceRoot, "run-1", "workspace", "big.bin"), Buffer.alloc(40 * MiB));
    await alone.launcher.launch(alone.spec);
    expect((await alone.runs.get("run-1"))?.phase).toBe("running");

    const h = await makeHarness({ repositories: repos() });
    expect(h.spec.limits.diskMb).toBe(64);
    await writeFile(join(h.workspaceRoot, "run-1", "workspace", "big.bin"), Buffer.alloc(40 * MiB));
    await writeFile(
      join(h.workspaceRoot, "run-1", "repos", "extra-alpha", "workspace", "big.bin"),
      Buffer.alloc(30 * MiB),
    );
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("substrate_seed_too_large");
    expect(h.api.actors.size).toBe(0);
    expect(await anySeed(h)).toBe(false);
  });
});
