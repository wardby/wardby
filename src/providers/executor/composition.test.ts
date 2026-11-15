import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import type { Power } from "../../core/power.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeKubernetesApi } from "../jobs/fake-kubernetes-api.js";
import { FakeSubstrateApi } from "../jobs/substrate/fake-api.js";
import { SubstrateJobLauncher } from "../jobs/substrate/launcher.js";
import {
  assertSubstrateDigestImages,
  buildConfiguredExecutor,
  buildSubstrateJobLauncher,
  configuredClaudeToolImages,
  configuredCodexWorkerImages,
  reReviewOnCodingRunTerminal,
} from "./composition.js";
import { RoutingExecutor } from "./routing.js";
import type { Executor } from "./types.js";

const native: Executor = { async start() {}, async stop() {} };
// Construction never queries the database.
const db = {} as unknown as PrismaClient;
// The kind harness's local registry form (host with a port).
const REGISTRY_IMAGE = `localhost:5001/wardby-coding-worker@sha256:${"a".repeat(64)}`;
const LOCAL_IMAGE = `sha256:${"b".repeat(64)}`;
const baseEnv = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "test-key" };

describe("JOB_LAUNCHER=substrate", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-composition-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "fake-token-value");
  const env = {
    ...baseEnv,
    JOB_LAUNCHER: "substrate",
    CODING_CLAUDE_WORKER_IMAGE: REGISTRY_IMAGE,
    CODING_CLAUDE_TOOL_RUNNER_IMAGE: REGISTRY_IMAGE,
    SUBSTRATE_API_URL: "https://api.ate.example:443",
    SUBSTRATE_TOKEN_FILE: tokenFile,
    SUBSTRATE_PROXY_HOST: "proxy.example",
    SUBSTRATE_ATESPACE: "wardby-runs",
    BLOB_STORE: "local",
    BLOB_STORE_LOCAL_DIR: join(dir, "blobs"),
  };
  const build = (over: Record<string, string>, drop: string[] = []) => {
    const merged: Record<string, string> = { ...env, ...over };
    for (const name of drop) delete merged[name];
    return buildConfiguredExecutor({
      native,
      db,
      env: merged,
      substrateApi: new FakeSubstrateApi({ workers: 1 }),
      kubernetesApi: new FakeKubernetesApi(),
    });
  };

  it("requires SUBSTRATE_PROXY_HOST, naming the variable", () => {
    expect(() => build({}, ["SUBSTRATE_PROXY_HOST"])).toThrow("SUBSTRATE_PROXY_HOST is required");
  });

  it("requires a blob store", () => {
    expect(() => build({}, ["BLOB_STORE", "BLOB_STORE_LOCAL_DIR"])).toThrow(
      "BLOB_STORE is required when JOB_LAUNCHER=substrate.",
    );
  });

  it("uses the kubernetes digest wording, naming substrate", () => {
    expect(() => build({ CODING_CLAUDE_WORKER_IMAGE: LOCAL_IMAGE })).toThrow(
      "CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE must be registry digests (repo@sha256:...) when JOB_LAUNCHER=substrate.",
    );
    expect(() => build({ CODING_WORKER_IMAGE: LOCAL_IMAGE })).toThrow(
      "CODING_WORKER_IMAGE must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=substrate.",
    );
  });

  it("does not leak the token file contents or path in errors", () => {
    let message = "";
    expect(() => {
      try {
        build({ SUBSTRATE_PROXY_PORT: "x" });
      } catch (error) {
        message = String(error);
        throw error;
      }
    }).toThrow("SUBSTRATE_PROXY_PORT");
    expect(message).not.toContain("fake-token-value");
  });

  it("composes a routing executor", () => {
    expect(build({})).toBeInstanceOf(RoutingExecutor);
  });

  it("lists every configured Claude tool-runner image as a bridge image, and nothing else", () => {
    const python = `registry.example/tool-python@sha256:${"c".repeat(64)}`;
    expect(
      configuredClaudeToolImages({
        claudeToolRunnerImage: REGISTRY_IMAGE,
        claudeToolRunnerImages: { "node-python": { "3.12": python } },
      }),
    ).toEqual([REGISTRY_IMAGE, python]);
    expect(configuredClaudeToolImages({ claudeToolRunnerImage: undefined, claudeToolRunnerImages: {} })).toEqual([]);
  });

  it("lists every configured Codex worker image as a Codex bridge image, and nothing else", () => {
    const python = `registry.example/worker-python@sha256:${"c".repeat(64)}`;
    expect(
      configuredCodexWorkerImages({
        workerImage: REGISTRY_IMAGE,
        additionalWorkerImages: { "node-python": { "3.12": python } },
      }),
    ).toEqual([REGISTRY_IMAGE, python]);
    expect(configuredCodexWorkerImages({ workerImage: undefined, additionalWorkerImages: {} })).toEqual([]);
  });

  it("refuses a Codex node-python worker image that isn't a registry digest", () => {
    expect(() => build({ CODING_WORKER_IMAGE_NODE_PYTHON_3_12: LOCAL_IMAGE })).toThrow(
      "CODING_WORKER_IMAGE_NODE_PYTHON_3_12 must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=substrate.",
    );
    expect(build({ CODING_WORKER_IMAGE_NODE_PYTHON_3_12: REGISTRY_IMAGE })).toBeInstanceOf(RoutingExecutor);
  });

  it("checks every additional Codex worker image, not only node-python 3.12", () => {
    const digest = `registry.example/worker@sha256:${"e".repeat(64)}`;
    expect(() =>
      assertSubstrateDigestImages({
        additionalWorkerImages: { "node-python": { "3.12": digest }, "node-go": { "1.23": LOCAL_IMAGE } },
      }),
    ).toThrow(
      "CODING_WORKER_IMAGE_NODE_GO_1_23 must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=substrate.",
    );
    expect(() =>
      assertSubstrateDigestImages({
        additionalWorkerImages: { "node-python": { "3.12": digest, "3.13": digest }, "node-go": { "1.23": digest } },
      }),
    ).not.toThrow();
  });

  it("builds a SubstrateJobLauncher", () => {
    const launcher = buildSubstrateJobLauncher({
      env,
      db,
      workspaceRoot: join(dir, "ws"),
      resolveCapability: async () => "cap",
      substrateApi: new FakeSubstrateApi({ workers: 1 }),
      kubernetesApi: new FakeKubernetesApi(),
      bridgeToolImages: [],
      bridgeCodexImages: [],
    });
    expect(launcher).toBeInstanceOf(SubstrateJobLauncher);
  });

  it("passes the collect grace and startup timeout to the launcher, in milliseconds", () => {
    const launcher = buildSubstrateJobLauncher({
      env: { ...env, SUBSTRATE_COLLECT_GRACE_SEC: "45", SUBSTRATE_STARTUP_TIMEOUT_SEC: "900" },
      db,
      workspaceRoot: join(dir, "ws"),
      resolveCapability: async () => "cap",
      substrateApi: new FakeSubstrateApi({ workers: 1 }),
      kubernetesApi: new FakeKubernetesApi(),
      bridgeToolImages: [],
      bridgeCodexImages: [],
    });
    const options = (launcher as unknown as { options: { collectGraceMs?: number; startupTimeoutMs?: number } })
      .options;
    expect(options.collectGraceMs).toBe(45_000);
    expect(options.startupTimeoutMs).toBe(900_000);
  });

  it("passes warm rounds to the launcher only when SUBSTRATE_WARM_ROUNDS=true", () => {
    const build = (extra: Record<string, string>) =>
      (
        buildSubstrateJobLauncher({
          env: { ...env, ...extra },
          db,
          workspaceRoot: join(dir, "ws"),
          resolveCapability: async () => "cap",
          substrateApi: new FakeSubstrateApi({ workers: 1 }),
          kubernetesApi: new FakeKubernetesApi(),
          bridgeToolImages: [],
          bridgeCodexImages: [],
        }) as unknown as { options: { warmRounds?: unknown } }
      ).options;
    expect(build({})).not.toHaveProperty("warmRounds");
    expect(build({ SUBSTRATE_WARM_ROUNDS: "true", SUBSTRATE_PARK_TTL_SEC: "600" }).warmRounds).toEqual({
      parkTtlMs: 600_000,
      parkMax: 10,
    });
    expect(build({ SUBSTRATE_WARM_ROUNDS: "true", SUBSTRATE_PARK_MAX: "0" }).warmRounds).toEqual({
      parkTtlMs: 3_600_000,
      parkMax: 0,
    });
  });
});

