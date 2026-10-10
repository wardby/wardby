import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import { FakeKubernetesApi } from "../jobs/fake-kubernetes-api.js";
import { buildConfiguredExecutor, reReviewOnCodingRunTerminal } from "./composition.js";
import { RoutingExecutor } from "./routing.js";
import type { Executor } from "./types.js";

const native: Executor = { async start() {}, async stop() {} };
// Construction never queries the database.
const db = {} as unknown as PrismaClient;
// The kind harness's local registry form (host with a port).
const REGISTRY_IMAGE = `localhost:5001/wardby-coding-worker@sha256:${"a".repeat(64)}`;
const LOCAL_IMAGE = `sha256:${"b".repeat(64)}`;
const baseEnv = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "test-key" };

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
});
