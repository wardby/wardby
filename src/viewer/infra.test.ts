import { describe, expect, it } from "vitest";
import { InfraInfoSchema } from "./api-schema.js";
import { buildInfraInfo } from "./infra.js";

describe("buildInfraInfo", () => {
  it("describes a kubernetes launcher from its config", () => {
    const info = buildInfraInfo({
      JOB_LAUNCHER: "kubernetes",
      KUBERNETES_NAMESPACE: "wardby-coding",
      KUBERNETES_PLATFORM: "gke-autopilot",
      KUBERNETES_RUNTIME_CLASS: "gvisor",
      KUBERNETES_CONTEXT: "gke_secret-project_us-central1_cluster",
    });
    expect(InfraInfoSchema.parse(info)).toEqual(info);
    expect(info).toEqual({
      launcher: "kubernetes",
      kubernetes: {
        namespace: "wardby-coding",
        platform: "gke-autopilot",
        runtimeClass: "gvisor",
        proxyService: "wardby-coding-proxy",
        runLabel: "wardby.io/run-sha256",
        runLabelHashChars: 40,
        componentLabel: { "wardby.io/component": "coding-run" },
        managedByLabel: { "app.kubernetes.io/managed-by": "wardby" },
      },
      native: null,
    });
    // The server's kube context is meaningless to the client and names the project.
    expect(JSON.stringify(info)).not.toContain("secret-project");
  });

  it("defaults namespace, platform and runtime class", () => {
    const info = buildInfraInfo({ JOB_LAUNCHER: "kubernetes" });
    expect(info.kubernetes).toMatchObject({ namespace: "wardby-coding", platform: "generic", runtimeClass: null });
  });

  it("has no kubernetes block for docker or local launchers", () => {
    expect(buildInfraInfo({ JOB_LAUNCHER: "docker" })).toEqual({ launcher: "docker", kubernetes: null, native: null });
    expect(buildInfraInfo({})).toEqual({ launcher: "local", kubernetes: null, native: null });
  });

  it("normalises an unknown JOB_LAUNCHER to local", () => {
    expect(buildInfraInfo({ JOB_LAUNCHER: "k8s" })).toEqual({ launcher: "local", kubernetes: null, native: null });
  });

  it("describes a kubernetes sandbox launcher for native agents", () => {
    const info = buildInfraInfo({
      JOB_LAUNCHER: "kubernetes",
      NATIVE_SANDBOX_LAUNCHER: "kubernetes",
      NATIVE_SANDBOX_WORKER_IMAGE: `ghcr.io/example/native@sha256:${"a".repeat(64)}`,
      NATIVE_SANDBOX_NAMESPACE: "wardby-native",
      NATIVE_SANDBOX_RUNTIME_CLASS: "gvisor",
      NATIVE_SANDBOX_WARM_POOL_SIZE: "2",
    });
    expect(InfraInfoSchema.parse(info)).toEqual(info);
    expect(info.native).toEqual({
      launcher: "kubernetes",
      warmPoolSize: 2,
      kubernetes: {
        namespace: "wardby-native",
        runtimeClass: "gvisor",
        runLabel: "wardby.io/run-sha256",
        componentLabel: { "wardby.io/component": "native-run" },
        warmPoolLabel: { "wardby.io/pool": "warm" },
        warmWorkerLabel: "wardby.io/warm-worker",
      },
    });
  });

  it("reports a docker sandbox launcher without kubernetes details", () => {
    const info = buildInfraInfo({
      NATIVE_SANDBOX_LAUNCHER: "docker",
      NATIVE_SANDBOX_WORKER_IMAGE: "wardby-native:dev",
      NATIVE_GATEWAY_CONTAINER: "gw",
    });
    expect(info).toEqual({
      launcher: "local",
      kubernetes: null,
      native: { launcher: "docker", warmPoolSize: 0, kubernetes: null },
    });
  });
});
