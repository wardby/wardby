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
import { codexWorkerSetup, type CodexWorkerSetup } from "../codex-worker-setup.js";
import { deriveSnapshotKey, newBlobKey } from "../../coding-proxy/dependency-cache/key.js";
import { JobCapacityError, type JobSpec } from "../types.js";
import { SubstrateExhaustedError, SubstrateNotFoundError, SubstrateUnavailableError, type WorkerInfo } from "./api.js";
import { DEFAULT_TEMPLATE_TTL_MS, inputGitHistory, templateTtlFloorMs } from "./launcher.js";
import { agentEgress, agentTemplate, BRIDGE_COMMANDS, codexTemplate, toolEgress, toolTemplate } from "./specs.js";
import {
  allBlobs,
  ATESPACE,
  CODEX_IMAGE,
  CONFIG,
  CUSTOM_CODEX_IMAGE,
  CUSTOM_TOOL_IMAGE,
  FAKE_CAP,
  FAKE_MCP,
  LOCAL_IMAGE_ID,
  makeHarness,
  PYTHON_TOOL_IMAGE,
  SMALL_WORKER,
  TOOL_IMAGE,
  type Harness,
} from "./launcher.test-support.js";
import { BLOB, BRIDGE_PROTOCOL_HEADER, REPO_BLOB, agentActorName, substrateRunToken, toolActorName } from "./names.js";
import { MemorySubstrateRunStore, type SubstrateRunRecord } from "./run-store.js";
import { MemorySubstrateTemplateStore } from "./template-store.js";

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
  "bridgeRefused",
  "imageIncomplete",
  "services",
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