describe("buildConfiguredExecutor", () => {
  it("returns the native executor when no container launcher is selected", () => {
    expect(buildConfiguredExecutor({ native, db, env: { ...baseEnv } })).toBe(native);
  });

  it("composes the native sandbox executor without a container launcher (independent of JOB_LAUNCHER)", async () => {
    const started: string[] = [];
    const sandbox: Executor = {
      async start(runId) {
        started.push(`sandbox:${runId}`);
      },
      async stop() {},
    };
    const nativeSpy: Executor = {
      async start(runId) {
        started.push(`native:${runId}`);
      },
      async stop() {},
    };
    const rows: Record<string, { nativeExecutionMode: string | null; agent: { kind: string } }> = {
      s: { nativeExecutionMode: "sandbox", agent: { kind: "native" } },
      n: { nativeExecutionMode: "control_plane", agent: { kind: "native" } },
    };
    const routingDb = {
      run: { findUnique: async ({ where }: { where: { id: string } }) => rows[where.id] ?? null },
    } as unknown as PrismaClient;
    const executor = buildConfiguredExecutor({
      native: nativeSpy,
      nativeSandbox: sandbox,
      db: routingDb,
      env: { ...baseEnv },
    });
    expect(executor).toBeInstanceOf(RoutingExecutor);
    await executor.start("s");
    await executor.start("n");
    expect(started).toEqual(["sandbox:s", "native:n"]);
  });

  it("still requires CODING_PROXY_CONTAINER for Docker", () => {
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: { ...baseEnv, JOB_LAUNCHER: "docker", CODING_WORKER_IMAGE: LOCAL_IMAGE },
      }),
    ).toThrow("CODING_PROXY_CONTAINER is required when JOB_LAUNCHER=docker.");
  });

  it("requires a Codex or a Claude Code worker image for Kubernetes", () => {
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: { ...baseEnv, JOB_LAUNCHER: "kubernetes" },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toThrow(
      "CODING_WORKER_IMAGE (Codex) or both CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE (Claude Code) are required when JOB_LAUNCHER=kubernetes.",
    );
  });

  it("requires a Codex or a Claude Code worker image for Docker", () => {
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: { ...baseEnv, JOB_LAUNCHER: "docker", CODING_PROXY_CONTAINER: "proxy" },
      }),
    ).toThrow(
      "CODING_WORKER_IMAGE (Codex) or both CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE (Claude Code) are required when JOB_LAUNCHER=docker.",
    );
  });

  it("fails at composition time on a half-set blob store config", () => {
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: {
          ...baseEnv,
          JOB_LAUNCHER: "docker",
          CODING_PROXY_CONTAINER: "proxy",
          CODING_WORKER_IMAGE: LOCAL_IMAGE,
          BLOB_STORE: "gcs",
        },
      }),
    ).toThrow("BLOB_STORE_GCS_BUCKET is required when BLOB_STORE=gcs.");
  });

  it("does not count half of the Claude Code pair as a configured provider", () => {
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: { ...baseEnv, JOB_LAUNCHER: "kubernetes", CODING_CLAUDE_WORKER_IMAGE: REGISTRY_IMAGE },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toThrow("are required when JOB_LAUNCHER=kubernetes.");
  });

  it("builds for Kubernetes with only the Claude Code images", () => {
    const api = new FakeKubernetesApi();
    const executor = buildConfiguredExecutor({
      native,
      db,
      env: {
        ...baseEnv,
        JOB_LAUNCHER: "kubernetes",
        CODING_CLAUDE_WORKER_IMAGE: REGISTRY_IMAGE,
        CODING_CLAUDE_TOOL_RUNNER_IMAGE: REGISTRY_IMAGE,
      },
      kubernetesApi: api,
    });
    expect(executor).toBeInstanceOf(RoutingExecutor);
    expect(api.objects.size).toBe(0);
  });

  it("builds for Docker with only the Claude Code images", () => {
    const executor = buildConfiguredExecutor({
      native,
      db,
      env: {
        ...baseEnv,
        JOB_LAUNCHER: "docker",
        CODING_PROXY_CONTAINER: "proxy",
        CODING_CLAUDE_WORKER_IMAGE: LOCAL_IMAGE,
        CODING_CLAUDE_TOOL_RUNNER_IMAGE: LOCAL_IMAGE,
      },
    });
    expect(executor).toBeInstanceOf(RoutingExecutor);
  });

  it("rejects a bare local image ID for Kubernetes", () => {
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: { ...baseEnv, JOB_LAUNCHER: "kubernetes", CODING_WORKER_IMAGE: LOCAL_IMAGE },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toThrow("CODING_WORKER_IMAGE must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=kubernetes.");
  });

  it("rejects a Claude image that isn't a registry digest on Kubernetes", () => {
    const REGISTRY_IMAGE = `registry.example/wardby-coding-worker@sha256:${"a".repeat(64)}`;
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: {
          ...baseEnv,
          JOB_LAUNCHER: "kubernetes",
          CODING_WORKER_IMAGE: REGISTRY_IMAGE,
          CODING_CLAUDE_WORKER_IMAGE: REGISTRY_IMAGE,
          CODING_CLAUDE_TOOL_RUNNER_IMAGE: LOCAL_IMAGE,
        },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toThrow(
      "CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE must be registry digests (repo@sha256:...) when JOB_LAUNCHER=kubernetes.",
    );
  });

  it("leaves the Codex node-python worker image to the Kubernetes launcher's own checks (no new one)", () => {
    const REGISTRY_IMAGE = `registry.example/wardby-coding-worker@sha256:${"a".repeat(64)}`;
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: {
          ...baseEnv,
          JOB_LAUNCHER: "kubernetes",
          CODING_WORKER_IMAGE: REGISTRY_IMAGE,
          CODING_WORKER_IMAGE_NODE_PYTHON_3_12: LOCAL_IMAGE,
        },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).not.toThrow();
  });

  it("rejects a Claude node-python tool-runner image that isn't a registry digest on Kubernetes", () => {
    const REGISTRY_IMAGE = `registry.example/wardby-coding-worker@sha256:${"a".repeat(64)}`;
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: {
          ...baseEnv,
          JOB_LAUNCHER: "kubernetes",
          CODING_WORKER_IMAGE: REGISTRY_IMAGE,
          CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12: LOCAL_IMAGE,
        },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toThrow("CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12 must be a registry digest");
  });

  it("refuses to compose a kubernetes launcher on gke-autopilot without gvisor", () => {
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        kubernetesApi: new FakeKubernetesApi(),
        env: {
          ...baseEnv,
          JOB_LAUNCHER: "kubernetes",
          KUBERNETES_PLATFORM: "gke-autopilot",
          CODING_WORKER_IMAGE: REGISTRY_IMAGE,
        },
      }),
    ).toThrow("requires KUBERNETES_RUNTIME_CLASS=gvisor (found unset)");
  });

  it("builds a routing executor for Kubernetes without a proxy container or any cluster call", () => {
    const api = new FakeKubernetesApi();
    const executor = buildConfiguredExecutor({
      native,
      db,
      env: { ...baseEnv, JOB_LAUNCHER: "kubernetes", CODING_WORKER_IMAGE: REGISTRY_IMAGE },
      kubernetesApi: api,
    });
    expect(executor).toBeInstanceOf(RoutingExecutor);
    expect(api.objects.size).toBe(0);
    expect(api.execCalls).toEqual([]);
  });

  it("passes the given Power to the Kubernetes launcher: warm-up defers while the proxy is asleep", async () => {
    const api = new FakeKubernetesApi();
    const isAsleep = vi.fn(async () => true);
    const power: Power = {
      enabled: true,
      ensureAwake: async () => {},
      isAsleep,
      sleepIfIdle: async () => {},
      checkAccess: async () => [],
      status: async () => ({ enabled: true, targets: [] }),
      sleepNow: async () => ({ slept: [], blocked: [] }),
    };
    const executor = buildConfiguredExecutor({
      native,
      db,
      env: { ...baseEnv, JOB_LAUNCHER: "kubernetes", CODING_WORKER_IMAGE: REGISTRY_IMAGE },
      kubernetesApi: api,
      power,
    });
    await executor.warmUp?.();
    expect(isAsleep).toHaveBeenCalledWith("proxy");
    // No preflight ran: no canary pod, no exec.
    expect(api.objects.size).toBe(0);
    expect(api.execCalls).toEqual([]);
  });

  it("treats an empty CODING_WORKER_IMAGE as unset on a Claude-only Docker server", () => {
    const executor = buildConfiguredExecutor({
      native,
      db,
      env: {
        ...baseEnv,
        JOB_LAUNCHER: "docker",
        CODING_PROXY_CONTAINER: "proxy",
        CODING_WORKER_IMAGE: "",
        CODING_CLAUDE_WORKER_IMAGE: LOCAL_IMAGE,
        CODING_CLAUDE_TOOL_RUNNER_IMAGE: LOCAL_IMAGE,
      },
    });
    expect(executor).toBeInstanceOf(RoutingExecutor);
  });

  it("treats an empty CODING_WORKER_IMAGE as unset on a Claude-only Kubernetes server", () => {
    const executor = buildConfiguredExecutor({
      native,
      db,
      env: {
        ...baseEnv,
        JOB_LAUNCHER: "kubernetes",
        CODING_WORKER_IMAGE: " ",
        CODING_CLAUDE_WORKER_IMAGE: REGISTRY_IMAGE,
        CODING_CLAUDE_TOOL_RUNNER_IMAGE: REGISTRY_IMAGE,
      },
      kubernetesApi: new FakeKubernetesApi(),
    });
    expect(executor).toBeInstanceOf(RoutingExecutor);
  });

  it("gives the clear startup error for an empty CODING_WORKER_IMAGE alone", () => {
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: { ...baseEnv, JOB_LAUNCHER: "kubernetes", CODING_WORKER_IMAGE: "" },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toThrow(
      "CODING_WORKER_IMAGE (Codex) or both CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE (Claude Code) are required when JOB_LAUNCHER=kubernetes.",
    );
  });
});

