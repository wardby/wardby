import { describe, expect, it } from "vitest";
import type { PrismaClient } from "#prisma";
import { FakeKubernetesApi } from "../jobs/fake-kubernetes-api.js";
import { buildConfiguredExecutor } from "./composition.js";
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

  it("still requires CODING_PROXY_CONTAINER for Docker", () => {
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: { ...baseEnv, JOB_LAUNCHER: "docker", CODING_WORKER_IMAGE: LOCAL_IMAGE },
      }),
    ).toThrow("CODING_PROXY_CONTAINER is required when JOB_LAUNCHER=docker.");
  });

  it("requires CODING_WORKER_IMAGE for Kubernetes", () => {
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: { ...baseEnv, JOB_LAUNCHER: "kubernetes" },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toThrow("CODING_WORKER_IMAGE is required when JOB_LAUNCHER=kubernetes.");
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
});