/** Posts these files as a named extra's workspace tar (REPO_BLOB.workspace) for round `round`. */
async function putRepoWorkspaceTar(h: Harness, name: string, files: Record<string, string>, round = 1): Promise<void> {
  const source = await mkdtemp(join(tmpdir(), "wardby-substrate-repo-ws-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(source, file, ".."), { recursive: true });
    await writeFile(join(source, file), content);
  }
  const archive = hostTarArchive(source);
  await h.blobs.putStream(REPO_BLOB.workspace(h.token, name, round), archive.stream);
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

jobLauncherContract(
  "substrate with the dependency cache",
  async () => {
    const h = await makeHarness();
    return {
      launcher: h.launcher,
      spec: { ...h.spec, dependencyCache: true },
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
      spec: { ...h.spec, dependencyCache: true },
      destination: join(h.workspaceRoot, h.spec.runId, "workspace"),
      finish: (handle) => finish({ ...h, token: handle.id.split("/")[1] }),
      fillJobWorkspace: (handle, files) => putWorkspaceTarFor(h, handle.id.split("/")[1], files),
    };
  },
);

jobLauncherContract(
  "substrate codex with the dependency cache",
  async () => {
    const h = await makeHarness({ provider: "codex" });
    return {
      launcher: h.launcher,
      spec: { ...h.spec, dependencyCache: true },
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
      spec: { ...h.spec, dependencyCache: true },
      destination: join(h.workspaceRoot, h.spec.runId, "workspace"),
      finish: (handle) => finish({ ...h, token: handle.id.split("/")[1] }),
      fillJobWorkspace: (handle, files) => putWorkspaceTarFor(h, handle.id.split("/")[1], files),
    };
  },
);

const CONTRACT_REPOS = [
  { name: "extra-alpha", access: "write" as const },
  { name: "extra-beta", access: "read" as const },
];

// The shared suite has no named-repository case (on any backend): this proves the default
// repository's contract is unchanged on a spec with extras; the named cases are under "extra repositories".
jobLauncherContract(
  "substrate with extra repositories",
  async () => {
    const h = await makeHarness({ repositories: CONTRACT_REPOS.map((r) => ({ ...r })) });
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
    const h = await makeHarness({ repositories: CONTRACT_REPOS.map((r) => ({ ...r })) });
    return {
      launcher: h.launcher,
      spec: h.spec,
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
      [{ toolImage: LOCAL_IMAGE_ID }, "substrate_image_not_digest"],
    ];
    for (const [change, code] of cases) {
      await expect(h.launcher.launch({ ...h.spec, ...change })).rejects.toThrow(code);
      expect(h.launcher.plannedHandle({ ...h.spec, ...change })).toBeUndefined();
    }
    expect(await h.runs.get(h.spec.runId)).toBeUndefined();
    expect(h.api.templates.size).toBe(0);
    // Session resume is accepted, and so is another configured (per-toolchain) tool image.
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
    expect(inputGitHistory(Buffer.from(JSON.stringify({ gitHistory: { repositories: [] } }))).requested).toBe(true);
    for (const input of ["{}", '{"gitHistory":null}', '{"gitHistory":true}', "[]", "null", "not json"]) {
      expect(inputGitHistory(Buffer.from(input)).requested).toBe(false);
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
      // The proxy's routes on the same blob store, reading the layout from the run's row.
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
        runLayoutForToken: async (token) => {
          const record = await h.runs.get(h.spec.runId);
          return { shape: record?.token === token && record.actorShape === "single" ? "single" : "pair" };
        },
        limits: { resultBytes: 1024, transcriptBytes: 1024, workspaceBytes: 1024 },
        log: { info: () => undefined, warn: () => undefined },
      });
      const server = createServer((req, res) => void routes(req, res));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/substrate/runs/${h.token}`;
        const setup = await fetch(`${base}/tool-setup`, {
          headers: { "x-api-key": FAKE_CAP, [BRIDGE_PROTOCOL_HEADER]: "1" },
        });
        expect(setup.status).toBe(200);
        await setup.arrayBuffer();
        const input = await fetch(`${base}/input`, {
          headers: { "x-api-key": FAKE_CAP, [BRIDGE_PROTOCOL_HEADER]: "1" },
        });
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
      [{ image: LOCAL_IMAGE_ID }, "substrate_image_not_digest"],
      [{ services: [] }, "substrate_feature_unsupported:services"],
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

  const repoFolder = (h: Harness, name: string) => join(h.workspaceRoot, "run-1", "repos", name, "workspace");
  const defaultFolder = (h: Harness) => join(h.workspaceRoot, "run-1", "workspace");
  const underToken = async (h: Harness) =>
    [...(await allBlobs(h)).keys()].filter((key) => key.startsWith(`substrate/runs/${h.token}/`));

  it("collects a writable extra into its own folder", async () => {
    const h = await makeHarness({ repositories: repos() });
    const handle = await h.launcher.launch(h.spec);
    await putRepoWorkspaceTar(h, "extra-alpha", { "README.md": "# changed alpha\n" });
    await finish(h);
    expect(await h.launcher.materializeWorkspace(handle, repoFolder(h, "extra-alpha"), "extra-alpha")).toEqual({
      bundle: false,
    });
    expect(await readFile(join(repoFolder(h, "extra-alpha"), "README.md"), "utf8")).toBe("# changed alpha\n");
    expect(await readFile(join(defaultFolder(h), "README.md"), "utf8")).toBe("# hello\n");
  });

  const REFUSED: [string, string, (h: Harness) => string][] = [
    ["a read extra to its own folder", "extra-beta", (h) => repoFolder(h, "extra-beta")],
    ["an unknown name", "extra-gamma", (h) => join(h.workspaceRoot, "run-1", "repos", "extra-gamma", "workspace")],
    ["a writable extra to the default workspace", "extra-alpha", defaultFolder],
    ["a writable extra to another extra's folder", "extra-alpha", (h) => repoFolder(h, "extra-beta")],
  ];

  it.each(REFUSED)(
    "refuses a named collection that is not a writable extra's own: %s",
    async (_label, name, destination) => {
      const h = await makeHarness({ repositories: repos() });
      const handle = await h.launcher.launch(h.spec);
      for (const r of [...REPOS, { name: "extra-gamma" }]) {
        await putRepoWorkspaceTar(h, r.name, { "README.md": "# changed\n" });
      }
      // Before the run finishes, job_not_succeeded comes first.
      await expect(h.launcher.materializeWorkspace(handle, destination(h), name)).rejects.toThrow("job_not_succeeded");
      await finish(h);
      await expect(h.launcher.materializeWorkspace(handle, destination(h), name)).rejects.toThrow(
        "substrate_workspace_destination_invalid",
      );
      // Nothing was written anywhere.
      expect(await readFile(join(defaultFolder(h), "README.md"), "utf8")).toBe("# hello\n");
      for (const r of REPOS) {
        expect(await readFile(join(repoFolder(h, r.name), "README.md"), "utf8")).toBe(`# ${r.name}\n`);
      }
      await expect(lstat(join(h.workspaceRoot, "run-1", "repos", "extra-gamma"))).rejects.toThrow(/ENOENT/);
    },
  );

  it("fails only that repository when its upload is missing", async () => {
    const h = await makeHarness({ repositories: repos() });
    const handle = await h.launcher.launch(h.spec);
    await finish(h);
    await expect(h.launcher.materializeWorkspace(handle, repoFolder(h, "extra-alpha"), "extra-alpha")).rejects.toThrow(
      "substrate_workspace_missing",
    );
    expect(await readFile(join(repoFolder(h, "extra-alpha"), "README.md"), "utf8")).toBe("# extra-alpha\n");
    await putWorkspaceTar(h, { "README.md": "# changed\n" });
    expect(await h.launcher.materializeWorkspace(handle, defaultFolder(h))).toEqual({ bundle: false });
    expect(await readFile(join(defaultFolder(h), "README.md"), "utf8")).toBe("# changed\n");
  });

  it("takes a history extra's bundle and refuses a nested .git", async () => {
    const tree = {
      "README.md": "# changed alpha\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/wardby-result.bundle": "# v2 git bundle\n",
    };
    const h = await makeHarness({ repositories: repos() });
    const handle = await h.launcher.launch(h.spec);
    await putRepoWorkspaceTar(h, "extra-alpha", tree);
    await finish(h);
    const trusted = await mkdtemp(join(tmpdir(), "wardby-substrate-bundle-"));
    const bundleDestination = join(trusted, "result.bundle");
    const gitHistory = { bundleDestination, maxBundleBytes: 1024 };
    expect(
      await h.launcher.materializeWorkspace(handle, repoFolder(h, "extra-alpha"), "extra-alpha", { gitHistory }),
    ).toEqual({ bundle: true });
    expect(await readFile(bundleDestination, "utf8")).toBe("# v2 git bundle\n");
    expect(await readFile(join(repoFolder(h, "extra-alpha"), "README.md"), "utf8")).toBe("# changed alpha\n");
    await expect(lstat(join(repoFolder(h, "extra-alpha"), ".git"))).rejects.toThrow(/ENOENT/);

    const nested = await makeHarness({ repositories: repos() });
    const nestedHandle = await nested.launcher.launch(nested.spec);
    await putRepoWorkspaceTar(nested, "extra-alpha", { ...tree, "vendor/x/.git/HEAD": "ref: refs/heads/main\n" });
    await finish(nested);
    const nestedBundle = join(trusted, "nested.bundle");
    await expect(
      nested.launcher.materializeWorkspace(nestedHandle, repoFolder(nested, "extra-alpha"), "extra-alpha", {
        gitHistory: { bundleDestination: nestedBundle, maxBundleBytes: 1024 },
      }),
    ).rejects.toThrow("docker_workspace_nested_repository");
    await expect(lstat(nestedBundle)).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(repoFolder(nested, "extra-alpha"), "README.md"), "utf8")).toBe("# extra-alpha\n");
  });

  it("never reads a read extra's blob", async () => {
    const h = await makeHarness({ repositories: repos() });
    const handle = await h.launcher.launch(h.spec);
    await putRepoWorkspaceTar(h, "extra-beta", { "README.md": "# changed beta\n" });
    await finish(h);
    const read: string[] = [];
    const getStream = h.blobs.getStream.bind(h.blobs);
    const get = h.blobs.get.bind(h.blobs);
    const head = h.blobs.head.bind(h.blobs);
    h.blobs.getStream = async (key) => (read.push(key), getStream(key));
    h.blobs.get = async (key) => (read.push(key), get(key));
    h.blobs.head = async (key) => (read.push(key), head(key));
    await expect(h.launcher.materializeWorkspace(handle, repoFolder(h, "extra-beta"), "extra-beta")).rejects.toThrow(
      "substrate_workspace_destination_invalid",
    );
    expect(read.length).toBeGreaterThan(0);
    for (const key of read) expect(key).not.toContain("/repos/extra-beta/");
  });

  it("removes every per-repository blob, of every round, and keeps none after a stop", async () => {
    const h = await makeHarness({ repositories: repos() });
    const handle = await h.launcher.launch(h.spec);
    for (const r of REPOS) {
      expect(await h.blobs.head(REPO_BLOB.seed(h.token, r.name))).not.toBeNull();
      await putRepoWorkspaceTar(h, r.name, { "README.md": `# changed ${r.name}\n` });
    }
    await putWorkspaceTar(h, { "README.md": "# changed\n" });
    await finish(h);
    expect((await underToken(h)).some((key) => key.includes("/repos/"))).toBe(true);
    await h.launcher.remove(handle);
    expect(await underToken(h)).toEqual([]);
    expect((await h.runs.get("run-1"))?.phase).toBe("removed");

    const stopped = await makeHarness({ repositories: repos() });
    const stoppedHandle = await stopped.launcher.launch(stopped.spec);
    await putRepoWorkspaceTar(stopped, "extra-alpha", { "README.md": "# partial\n" });
    await stopped.launcher.stop(stoppedHandle, "cancelled");
    await stopped.launcher.remove(stoppedHandle);
    expect(await underToken(stopped)).toEqual([]);
    expect(stopped.api.actors.size).toBe(0);
  });

  it("cleans up per-repository seeds when provisioning fails late", async () => {
    const h = await makeHarness({ repositories: repos() });
    h.api.resumeActor = async () => {
      throw new SubstrateUnavailableError("substrate_unavailable");
    };
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(SubstrateUnavailableError);
    expect((await h.runs.get("run-1"))?.phase).toBe("provisioning_failed");
    for (const r of REPOS) expect(await h.blobs.head(REPO_BLOB.seed(h.token, r.name))).toBeNull();
    expect(await anySeed(h)).toBe(false);
  });

  it("Codex: collects and removes extras the same way", async () => {
    const h = await makeHarness({ provider: "codex", repositories: repos() });
    const handle = await h.launcher.launch(h.spec);
    await putRepoWorkspaceTar(h, "extra-alpha", { "README.md": "# changed alpha\n" });
    await finish(h);
    expect(await h.launcher.materializeWorkspace(handle, repoFolder(h, "extra-alpha"), "extra-alpha")).toEqual({
      bundle: false,
    });
    expect(await readFile(join(repoFolder(h, "extra-alpha"), "README.md"), "utf8")).toBe("# changed alpha\n");
    await expect(h.launcher.materializeWorkspace(handle, repoFolder(h, "extra-beta"), "extra-beta")).rejects.toThrow(
      "substrate_workspace_destination_invalid",
    );
    await h.launcher.remove(handle);
    expect(await underToken(h)).toEqual([]);
  });

  it("logs a fixed event, and still removes the rest, when the row's repositories cannot be read", async () => {
    const store = new MemorySubstrateRunStore(() => 1_000_000);
    const h = await makeHarness({ repositories: repos(), runs: store });
    const handle = await h.launcher.launch(h.spec);
    await finish(h);
    // What the database store gives for a stored value that does not parse.
    const get = store.get.bind(store);
    const getByToken = store.getByToken.bind(store);
    const unreadable = (record: SubstrateRunRecord | undefined): SubstrateRunRecord | undefined => {
      if (!record) return record;
      const { repositories: _dropped, ...rest } = record;
      return { ...rest, repositoriesUnreadable: true };
    };
    store.get = async (runId) => unreadable(await get(runId));
    store.getByToken = async (token) => unreadable(await getByToken(token));
    const lines: string[] = [];
    setLogLineFilter((line) => (lines.push(line), line));
    try {
      await h.launcher.remove(handle);
    } finally {
      setLogLineFilter((line) => line);
    }
    expect((await get("run-1"))?.phase).toBe("removed");
    for (const kind of BLOB_KINDS) expect(await h.blobs.head(BLOB[kind](h.token))).toBeNull();
    if (logger.isLevelEnabled("warn")) {
      const event = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.msg === "substrate_run_repositories_unreadable");
      expect(event).toMatchObject({ runId: "run-1" });
      expect(JSON.stringify(event)).not.toContain("extra-");
    }
  });
});