describe("reReviewOnCodingRunTerminal", () => {
  it("starts the no-change re-review in the background and swallows its failure", async () => {
    const review = await import("../../core/review-fix.js");
    const spy = vi.spyOn(review, "reReviewAfterNoChangeFix");
    spy.mockRejectedValueOnce(new Error("boom"));
    const deps = { db, executor: native, hosts: {}, repoAccess: {} } as never;
    const hook = reReviewOnCodingRunTerminal(() => deps);
    expect(hook("run-1")).toBeUndefined();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("run-1", deps));
    spy.mockRestore();
  });

  it("releases the reviews that waited for the finished run, swallowing a failure", async () => {
    const review = await import("../../core/review-fix.js");
    const events = await import("../../core/host-events.js");
    const reReview = vi.spyOn(review, "reReviewAfterNoChangeFix").mockResolvedValueOnce(undefined);
    const release = vi.spyOn(events, "startDeferredForRequest").mockRejectedValueOnce(new Error("boom"));
    const deps = { db, executor: native, hosts: {}, repoAccess: {} } as never;
    expect(reReviewOnCodingRunTerminal(() => deps)("run-2")).toBeUndefined();
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(deps, "run-2"));
    reReview.mockRestore();
    release.mockRestore();
  });

  it("refreshes the related pull requests and merge order checks when a top-level follow-up of a multi-repository change ends", async () => {
    const review = await import("../../core/review-fix.js");
    const events = await import("../../core/host-events.js");
    const related = await import("../../core/related-pull-requests.js");
    const order = await import("../../core/merge-order-check.js");
    const reReview = vi.spyOn(review, "reReviewAfterNoChangeFix").mockResolvedValue(undefined);
    const release = vi.spyOn(events, "startDeferredForRequest").mockResolvedValue(undefined);
    const update = vi.spyOn(related, "updateRelatedPullRequests").mockResolvedValue(undefined);
    const sync = vi.spyOn(order, "syncMergeOrderChecks").mockResolvedValue(undefined);
    // A directly triggered continuation (no parent) whose own rows recorded no pull request: its
    // root's extra opened one, so the change is still a set of several.
    const findFirst = vi.fn(async () => ({ id: "row" }));
    const changeDb = {
      run: { findUnique: vi.fn(async () => ({ parentRunId: null })) },
      codingRun: { findUnique: vi.fn(async () => ({ rootCodingRunId: "root" })) },
      codingRunRepository: { findFirst },
    };
    const deps = { db: changeDb, executor: native, hosts: {}, repoAccess: {} } as never;
    reReviewOnCodingRunTerminal(() => deps)("cont");
    await vi.waitFor(() => expect(sync).toHaveBeenCalledWith({ db: changeDb, hosts: {} }, "cont"));
    expect(update).toHaveBeenCalledWith(changeDb, { id: "cont" }, {}, undefined);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        access: "write",
        pullRequestNumber: { not: null },
        codingRun: { OR: [{ runId: "root" }, { rootCodingRunId: "root" }] },
      },
      select: { id: true },
    });
    for (const spy of [reReview, release, update, sync]) spy.mockRestore();
  });

  it("runs both outside the caller's async context, so a coding run finishing inside its lead's step can start a review", async () => {
    // A stand-in for the DBOS step context a delegated coding run finishes in.
    const step = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const review = await import("../../core/review-fix.js");
    const events = await import("../../core/host-events.js");
    const reReview = vi.spyOn(review, "reReviewAfterNoChangeFix").mockImplementationOnce(async () => {
      seen.push(step.getStore());
    });
    const release = vi.spyOn(events, "startDeferredForRequest").mockImplementationOnce(async () => {
      seen.push(step.getStore());
    });
    const deps = { db, executor: native, hosts: {}, repoAccess: {} } as never;
    step.run("turn:1:tool:0", () => reReviewOnCodingRunTerminal(() => deps)("run-3"));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([undefined, undefined]);
    reReview.mockRestore();
    release.mockRestore();
  });
});
