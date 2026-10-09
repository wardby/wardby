import { describe, expect, it } from "vitest";
import { loadNativeSandboxConfig } from "../config/providers.js";
import type { NativeRunProviders } from "../core/runner.js";
import { buildNativeSandboxExecutor } from "./composition.js";
import { NativeSandboxExecutor } from "./sandbox-executor.js";

const image = `ghcr.io/wardby/wardby/wardby-native-worker@sha256:${"a".repeat(64)}`;
const base = { NATIVE_SANDBOX_LAUNCHER: "docker", NATIVE_SANDBOX_WORKER_IMAGE: image, NATIVE_GATEWAY_CONTAINER: "gw" };

describe("native sandbox configuration", () => {
  it("is off when NATIVE_SANDBOX_LAUNCHER is unset", () => {
    expect(loadNativeSandboxConfig({})).toBeUndefined();
    expect(
      buildNativeSandboxExecutor({ db: {} as never, providers: {} as NativeRunProviders, env: {} }),
    ).toBeUndefined();
  });

  it("reads the Docker launcher with defaults: 1 CPU, 512 MiB, 128 PIDs", () => {
    expect(loadNativeSandboxConfig(base)).toEqual({
      launcher: "docker",
      workerImage: image,
      gatewayContainer: "gw",
      cpus: 1,
      memoryMb: 512,
      pids: 128,
      warmPoolSize: 0,
      warmMaxAgeMs: 1_800_000,
    });
    expect(
      loadNativeSandboxConfig({
        ...base,
        NATIVE_SANDBOX_CPUS: "0.5",
        NATIVE_SANDBOX_MEMORY_MB: "256",
        NATIVE_SANDBOX_PIDS: "64",
      }),
    ).toMatchObject({ cpus: 0.5, memoryMb: 256, pids: 64 });
  });

  it("fails fast on a configuration that cannot work", () => {
    expect(() => loadNativeSandboxConfig({ NATIVE_SANDBOX_LAUNCHER: "podman" })).toThrow(
      /must be "docker" or "kubernetes"/,
    );
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_SANDBOX_WORKER_IMAGE: "" })).toThrow(
      /NATIVE_SANDBOX_WORKER_IMAGE is required/,
    );
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_GATEWAY_CONTAINER: "" })).toThrow(
      /NATIVE_GATEWAY_CONTAINER is required/,
    );
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_GATEWAY_URL: "not a url" })).toThrow(/NATIVE_GATEWAY_URL/);
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_SANDBOX_MEMORY_MB: "-1" })).toThrow(
      /NATIVE_SANDBOX_MEMORY_MB/,
    );
  });

  it("builds the executor when configured", () => {
    expect(
      buildNativeSandboxExecutor({ db: {} as never, providers: {} as NativeRunProviders, env: base }),
    ).toBeInstanceOf(NativeSandboxExecutor);
  });

  it("reads the Kubernetes launcher, defaulting to the coding launcher's namespace and runtime class", () => {
    const k8s = { NATIVE_SANDBOX_LAUNCHER: "kubernetes", NATIVE_SANDBOX_WORKER_IMAGE: image };
    expect(loadNativeSandboxConfig(k8s)).toEqual({
      launcher: "kubernetes",
      workerImage: image,
      namespace: "wardby-coding",
      gatewayService: "wardby-native-gateway",
      platform: "generic",
      cpus: 1,
      memoryMb: 512,
      pids: 128,
      warmPoolSize: 0,
      warmMaxAgeMs: 1_800_000,
    });
    expect(
      loadNativeSandboxConfig({
        ...k8s,
        KUBERNETES_NAMESPACE: "runs",
        KUBERNETES_RUNTIME_CLASS: "gvisor",
        KUBERNETES_CONTEXT: "kind-wardby",
      }),
    ).toMatchObject({ namespace: "runs", runtimeClassName: "gvisor", context: "kind-wardby" });
    expect(
      loadNativeSandboxConfig({
        ...k8s,
        KUBERNETES_NAMESPACE: "runs",
        NATIVE_SANDBOX_NAMESPACE: "native",
        NATIVE_GATEWAY_SERVICE: "gw",
      }),
    ).toMatchObject({ namespace: "native", gatewayService: "gw" });
  });

  it("reads GKE Autopilot's platform, run priority, timeouts, and the concurrency cap, and requires gVisor there", () => {
    const k8s = { NATIVE_SANDBOX_LAUNCHER: "kubernetes", NATIVE_SANDBOX_WORKER_IMAGE: image };
    const gke = {
      ...k8s,
      KUBERNETES_PLATFORM: "gke-autopilot",
      KUBERNETES_RUNTIME_CLASS: "gvisor",
      KUBERNETES_RUN_PRIORITY_CLASS: "wardby-coding-run",
      NATIVE_SANDBOX_READY_TIMEOUT_MS: "600000",
      NATIVE_SANDBOX_ENFORCEMENT_TIMEOUT_MS: "60000",
      NATIVE_SANDBOX_MAX_CONCURRENT: "4",
    };
    expect(loadNativeSandboxConfig(gke)).toMatchObject({
      platform: "gke-autopilot",
      runtimeClassName: "gvisor",
      priorityClassName: "wardby-coding-run",
      readyTimeoutMs: 600_000,
      enforcementTimeoutMs: 60_000,
      maxConcurrent: 4,
    });
    expect(loadNativeSandboxConfig({ ...gke, NATIVE_SANDBOX_PRIORITY_CLASS: "native-runs" })).toMatchObject({
      priorityClassName: "native-runs",
    });
    expect(() => loadNativeSandboxConfig({ ...gke, KUBERNETES_RUNTIME_CLASS: "" })).toThrow(/only under gVisor/);
    expect(() => loadNativeSandboxConfig({ ...gke, NATIVE_SANDBOX_RUNTIME_CLASS: "runc" })).toThrow(
      /only under gVisor/,
    );
    expect(() => loadNativeSandboxConfig({ ...gke, NATIVE_SANDBOX_PRIORITY_CLASS: "system-node-critical" })).toThrow(
      /system- priority class/,
    );
    expect(() => loadNativeSandboxConfig({ ...gke, NATIVE_SANDBOX_READY_TIMEOUT_MS: "5" })).toThrow(
      /NATIVE_SANDBOX_READY_TIMEOUT_MS/,
    );
    expect(() => loadNativeSandboxConfig({ ...k8s, KUBERNETES_PLATFORM: "eks" })).toThrow(/KUBERNETES_PLATFORM/);
  });

  it("reads the warm pool's size and max age within bounds", () => {
    expect(
      loadNativeSandboxConfig({
        ...base,
        NATIVE_SANDBOX_WARM_POOL_SIZE: "2",
        NATIVE_SANDBOX_WARM_MAX_AGE_MS: "600000",
      }),
    ).toMatchObject({ warmPoolSize: 2, warmMaxAgeMs: 600_000 });
    expect(loadNativeSandboxConfig({ ...base, NATIVE_SANDBOX_WARM_POOL_SIZE: "" })).toMatchObject({ warmPoolSize: 0 });
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_SANDBOX_WARM_POOL_SIZE: "51" })).toThrow(
      /NATIVE_SANDBOX_WARM_POOL_SIZE/,
    );
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_SANDBOX_WARM_POOL_SIZE: "-1" })).toThrow(
      /NATIVE_SANDBOX_WARM_POOL_SIZE/,
    );
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_SANDBOX_WARM_MAX_AGE_MS: "1000" })).toThrow(
      /NATIVE_SANDBOX_WARM_MAX_AGE_MS/,
    );
  });

  it("requires a registry digest for Kubernetes: a cluster cannot pull a local image id", () => {
    expect(() =>
      loadNativeSandboxConfig({
        NATIVE_SANDBOX_LAUNCHER: "kubernetes",
        NATIVE_SANDBOX_WORKER_IMAGE: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow(/must be a registry digest/);
  });
});