describe("dependency cache", () => {
  const CACHE_KEY = newBlobKey(
    deriveSnapshotKey({
      repository: "owner/repo",
      projectPath: ".",
      lockHash: "c".repeat(64),
      workerImage: TOOL_IMAGE,
    }),
  );

  async function cacheHarness(): Promise<Harness> {
    const h = await makeHarness();
    h.spec = { ...h.spec, dependencyCache: true };
    await h.blobs.put(CACHE_KEY, Buffer.from("snapshot"));
    return h;
  }

  async function expectCacheKept(h: Harness): Promise<void> {
    expect((await h.blobs.get(CACHE_KEY)).toString()).toBe("snapshot");
    expect([...(await allBlobs(h)).keys()].filter((key) => key.startsWith(`substrate/runs/${h.token}/`))).toEqual([]);
  }

  it("launches a Claude Code cache run: the tool setup carries dependencyCache and diskMb, never workspaceReused", async () => {
    const h = await makeHarness();
    h.spec = { ...h.spec, dependencyCache: true };
    await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");
    const setup = JSON.parse((await h.blobs.get(BLOB.toolSetup(h.token))).toString()) as { toolSetup: string };
    const toolSetup = JSON.parse(setup.toolSetup) as Record<string, unknown>;
    expect(toolSetup.dependencyCache).toBe(true);
    expect(toolSetup.diskMb).toBe(64);
    expect(toolSetup).not.toHaveProperty("workspaceReused");
    expect(setup.toolSetup).toContain(deriveRegistryToken(FAKE_CAP));
    expect(setup.toolSetup).not.toContain(FAKE_CAP);
  });

  it("the cache changes no template", async () => {
    const claude = await makeHarness();
    const codex = await makeHarness({ provider: "codex" });
    expect(agentTemplate({ ...claude.spec, dependencyCache: true }, CONFIG)).toEqual(
      agentTemplate(claude.spec, CONFIG),
    );
    expect(toolTemplate({ ...claude.spec, dependencyCache: true }, CONFIG)).toEqual(toolTemplate(claude.spec, CONFIG));
    expect(codexTemplate({ ...codex.spec, dependencyCache: true }, CONFIG)).toEqual(codexTemplate(codex.spec, CONFIG));
  });

  it("launches a Codex cache run: setup and input unchanged", async () => {
    const h = await makeHarness({ provider: "codex" });
    const withoutCache = h.spec;
    h.spec = { ...h.spec, dependencyCache: true };
    const input = JSON.stringify({ schemaVersion: 1, task: "say hello", dependencyCache: true, diskMb: 64 });
    await writeFile(h.spec.inputArtifact, input);
    await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");
    expect(withoutCache).not.toHaveProperty("dependencyCache");
    expect((await h.blobs.get(BLOB.toolSetup(h.token))).toString()).toBe(
      codexWorkerSetup(withoutCache, FAKE_CAP, { collectResultBundle: false }),
    );
    expect((await h.blobs.get(BLOB.input(h.token))).toString()).toBe(await readFile(h.spec.inputArtifact, "utf8"));
    expect((await h.blobs.get(BLOB.input(h.token))).toString()).toBe(input);
  });

  it("never deletes a dependency-cache object: remove, stop then remove, and a failed launch's cleanup", async () => {
    const removed = await cacheHarness();
    const removedHandle = await removed.launcher.launch(removed.spec);
    await finish(removed);
    await removed.launcher.remove(removedHandle);
    await expectCacheKept(removed);

    const stopped = await cacheHarness();
    const stoppedHandle = await stopped.launcher.launch(stopped.spec);
    await stopped.launcher.stop(stoppedHandle);
    await stopped.launcher.remove(stoppedHandle);
    await expectCacheKept(stopped);

    const failed = await cacheHarness();
    failed.api.resumeActor = async () => {
      throw new SubstrateUnavailableError("substrate_unavailable");
    };
    await expect(failed.launcher.launch(failed.spec)).rejects.toBeInstanceOf(SubstrateUnavailableError);
    expect((await failed.runs.get(failed.spec.runId))?.phase).toBe("provisioning_failed");
    await expectCacheKept(failed);
  });
});

describe("bridge protocol", () => {
  const START = 1_000_000;
  const refuse = (h: Harness) => h.blobs.put(BLOB.bridgeRefused(h.token), Buffer.from('{"protocol":null}'));
  const INCOMPATIBLE = { exitCode: 1, reason: "failed", diagnostic: "substrate_bridge_incompatible" };

  it("fails a running run whose bridge was refused, and deletes its actors", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    expect(h.api.actors.size).toBe(2);
    await refuse(h);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual(INCOMPATIBLE);
    expect((await h.runs.get("run-1"))?.phase).toBe("bridge_incompatible");
    expect(h.api.actors.size).toBe(0);
    // Recorded: the same answer again, with the actors gone.
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual(INCOMPATIBLE);
  });

  it("decides before the startup timeout", async () => {
    const h = await makeHarness({ startupTimeoutMs: 1_000 });
    const handle = await h.launcher.launch(h.spec);
    h.setNow(START + 5_000);
    await refuse(h);
    expect((await h.launcher.collect(handle)).diagnostic).toBe("substrate_bridge_incompatible");
    expect((await h.runs.get("run-1"))?.phase).toBe("bridge_incompatible");
  });

  it("a reported success still wins", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await finish(h);
    await refuse(h);
    expect(await h.launcher.status(handle)).toEqual({ state: "succeeded" });
  });

  it("remove deletes the refusal with the run's other files", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await refuse(h);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    await h.launcher.remove(handle);
    expect([...(await allBlobs(h)).keys()].filter((key) => key.startsWith(`substrate/runs/${h.token}/`))).toEqual([]);
  });

  it("fails a Codex run the same way, deleting its one actor", async () => {
    const h = await makeHarness({ provider: "codex" });
    const handle = await h.launcher.launch(h.spec);
    expect(h.api.actors.size).toBe(1);
    await refuse(h);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual(INCOMPATIBLE);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("bridge_incompatible");
    expect(h.api.actors.size).toBe(0);
  });
});

describe("image self-check", () => {
  const report = (h: Harness, item: string) =>
    h.blobs.put(BLOB.imageIncomplete(h.token), Buffer.from(JSON.stringify({ item })));

  it.each(["user", "runner", "tar", "workspace", "run_dir"])(
    "fails a %s report with its item, and deletes the actors",
    async (item) => {
      const h = await makeHarness();
      const handle = await h.launcher.launch(h.spec);
      expect(h.api.actors.size).toBe(2);
      await report(h, item);
      expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
      expect(await h.launcher.collect(handle)).toEqual({
        exitCode: 1,
        reason: "failed",
        diagnostic: `substrate_image_incomplete:${item}`,
      });
      expect((await h.runs.get("run-1"))?.phase).toBe("image_incomplete");
      expect(h.api.actors.size).toBe(0);
    },
  );

  it("never puts free text in the run's result", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    // Written straight to the store, past the proxy's check.
    await report(h, FAKE_CAP);
    const result = await h.launcher.collect(handle);
    expect(result).toEqual({ exitCode: 1, reason: "failed", diagnostic: "substrate_image_incomplete" });
    expect(JSON.stringify(await h.launcher.collect(handle))).not.toContain(FAKE_CAP);
  });

  it("ignores an unreadable report's content", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await h.blobs.put(BLOB.imageIncomplete(h.token), Buffer.from("not json"));
    expect((await h.launcher.collect(handle)).diagnostic).toBe("substrate_image_incomplete");
  });

  it("decides before the startup timeout", async () => {
    const h = await makeHarness({ startupTimeoutMs: 1_000 });
    const handle = await h.launcher.launch(h.spec);
    h.setNow(1_000_000 + 5_000);
    await report(h, "tar");
    expect((await h.launcher.collect(handle)).diagnostic).toBe("substrate_image_incomplete:tar");
  });

  it("Codex: the same", async () => {
    const h = await makeHarness({ provider: "codex" });
    const handle = await h.launcher.launch(h.spec);
    expect(h.api.actors.size).toBe(1);
    await report(h, "runner");
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "substrate_image_incomplete:runner",
    });
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("image_incomplete");
    expect(h.api.actors.size).toBe(0);
  });

  it("remove deletes the report", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await report(h, "workspace");
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    await h.launcher.remove(handle);
    expect([...(await allBlobs(h)).keys()].filter((key) => key.startsWith(`substrate/runs/${h.token}/`))).toEqual([]);
  });

  it("remove keeps the report with the outcome until every other deletion succeeds", async () => {
    const h = await makeHarness();
    const handle = await h.launcher.launch(h.spec);
    await report(h, "workspace");
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    const deleteActor = h.api.deleteActor.bind(h.api);
    let fail = true;
    h.api.deleteActor = async (atespace, name) => {
      if (fail && name === agentActorName(h.token)) throw new SubstrateUnavailableError("substrate_unavailable");
      return deleteActor(atespace, name);
    };
    await expect(h.launcher.remove(handle)).rejects.toThrow("substrate_unavailable");
    expect(await blobKeys(h)).toContain("imageIncomplete");
    expect((await h.launcher.collect(handle)).diagnostic).toBe("substrate_image_incomplete:workspace");
    fail = false;
    await h.launcher.remove(handle);
    expect(await blobKeys(h)).toEqual([]);
  });
});

describe("custom images (workerImageRef)", () => {
  it("launches a Claude Code run on a custom tool image, the agent on the configured one", async () => {
    const h = await makeHarness();
    const standard = h.spec;
    h.spec = { ...h.spec, toolImage: CUSTOM_TOOL_IMAGE };
    const handle = await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");
    const tool = h.api.actors.get(`${ATESPACE}/${toolActorName(h.token)}`);
    expect(tool?.templateName).toBe(toolTemplate(h.spec, CONFIG).name);
    expect(h.api.templates.get(`${ATESPACE}/${tool!.templateName}`)?.containers[0]?.image).toBe(CUSTOM_TOOL_IMAGE);
    // The bridge runs whatever the custom image's ENTRYPOINT is (ruling D5).
    expect(h.api.templates.get(`${ATESPACE}/${tool!.templateName}`)?.containers[0]?.command).toEqual(
      BRIDGE_COMMANDS.tool,
    );
    // The agent actor never takes the custom image: its template is the unchanged spec's.
    const agent = h.api.actors.get(`${ATESPACE}/${agentActorName(h.token)}`);
    const expectedAgent = agentTemplate(standard, CONFIG);
    expect(agent?.templateName).toBe(expectedAgent.name);
    expect(h.api.templates.get(`${ATESPACE}/${agent!.templateName}`)).toEqual(expectedAgent);
    expect(expectedAgent.containers[0]?.image).toBe(`registry.example/agent@sha256:${"a".repeat(64)}`);
    await putWorkspaceTar(h, { "README.md": "# custom\n" });
    await finish(h);
    expect(await h.launcher.status(handle)).toEqual({ state: "succeeded" });
    const destination = join(h.workspaceRoot, h.spec.runId, "workspace");
    await h.launcher.materializeWorkspace(handle, destination);
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("# custom\n");
  });

  it("launches a Codex run on a custom image", async () => {
    const h = await makeHarness({ provider: "codex" });
    h.spec = { ...h.spec, image: CUSTOM_CODEX_IMAGE };
    await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");
    expect(h.api.actors.size).toBe(1);
    const actor = h.api.actors.get(`${ATESPACE}/${agentActorName(h.token)}`);
    expect(actor?.templateName).toBe(codexTemplate(h.spec, CONFIG).name);
    expect(h.api.templates.get(`${ATESPACE}/${actor!.templateName}`)?.containers[0]?.image).toBe(CUSTOM_CODEX_IMAGE);
    expect(h.api.templates.get(`${ATESPACE}/${actor!.templateName}`)?.containers[0]?.command).toEqual(
      BRIDGE_COMMANDS.codex,
    );
  });

  it.each([
    ["Claude Code toolImage", "claude-code", { toolImage: LOCAL_IMAGE_ID }],
    ["Claude Code image", "claude-code", { image: LOCAL_IMAGE_ID }],
    ["Codex image", "codex", { image: LOCAL_IMAGE_ID }],
  ] as const)("refuses a local image ID: %s", async (_label, provider, change) => {
    const h = await makeHarness(provider === "codex" ? { provider: "codex" } : {});
    const spec: JobSpec = { ...h.spec, ...change };
    await expect(h.launcher.launch(spec)).rejects.toThrow("substrate_image_not_digest");
    expect(h.launcher.plannedHandle(spec)).toBeUndefined();
    expect(await h.runs.get(spec.runId)).toBeUndefined();
    expect(h.api.templates.size).toBe(0);
  });

  it("launches a run dispatched on a tool image the deployment no longer configures", async () => {
    for (const toolImage of [PYTHON_TOOL_IMAGE, `registry.example/old-tool@sha256:${"7".repeat(64)}`]) {
      const h = await makeHarness();
      h.spec = { ...h.spec, toolImage };
      await expect(h.launcher.launch(h.spec)).resolves.toBeDefined();
      expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");
    }
  });

  it("capacity is the same for a custom image", async () => {
    const small = await makeHarness({ workers: 1, workerSize: SMALL_WORKER });
    const smallCustom = { ...small.spec, toolImage: CUSTOM_TOOL_IMAGE };
    expect(await small.launcher.hasCapacityFor(smallCustom)).toBe(await small.launcher.hasCapacityFor(small.spec));
    expect(await small.launcher.hasCapacityFor(smallCustom)).toBe(false);
    const h = await makeHarness();
    const custom = { ...h.spec, toolImage: CUSTOM_TOOL_IMAGE };
    expect(await h.launcher.hasCapacityFor(custom)).toBe(await h.launcher.hasCapacityFor(h.spec));
    expect(await h.launcher.hasCapacityFor(custom)).toBe(true);
  });

  it("nothing emits the workerImage refusal", async () => {
    const source = await readFile(new URL("./launcher.ts", import.meta.url), "utf8");
    expect(source).not.toContain("substrate_feature_unsupported:workerImage");
    expect(source).not.toContain(":workerImage");
  });
});

describe("template record and readiness", () => {
  const T0 = 1_000_000;
  const MINUTE = 60_000;
  const EVENT_FIELDS = ["event", "name", "role", "failures", "reason", "ageSec"];

  /** Another run's spec on the same launcher: its own input and workspace, the same templates. */
  async function secondRun(h: Harness, runId: string): Promise<JobSpec> {
    await mkdir(join(h.workspaceRoot, runId, "workspace"), { recursive: true });
    await writeFile(join(h.workspaceRoot, runId, "workspace", "README.md"), "# hello\n");
    const inputArtifact = join(h.root, `input-${runId}.json`);
    await writeFile(inputArtifact, JSON.stringify({ schemaVersion: 1, task: `task of ${runId}` }));
    return { ...h.spec, runId, inputArtifact };
  }

  /** Counts deleteActorTemplate calls from here on. */
  function countTemplateDeletes(h: Harness): { names: string[] } {
    const seen = { names: [] as string[] };
    const original = h.api.deleteActorTemplate.bind(h.api);
    h.api.deleteActorTemplate = async (atespace, name) => {
      seen.names.push(name);
      return original(atespace, name);
    };
    return seen;
  }

  /** resumeActor refuses the tool actor of every run, as a full cluster would (the workers still list room). */
  function refuseToolResume(h: Harness): void {
    const original = h.api.resumeActor.bind(h.api);
    h.api.resumeActor = async (atespace, name) => {
      if (name.endsWith("-tool")) throw new SubstrateExhaustedError("no worker has room");
      return original(atespace, name);
    };
  }

  async function noTraceOf(h: Harness, runId: string): Promise<void> {
    const token = substrateRunToken(runId);
    expect([...h.api.actors.keys()].filter((key) => key.includes(token))).toEqual([]);
    expect([...h.secrets.secrets.keys()].filter((key) => key.includes(token))).toEqual([]);
    expect([...(await allBlobs(h)).keys()].filter((key) => key.includes(token))).toEqual([]);
  }

  it("records each template it ensures and marks it ready once a run reaches running", async () => {
    const h = await makeHarness();
    await h.launcher.launch(h.spec);
    const at = new Date(T0);
    const agent = await h.templates.get(agentTemplate(h.spec, CONFIG).name);
    expect(agent).toEqual({
      name: agentTemplate(h.spec, CONFIG).name,
      atespace: ATESPACE,
      role: "agent",
      image: h.spec.image,
      createdAt: at,
      lastUsedAt: at,
      goldenFailures: 0,
      readyAt: at,
    });
    expect(await h.templates.get(toolTemplate(h.spec, CONFIG).name)).toMatchObject({
      role: "tool",
      image: TOOL_IMAGE,
      atespace: ATESPACE,
      readyAt: at,
    });

    const c = await makeHarness({ provider: "codex" });
    await c.launcher.launch(c.spec);
    expect(await c.templates.get(codexTemplate(c.spec, CONFIG).name)).toMatchObject({
      role: "codex",
      image: CODEX_IMAGE,
      readyAt: new Date(T0),
    });
    expect(await c.templates.listUnusedBefore(new Date(T0 + 1), 10)).toHaveLength(1);
  });

  it("does not mark a template ready while the run has not reached running", async () => {
    const h = await makeHarness({ workers: 1, workerSize: SMALL_WORKER });
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect(await h.templates.get(agentTemplate(h.spec, CONFIG).name)).not.toHaveProperty("readyAt");
    expect(await h.templates.get(toolTemplate(h.spec, CONFIG).name)).not.toHaveProperty("readyAt");
  });

  it("bumps lastUsedAt on every launch", async () => {
    const h = await makeHarness();
    await h.launcher.launch(h.spec);
    h.setNow(T0 + 60 * MINUTE);
    await h.launcher.launch(await secondRun(h, "run-2"));
    for (const name of [agentTemplate(h.spec, CONFIG).name, toolTemplate(h.spec, CONFIG).name]) {
      expect(await h.templates.get(name)).toMatchObject({
        createdAt: new Date(T0),
        lastUsedAt: new Date(T0 + 60 * MINUTE),
        readyAt: new Date(T0),
      });
    }
  });

  it("fails the launch as provisioning_failed when the record cannot be written", async () => {
    const templates = new MemorySubstrateTemplateStore();
    templates.touch = async () => {
      throw new Error("database down");
    };
    const h = await makeHarness({ templates });
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("database down");
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("provisioning_failed");
    expect(h.api.templates.size).toBe(0);
  });

  it("counts the failure", async () => {
    const h = await makeHarness();
    const agent = agentTemplate(h.spec, CONFIG);
    await h.api.ensureActorTemplate(agent);
    h.api.failGoldenSnapshot(CONFIG.atespace, agent.name);
    // Before the move to running: the row has its failure and no readyAt.
    const setPhase = h.runs.setPhase.bind(h.runs);
    let beforeRunning: unknown;
    h.runs.setPhase = async (runId, phase, from, deadline) => {
      if (phase === "running") beforeRunning = await h.templates.get(agent.name);
      return setPhase(runId, phase, from, deadline);
    };
    await h.launcher.launch(h.spec);
    expect(beforeRunning).toMatchObject({ goldenFailures: 1, lastFailureAt: new Date(T0) });
    expect(beforeRunning).not.toHaveProperty("readyAt");
    expect(await h.templates.get(agent.name)).toMatchObject({
      goldenFailures: 1,
      lastFailureAt: new Date(T0),
      readyAt: new Date(T0),
    });
    expect(h.templateEvents).toEqual([
      { event: "substrate_template_golden_failed", name: agent.name, role: "agent", failures: 1 },
    ]);
  });

  it("rebuilds as before when the failure cannot be recorded", async () => {
    const templates = new MemorySubstrateTemplateStore();
    templates.recordGoldenFailure = async () => {
      throw new Error("database down");
    };
    const h = await makeHarness({ templates });
    const agent = agentTemplate(h.spec, CONFIG);
    await h.api.ensureActorTemplate(agent);
    h.api.failGoldenSnapshot(CONFIG.atespace, agent.name);
    const deletes = countTemplateDeletes(h);
    await h.launcher.launch(h.spec);
    expect(deletes.names).toEqual([agent.name]);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");
    // One warn line, fixed fields only: readiness counting is off while the store cannot be written.
    expect(h.templateEvents).toEqual([{ event: "substrate_template_record_failed", name: agent.name, role: "agent" }]);
  });

  it("counts one failed build once when two launches see it: one rebuilds, the other requeues", async () => {
    const h = await makeHarness();
    const agent = agentTemplate(h.spec, CONFIG);
    await h.api.ensureActorTemplate(agent);
    h.api.failGoldenSnapshot(CONFIG.atespace, agent.name);
    const deletes = countTemplateDeletes(h);
    // Both launches read the failed build before either deletes it (the race after a release).
    const getActorTemplate = h.api.getActorTemplate.bind(h.api);
    let readers = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    h.api.getActorTemplate = async (atespace, name) => {
      const info = await getActorTemplate(atespace, name);
      if (name === agent.name && info?.goldenSnapshotFailed) {
        if (++readers === 2) release();
        await bothRead;
      }
      return info;
    };
    const run2 = await secondRun(h, "run-2");
    h.setNow(T0 + 2000);
    const results = await Promise.allSettled([h.launcher.launch(h.spec), h.launcher.launch(run2)]);
    expect(readers).toBe(2);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(JobCapacityError);
    const phases = [(await h.runs.get(h.spec.runId))?.phase, (await h.runs.get("run-2"))?.phase].sort();
    expect(phases).toEqual(["requeued", "running"]);
    expect(deletes.names).toEqual([agent.name]);
    expect(await h.templates.get(agent.name)).toMatchObject({ goldenFailures: 1, lastFailureAt: new Date(T0 + 2000) });
    expect(h.templateEvents).toEqual([
      { event: "substrate_template_golden_failed", name: agent.name, role: "agent", failures: 1 },
    ]);
    // The requeued run relaunches on the rebuilt template and runs.
    const requeued = (await h.runs.get(h.spec.runId))?.phase === "requeued" ? h.spec : run2;
    await h.launcher.launch(requeued);
    expect((await h.runs.get(requeued.runId))?.phase).toBe("running");
    expect(deletes.names).toEqual([agent.name]);
  });

  /** run-1 on a template whose golden snapshot failed (recreated, running), then failed again. */
  async function failedTwice(h: Harness): Promise<string> {
    const agent = agentTemplate(h.spec, CONFIG);
    await h.api.ensureActorTemplate(agent);
    h.api.failGoldenSnapshot(CONFIG.atespace, agent.name);
    await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");
    h.api.failGoldenSnapshot(CONFIG.atespace, agent.name);
    return agent.name;
  }

  it("fails a run on a second golden failure in the window, without rebuilding", async () => {
    const h = await makeHarness();
    const name = await failedTwice(h);
    const deletes = countTemplateDeletes(h);
    h.setNow(T0 + 5 * MINUTE);
    const spec = await secondRun(h, "run-2");
    const handle = await h.launcher.launch(spec);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "substrate_image_unready",
    });
    expect((await h.runs.get("run-2"))?.phase).toBe("image_unready");
    expect(deletes.names).toEqual([]);
    await noTraceOf(h, "run-2");
    expect(h.templateEvents).toContainEqual({
      event: "substrate_template_unready",
      name,
      role: "agent",
      reason: "golden_failed",
    });
    expect(h.templateEvents).toContainEqual({
      event: "substrate_template_golden_failed",
      name,
      role: "agent",
      failures: 2,
    });
    // Never requeued: a relaunch of the same run finds its terminal row and leaves it.
    await h.launcher.launch(spec);
    expect((await h.runs.get("run-2"))?.phase).toBe("image_unready");
  });

  it("keeps failing until the window from the first failure passes, then rebuilds", async () => {
    const h = await makeHarness();
    const name = await failedTwice(h);
    h.setNow(T0 + 5 * MINUTE);
    await h.launcher.launch(await secondRun(h, "run-2"));
    h.setNow(T0 + 9 * MINUTE);
    await h.launcher.launch(await secondRun(h, "run-3"));
    expect((await h.runs.get("run-3"))?.phase).toBe("image_unready");
    expect(await h.templates.get(name)).toMatchObject({ goldenFailures: 3, lastFailureAt: new Date(T0) });
    const deletes = countTemplateDeletes(h);
    h.setNow(T0 + 10 * MINUTE + 1000);
    await h.launcher.launch(await secondRun(h, "run-4"));
    expect(deletes.names).toEqual([name]);
    expect((await h.runs.get("run-4"))?.phase).toBe("running");
    expect(await h.templates.get(name)).toMatchObject({
      goldenFailures: 1,
      lastFailureAt: new Date(T0 + 10 * MINUTE + 1000),
      readyAt: new Date(T0 + 10 * MINUTE + 1000),
    });
  });

  it("fails a never-ready template that builds past the ready window while workers have room", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000 });
    refuseToolResume(h);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("requeued");
    const tool = toolTemplate(h.spec, CONFIG).name;
    expect(await h.templates.get(tool)).toMatchObject({ createdAt: new Date(T0) });
    // Within the window: still a capacity wait.
    h.setNow(T0 + 60_000);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    h.setNow(T0 + 61_000);
    const handle = await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("image_unready");
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "substrate_image_unready",
    });
    expect(h.templateEvents).toEqual([
      { event: "substrate_template_unready", name: tool, role: "tool", reason: "never_ready" },
    ]);
    await noTraceOf(h, h.spec.runId);
  });

  it("starts the never-ready clock at the first refusal with room, not at the template's creation", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000 });
    refuseToolResume(h);
    const listWorkers = h.api.listWorkers.bind(h.api);
    // A new template whose first runs wait for real capacity (no room known) well past the window.
    h.api.listWorkers = async () => {
      throw new Error("unreachable");
    };
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    const tool = toolTemplate(h.spec, CONFIG).name;
    expect(await h.templates.get(tool)).toMatchObject({ createdAt: new Date(T0) });
    h.setNow(T0 + 10 * MINUTE);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    // Room now: the first refusal with room starts the clock, and the run still requeues.
    h.api.listWorkers = listWorkers;
    h.setNow(T0 + 10 * MINUTE + 1000);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    h.setNow(T0 + 10 * MINUTE + 61_000);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("requeued");
    expect(h.templateEvents).toEqual([]);
    // Past the window from that first refusal with room: never ready.
    h.setNow(T0 + 10 * MINUTE + 62_000);
    await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("image_unready");
    expect(h.templateEvents).toEqual([
      { event: "substrate_template_unready", name: tool, role: "tool", reason: "never_ready" },
    ]);
  });

  it("names the template of the actor whose resume was refused", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000 });
    const original = h.api.resumeActor.bind(h.api);
    h.api.resumeActor = async (atespace, name) => {
      if (name.endsWith("-agent")) throw new SubstrateExhaustedError("no worker has room");
      return original(atespace, name);
    };
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    h.setNow(T0 + 61_000);
    await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("image_unready");
    // The tool template never got a readyAt either (the run never reached running), but it resumed.
    expect(await h.templates.get(toolTemplate(h.spec, CONFIG).name)).not.toHaveProperty("readyAt");
    expect(h.templateEvents).toEqual([
      {
        event: "substrate_template_unready",
        name: agentTemplate(h.spec, CONFIG).name,
        role: "agent",
        reason: "never_ready",
      },
    ]);
  });

  it("still requeues a never-ready template when the worker list cannot be read", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000 });
    refuseToolResume(h);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    h.api.listWorkers = async () => {
      throw new Error("unreachable");
    };
    h.setNow(T0 + 61_000);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("requeued");
    expect(h.templateEvents).toEqual([]);
  });

  it("still requeues an old template that once ran", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000 });
    await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");
    refuseToolResume(h);
    const spec = await secondRun(h, "run-2");
    await expect(h.launcher.launch(spec)).rejects.toBeInstanceOf(JobCapacityError);
    h.setNow(T0 + 61_000);
    await expect(h.launcher.launch(spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect((await h.runs.get("run-2"))?.phase).toBe("requeued");
    expect(h.templateEvents).toEqual([]);
  });

  it("still requeues when the workers have no room", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000, workers: 1, workerSize: SMALL_WORKER });
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    h.setNow(T0 + 10 * 60_000);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("requeued");
    expect(await h.templates.get(toolTemplate(h.spec, CONFIG).name)).not.toHaveProperty("readyAt");
    expect(h.templateEvents).toEqual([]);
  });

  it("still requeues when the template record cannot be read", async () => {
    const templates = new MemorySubstrateTemplateStore();
    const h = await makeHarness({ templates, templateReadyMs: 60_000 });
    refuseToolResume(h);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    templates.get = async () => {
      throw new Error("database down");
    };
    h.setNow(T0 + 61_000);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
  });

  it("never fails a template whose golden snapshot Substrate reports tagged, even past the clock", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000 });
    const tool = toolTemplate(h.spec, CONFIG).name;
    h.api.setGoldenSnapshotReady(CONFIG.atespace, tool, true);
    refuseToolResume(h);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    // Tagged: ready from the status alone, though no actor from it ever reached running.
    expect(await h.templates.get(tool)).toMatchObject({ readyAt: new Date(T0) });
    h.setNow(T0 + 10 * MINUTE);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("requeued");
    expect(h.templateEvents).toEqual([]);
  });

  it("fails a template with a golden-snapshot status and no tag past the clock when no actor ever started from it", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000 });
    const tool = toolTemplate(h.spec, CONFIG).name;
    h.api.setGoldenSnapshotReady(CONFIG.atespace, tool, false);
    refuseToolResume(h);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    h.setNow(T0 + 60_000);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    h.setNow(T0 + 61_000);
    await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("image_unready");
    expect(h.templateEvents).toEqual([
      { event: "substrate_template_unready", name: tool, role: "tool", reason: "never_ready" },
    ]);
  });

  it("never fails a template that once ran, whatever a later status read says, and skips the read", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000 });
    await h.launcher.launch(h.spec);
    const tool = toolTemplate(h.spec, CONFIG).name;
    expect(await h.templates.get(tool)).toMatchObject({ readyAt: new Date(T0) });
    h.api.setGoldenSnapshotReady(CONFIG.atespace, tool, false);
    let reads = 0;
    const get = h.api.getActorTemplate.bind(h.api);
    h.api.getActorTemplate = async (...args: Parameters<typeof get>) => {
      // The never-ready check's own read (not the launch path's ensureTemplate read).
      if (new Error().stack?.includes("goldenSnapshotReady")) reads++;
      return get(...args);
    };
    refuseToolResume(h);
    const spec = await secondRun(h, "run-2");
    h.setNow(T0 + 1000);
    await expect(h.launcher.launch(spec)).rejects.toBeInstanceOf(JobCapacityError);
    h.setNow(T0 + 10 * MINUTE);
    await expect(h.launcher.launch(spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect((await h.runs.get("run-2"))?.phase).toBe("requeued");
    expect(h.templateEvents).toEqual([]);
    expect(await h.templates.get(tool)).toMatchObject({ readyAt: new Date(T0) });
    expect(reads).toBe(0);
  });

  it("logs one fixed-field line when the status read fails, then falls back to the readiness record", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000 });
    const tool = toolTemplate(h.spec, CONFIG).name;
    refuseToolResume(h);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    const get = h.api.getActorTemplate.bind(h.api);
    h.api.getActorTemplate = async (...args: Parameters<typeof get>) => {
      if (new Error().stack?.includes("goldenSnapshotReady"))
        throw new SubstrateUnavailableError("substrate_unavailable");
      return get(...args);
    };
    h.templateEvents.length = 0;
    h.setNow(T0 + 61_000);
    await h.launcher.launch(h.spec);
    h.api.getActorTemplate = get;
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("image_unready");
    expect(h.templateEvents).toContainEqual({
      event: "substrate_template_status_read_failed",
      name: tool,
      role: "tool",
    });
  });

  it("falls back to the readiness record when Substrate reports no golden-snapshot status", async () => {
    const h = await makeHarness({ templateReadyMs: 60_000 });
    const tool = toolTemplate(h.spec, CONFIG).name;
    refuseToolResume(h);
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(JobCapacityError);
    expect(await h.api.getActorTemplate(CONFIG.atespace, tool)).not.toHaveProperty("goldenSnapshotReady");
    expect(await h.templates.get(tool)).not.toHaveProperty("readyAt");
    h.setNow(T0 + 61_000);
    await h.launcher.launch(h.spec);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("image_unready");
  });

  it("lets a golden-snapshot failure win over a tag: the template is not marked ready", async () => {
    const h = await makeHarness();
    const agent = agentTemplate(h.spec, CONFIG);
    await h.api.ensureActorTemplate(agent);
    h.api.failGoldenSnapshot(CONFIG.atespace, agent.name);
    h.api.setGoldenSnapshotReady(CONFIG.atespace, agent.name, true);
    h.api.deleteActorTemplate = async () => {
      throw new SubstrateUnavailableError("substrate_unavailable");
    };
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(SubstrateUnavailableError);
    expect(await h.templates.get(agent.name)).not.toHaveProperty("readyAt");
  });

  it("reports fixed fields only", async () => {
    const options = { capabilityFor: () => FAKE_CAP, mcpTokenFor: () => FAKE_MCP };
    const golden = await makeHarness(options);
    golden.spec = { ...golden.spec, mcpTools: true };
    const name = await failedTwice(golden);
    golden.setNow(T0 + 5 * MINUTE);
    await golden.launcher.launch({ ...(await secondRun(golden, "run-2")), mcpTools: true });
    const never = await makeHarness({ ...options, templateReadyMs: 60_000 });
    never.spec = { ...never.spec, mcpTools: true };
    refuseToolResume(never);
    await expect(never.launcher.launch(never.spec)).rejects.toBeInstanceOf(JobCapacityError);
    never.setNow(T0 + 61_000);
    await never.launcher.launch(never.spec);
    expect((await never.runs.get(never.spec.runId))?.phase).toBe("image_unready");
    const tool = toolTemplate(never.spec, CONFIG).name;
    for (const [h, names] of [
      [golden, [name]],
      [never, [tool]],
    ] as const) {
      expect(h.templateEvents.length).toBeGreaterThan(0);
      for (const event of h.templateEvents) {
        for (const key of Object.keys(event)) expect(EVENT_FIELDS).toContain(key);
      }
      const recorded = JSON.stringify([h.templateEvents, ...(await Promise.all(names.map((n) => h.templates.get(n))))]);
      expect(recorded).not.toContain(FAKE_CAP);
      expect(recorded).not.toContain(FAKE_MCP);
    }
  });

  it("takes back the count of a failure whose rebuild could not start, so a later run rebuilds", async () => {
    const h = await makeHarness();
    const agent = agentTemplate(h.spec, CONFIG);
    await h.api.ensureActorTemplate(agent);
    h.api.failGoldenSnapshot(CONFIG.atespace, agent.name);
    const deleteActorTemplate = h.api.deleteActorTemplate.bind(h.api);
    h.api.deleteActorTemplate = async () => {
      throw new SubstrateUnavailableError("substrate_unavailable");
    };
    await expect(h.launcher.launch(h.spec)).rejects.toBeInstanceOf(SubstrateUnavailableError);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("provisioning_failed");
    // No build was tried: the count is back to none, the window's anchor kept.
    expect(await h.templates.get(agent.name)).toMatchObject({ goldenFailures: 0, lastFailureAt: new Date(T0) });
    h.api.deleteActorTemplate = deleteActorTemplate;
    // A later run on the same (still failed) build rebuilds it instead of failing as image_unready.
    h.setNow(T0 + 2 * MINUTE);
    await h.launcher.launch(await secondRun(h, "run-2"));
    expect((await h.runs.get("run-2"))?.phase).toBe("running");
    expect(await h.templates.get(agent.name)).toMatchObject({ goldenFailures: 1, lastFailureAt: new Date(T0) });
  });

  describe("template cleanup", () => {
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    const customTool = (spec: JobSpec, image = CUSTOM_TOOL_IMAGE) =>
      toolTemplate({ ...spec, toolImage: image }, CONFIG);
    const standardNames = (h: Harness) => [agentTemplate(h.spec, CONFIG).name, toolTemplate(h.spec, CONFIG).name];
    const inSubstrate = (h: Harness, name: string) => h.api.templates.has(`${ATESPACE}/${name}`);
    /** Moves the clock on; the earlier runs ended and were removed long before (their actors are gone). */
    const later = (h: Harness, ms: number) => {
      for (const key of [...h.api.actors.keys()]) void h.api.deleteActor(ATESPACE, key.slice(key.indexOf("/") + 1));
      h.setNow(ms);
    };

    it("removes a template unused for the TTL, and keeps one used since", async () => {
      const h = await makeHarness();
      await h.launcher.launch(h.spec);
      const custom = customTool(h.spec);
      await h.launcher.launch({ ...(await secondRun(h, "run-2")), toolImage: CUSTOM_TOOL_IMAGE });
      expect(inSubstrate(h, custom.name)).toBe(true);
      const then = T0 + 7 * DAY + HOUR;
      later(h, then);
      // Its launch sweeps first, then ensures and bumps its own (standard) templates.
      await h.launcher.launch(await secondRun(h, "run-3"));
      expect((await h.runs.get("run-3"))?.phase).toBe("running");
      expect(inSubstrate(h, custom.name)).toBe(false);
      expect(await h.templates.get(custom.name)).toBeUndefined();
      for (const name of standardNames(h)) {
        expect(inSubstrate(h, name)).toBe(true);
        expect(await h.templates.get(name)).toMatchObject({ lastUsedAt: new Date(then) });
      }
      expect(h.templateEvents).toContainEqual({
        event: "substrate_template_removed",
        name: custom.name,
        role: "tool",
        ageSec: (7 * DAY + HOUR) / 1000,
      });
    });

    it("never goes below the floor", async () => {
      // Based on the longest park TTL the setting allows (86400 s), whatever is configured: lowering
      // SUBSTRATE_PARK_TTL_SEC (or turning warm rounds off) across a restart never sweeps a
      // template an older, longer park can still adopt.
      const floor = 2 * HOUR + DAY + HOUR;
      expect(templateTtlFloorMs()).toBe(floor);
      expect(DEFAULT_TEMPLATE_TTL_MS).toBe(7 * DAY);
      for (const warmRounds of [undefined, { parkTtlMs: 60_000, parkMax: 10 }] as const) {
        const h = await makeHarness({ templateTtlMs: 60_000, ...(warmRounds ? { warmRounds } : {}) });
        const config = warmRounds ? { ...CONFIG, warmRounds: true } : CONFIG;
        const custom = toolTemplate({ ...h.spec, toolImage: CUSTOM_TOOL_IMAGE }, config);
        await h.launcher.launch({ ...h.spec, toolImage: CUSTOM_TOOL_IMAGE });
        expect(inSubstrate(h, custom.name)).toBe(true);
        later(h, T0 + 2 * HOUR);
        await h.launcher.launch(await secondRun(h, "run-2"));
        later(h, T0 + floor);
        await h.launcher.launch(await secondRun(h, "run-3"));
        expect(inSubstrate(h, custom.name)).toBe(true);
        expect(await h.templates.get(custom.name)).toBeDefined();
        later(h, T0 + floor + HOUR + 1000);
        await h.launcher.launch(await secondRun(h, "run-4"));
        expect(inSubstrate(h, custom.name)).toBe(false);
        expect(await h.templates.get(custom.name)).toBeUndefined();
      }
      // A TTL above the floor is used as configured.
      const day = await makeHarness({ templateTtlMs: 3 * DAY });
      const dayCustom = customTool(day.spec);
      await day.launcher.launch({ ...day.spec, toolImage: CUSTOM_TOOL_IMAGE });
      later(day, T0 + 3 * DAY);
      await day.launcher.launch(await secondRun(day, "run-2"));
      expect(inSubstrate(day, dayCustom.name)).toBe(true);
      later(day, T0 + 3 * DAY + HOUR);
      await day.launcher.launch(await secondRun(day, "run-3"));
      expect(inSubstrate(day, dayCustom.name)).toBe(false);
    });

    it("removes a template exactly once its last use is past the floor", async () => {
      const h = await makeHarness({ templateTtlMs: 60_000 });
      const custom = customTool(h.spec);
      await h.launcher.launch({ ...h.spec, toolImage: CUSTOM_TOOL_IMAGE });
      later(h, T0 + 2 * HOUR);
      await h.launcher.launch(await secondRun(h, "run-2"));
      expect(inSubstrate(h, custom.name)).toBe(true);
      later(h, T0 + 27 * HOUR + 1000);
      await h.launcher.launch(await secondRun(h, "run-3"));
      expect(inSubstrate(h, custom.name)).toBe(false);
    });

    it("sweeps at most once an hour", async () => {
      const h = await makeHarness();
      await h.launcher.launch({ ...h.spec, toolImage: CUSTOM_TOOL_IMAGE });
      // Used an hour later: unused for the TTL only after the first sweep below.
      later(h, T0 + HOUR);
      const python = customTool(h.spec, PYTHON_TOOL_IMAGE);
      await h.launcher.launch({ ...(await secondRun(h, "run-2")), toolImage: PYTHON_TOOL_IMAGE });
      const deletes = countTemplateDeletes(h);
      later(h, T0 + 7 * DAY + HOUR);
      await h.launcher.launch(await secondRun(h, "run-3"));
      expect(deletes.names).toContain(customTool(h.spec).name);
      expect(deletes.names).not.toContain(python.name);
      const first = deletes.names.length;
      later(h, T0 + 7 * DAY + HOUR + 30 * MINUTE);
      await h.launcher.launch(await secondRun(h, "run-4"));
      expect(deletes.names).toHaveLength(first);
      expect(inSubstrate(h, python.name)).toBe(true);
      later(h, T0 + 7 * DAY + 2 * HOUR);
      await h.launcher.launch(await secondRun(h, "run-5"));
      expect(deletes.names.slice(first)).toEqual([python.name]);
    });

    it("a failed Substrate delete puts the row back", async () => {
      const h = await makeHarness();
      const custom = customTool(h.spec);
      await h.launcher.launch({ ...h.spec, toolImage: CUSTOM_TOOL_IMAGE });
      const before = await h.templates.get(custom.name);
      const deleteActorTemplate = h.api.deleteActorTemplate.bind(h.api);
      h.api.deleteActorTemplate = async () => {
        throw new SubstrateUnavailableError("substrate_unavailable");
      };
      later(h, T0 + 7 * DAY + HOUR);
      await h.launcher.launch(await secondRun(h, "run-2"));
      expect((await h.runs.get("run-2"))?.phase).toBe("running");
      expect(await h.templates.get(custom.name)).toEqual(before);
      expect(inSubstrate(h, custom.name)).toBe(true);
      expect(h.templateEvents).toContainEqual({
        event: "substrate_template_remove_failed",
        name: custom.name,
        role: "tool",
      });
      expect(h.templateEvents.filter((e) => e.event === "substrate_template_removed")).toEqual([]);
      h.api.deleteActorTemplate = deleteActorTemplate;
      later(h, T0 + 7 * DAY + 2 * HOUR);
      await h.launcher.launch(await secondRun(h, "run-3"));
      expect(inSubstrate(h, custom.name)).toBe(false);
      expect(await h.templates.get(custom.name)).toBeUndefined();
      expect(h.templateEvents).toContainEqual({
        event: "substrate_template_removed",
        name: custom.name,
        role: "tool",
        ageSec: (7 * DAY + 2 * HOUR) / 1000,
      });
    });

    it("leaves a template a launch used between the listing and the row delete", async () => {
      const h = await makeHarness();
      const custom = customTool(h.spec);
      await h.launcher.launch({ ...h.spec, toolImage: CUSTOM_TOOL_IMAGE });
      const list = h.templates.listUnusedBefore.bind(h.templates);
      h.templates.listUnusedBefore = async (cutoff, limit) => {
        const rows = await list(cutoff, limit);
        // A concurrent launch bumps the custom template after the sweep listed it.
        await h.templates.touchNames([custom.name], new Date(T0 + 7 * DAY + HOUR));
        return rows;
      };
      const deletes = countTemplateDeletes(h);
      later(h, T0 + 7 * DAY + HOUR);
      await h.launcher.launch(await secondRun(h, "run-2"));
      expect(deletes.names).not.toContain(custom.name);
      expect(inSubstrate(h, custom.name)).toBe(true);
      expect(await h.templates.get(custom.name)).toMatchObject({ lastUsedAt: new Date(T0 + 7 * DAY + HOUR) });
    });

    it("a sweep that cannot read or write the record never fails a launch", async () => {
      const templates = new MemorySubstrateTemplateStore();
      const h = await makeHarness({ templates });
      await h.launcher.launch(h.spec);
      templates.listUnusedBefore = async () => {
        throw new Error("database down");
      };
      later(h, T0 + 7 * DAY + HOUR);
      await h.launcher.launch(await secondRun(h, "run-2"));
      expect((await h.runs.get("run-2"))?.phase).toBe("running");
      const d = await makeHarness();
      await d.launcher.launch(d.spec);
      d.templates.deleteIfUnusedBefore = async () => {
        throw new Error("database down");
      };
      const deletes = countTemplateDeletes(d);
      later(d, T0 + 7 * DAY + HOUR);
      await d.launcher.launch(await secondRun(d, "run-2"));
      expect((await d.runs.get("run-2"))?.phase).toBe("running");
      // The row was never deleted, so neither was the template.
      expect(deletes.names).toEqual([]);
    });

    it("warmUp sweeps once at start-up", async () => {
      const h = await makeHarness();
      const custom = customTool(h.spec);
      const python = customTool(h.spec, PYTHON_TOOL_IMAGE);
      await h.launcher.launch({ ...h.spec, toolImage: CUSTOM_TOOL_IMAGE });
      h.setNow(T0 + 30 * MINUTE);
      await h.launcher.launch({ ...(await secondRun(h, "run-2")), toolImage: PYTHON_TOOL_IMAGE });
      later(h, T0 + 7 * DAY + 15 * MINUTE);
      await h.launcher.warmUp();
      expect(inSubstrate(h, custom.name)).toBe(false);
      expect(inSubstrate(h, python.name)).toBe(true);
      // Within the hour of warmUp's sweep a launch does not sweep again, though python is now past the TTL.
      const deletes = countTemplateDeletes(h);
      later(h, T0 + 7 * DAY + 45 * MINUTE);
      await h.launcher.launch(await secondRun(h, "run-3"));
      expect(deletes.names).toEqual([]);
      expect(inSubstrate(h, python.name)).toBe(true);
    });

    it("re-ensures a template removed between ensure and createActor", async () => {
      const h = await makeHarness();
      const tool = toolTemplate(h.spec, CONFIG);
      const ensured: string[] = [];
      const ensure = h.api.ensureActorTemplate.bind(h.api);
      h.api.ensureActorTemplate = async (template) => {
        ensured.push(template.name);
        return ensure(template);
      };
      const createActor = h.api.createActor.bind(h.api);
      let first = true;
      h.api.createActor = async (atespace, name, template) => {
        // The sweep's delete lands just after this launch's ensure.
        if (first) h.api.templates.delete(`${ATESPACE}/${tool.name}`);
        first = false;
        return createActor(atespace, name, template);
      };
      await h.launcher.launch(h.spec);
      expect((await h.runs.get(h.spec.runId))?.phase).toBe("running");
      expect(inSubstrate(h, tool.name)).toBe(true);
      expect(ensured.filter((name) => name === tool.name)).toHaveLength(2);
      expect(await h.templates.get(tool.name)).toBeDefined();
      // A NotFound the retry recovers from is not a failed Substrate call.
      expect(h.callFailures).toEqual([]);

      // Gone again before the retry: the launch fails, with nothing left behind.
      const g = await makeHarness();
      const gTool = toolTemplate(g.spec, CONFIG);
      const gCreate = g.api.createActor.bind(g.api);
      let creates = 0;
      g.api.createActor = async (atespace, name, template) => {
        creates++;
        g.api.templates.delete(`${ATESPACE}/${gTool.name}`);
        return gCreate(atespace, name, template);
      };
      await expect(g.launcher.launch(g.spec)).rejects.toBeInstanceOf(SubstrateNotFoundError);
      // The agent's, the tool's, and the tool's one retry.
      expect(creates).toBe(3);
      // Only the failed retry is reported.
      expect(g.callFailures).toEqual([
        expect.objectContaining({ substrateCall: "createActor", errorCode: "substrate_not_found" }),
      ]);
      expect((await g.runs.get(g.spec.runId))?.phase).toBe("provisioning_failed");
      await noTraceOf(g, g.spec.runId);
    });

    it("logs fixed fields only", async () => {
      const h = await makeHarness({ capabilityFor: () => FAKE_CAP, mcpTokenFor: () => FAKE_MCP });
      h.spec = { ...h.spec, mcpTools: true };
      await h.launcher.launch({ ...h.spec, toolImage: CUSTOM_TOOL_IMAGE });
      const deleteActorTemplate = h.api.deleteActorTemplate.bind(h.api);
      h.api.deleteActorTemplate = async () => {
        throw new SubstrateUnavailableError(`substrate_unavailable ${FAKE_CAP}`);
      };
      later(h, T0 + 7 * DAY + HOUR);
      await h.launcher.launch({ ...(await secondRun(h, "run-2")), mcpTools: true });
      h.api.deleteActorTemplate = deleteActorTemplate;
      later(h, T0 + 7 * DAY + 2 * HOUR);
      await h.launcher.launch({ ...(await secondRun(h, "run-3")), mcpTools: true });
      const kinds = new Set(h.templateEvents.map((e) => e.event));
      expect(kinds).toEqual(new Set(["substrate_template_remove_failed", "substrate_template_removed"]));
      for (const event of h.templateEvents) {
        for (const key of Object.keys(event)) expect(EVENT_FIELDS).toContain(key);
      }
      const recorded = JSON.stringify(h.templateEvents);
      expect(recorded).not.toContain(FAKE_CAP);
      expect(recorded).not.toContain(FAKE_MCP);
    });
  });
});
