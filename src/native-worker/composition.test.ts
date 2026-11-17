import { describe, expect, it } from "vitest";
import { loadNativeSandboxConfig } from "../config/providers.js";
import type { NativeRunProviders } from "../core/runner.js";
import { buildNativeSandboxExecutor } from "./composition.js";
import type { ActorTemplateSpec } from "../providers/substrate/api.js";
import { FakeSubstrateApi } from "../providers/substrate/fake-api.js";
import { FakeKubernetesApi } from "../providers/jobs/fake-kubernetes-api.js";
import { NativeSandboxExecutor } from "./sandbox-executor.js";
import { SubstrateNativeWorkerLauncher } from "./substrate-launcher.js";

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
      /must be "docker", "kubernetes" or "substrate"/,
    );
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_SANDBOX_WORKER_IMAGE: "" })).toThrow(
      /NATIVE_SANDBOX_WORKER_IMAGE is required/,
    );
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_GATEWAY_CONTAINER: "" })).toThrow(
      /NATIVE_GATEWAY_CONTAINER is required/,
    );
    expect(() => loadNativeSandboxConfig({ ...base, NATIVE_GATEWAY_URL: "not a url" })).toThrow(/NATIVE_GATEWAY_URL/);
    for (const bad of ["not a url", "ftp://fake-gw-secret-val"]) {
      expect(() => loadNativeSandboxConfig({ ...base, NATIVE_GATEWAY_URL: bad })).toThrow(/NATIVE_GATEWAY_URL/);
      try {
        loadNativeSandboxConfig({ ...base, NATIVE_GATEWAY_URL: bad });
      } catch (err) {
        expect((err as Error).message).not.toContain(bad);
      }
    }
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

  it("accepts the eks platform only under gVisor", () => {
    const eks = {
      NATIVE_SANDBOX_LAUNCHER: "kubernetes",
      NATIVE_SANDBOX_WORKER_IMAGE: image,
      KUBERNETES_PLATFORM: "eks",
    };
    expect(() => loadNativeSandboxConfig(eks)).toThrow(/runs native workers only under gVisor/);
    expect(loadNativeSandboxConfig({ ...eks, NATIVE_SANDBOX_RUNTIME_CLASS: "gvisor" })).toMatchObject({
      platform: "eks",
      runtimeClassName: "gvisor",
    });
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

  it("refuses a warm pool in low-power mode, and builds with the pool off", () => {
    const k8s = {
      NATIVE_SANDBOX_LAUNCHER: "kubernetes",
      NATIVE_SANDBOX_WORKER_IMAGE: image,
      WARDBY_LOW_POWER: "1",
      JOB_LAUNCHER: "kubernetes",
    };
    const build = (env: NodeJS.ProcessEnv) =>
      buildNativeSandboxExecutor({
        db: {} as never,
        providers: {} as NativeRunProviders,
        env,
        kubernetesApi: new FakeKubernetesApi(),
      });
    expect(() => build({ ...k8s, NATIVE_SANDBOX_WARM_POOL_SIZE: "2" })).toThrow(
      /WARDBY_LOW_POWER=1 requires NATIVE_SANDBOX_WARM_POOL_SIZE=0/,
    );
    expect(build({ ...k8s, NATIVE_SANDBOX_WARM_POOL_SIZE: "0" })).toBeInstanceOf(NativeSandboxExecutor);
  });

  it("allows a warm pool when low-power mode would be ignored (JOB_LAUNCHER is not kubernetes)", () => {
    const env = {
      NATIVE_SANDBOX_LAUNCHER: "kubernetes",
      NATIVE_SANDBOX_WORKER_IMAGE: image,
      WARDBY_LOW_POWER: "1",
      NATIVE_SANDBOX_WARM_POOL_SIZE: "2",
    };
    const build = (extra: NodeJS.ProcessEnv) =>
      buildNativeSandboxExecutor({
        db: {} as never,
        providers: {} as NativeRunProviders,
        env: { ...env, ...extra },
        kubernetesApi: new FakeKubernetesApi(),
      });
    expect(build({})).toBeInstanceOf(NativeSandboxExecutor);
    expect(build({ JOB_LAUNCHER: "docker" })).toBeInstanceOf(NativeSandboxExecutor);
  });
});

describe("native sandbox on Substrate", () => {
  const GATEWAY_URL = "http://wardby-native-gateway.wardby.svc.cluster.local:8790/native-gateway/v1/call";
  const SUBSTRATE = {
    NATIVE_SANDBOX_LAUNCHER: "substrate",
    NATIVE_SANDBOX_WORKER_IMAGE: image,
    NATIVE_GATEWAY_URL: GATEWAY_URL,
    SUBSTRATE_API_URL: "https://api.ate-system.svc.cluster.local:443",
    SUBSTRATE_TOKEN_FILE: "/var/run/secrets/substrate/token",
    SUBSTRATE_ATESPACE: "wardby-runs",
  };

  it("reads the Substrate launcher with the shared SUBSTRATE_* connection", () => {
    expect(loadNativeSandboxConfig(SUBSTRATE)).toEqual({
      launcher: "substrate",
      workerImage: image,
      gatewayUrl: GATEWAY_URL,
      cpus: 1,
      memoryMb: 512,
      pids: 128,
      warmPoolSize: 0,
      warmMaxAgeMs: 1_800_000,
      goldenWaitSec: 60,
      denyPort: 8791,
      substrate: {
        apiUrl: SUBSTRATE.SUBSTRATE_API_URL,
        tokenFile: SUBSTRATE.SUBSTRATE_TOKEN_FILE,
        atespace: "wardby-runs",
        credentialsNamespace: "wardby-run-secrets",
      },
    });
  });

  it("reads the gateway's deny port for the startup canary (NATIVE_GATEWAY_DENY_PORT)", () => {
    expect(loadNativeSandboxConfig({ ...SUBSTRATE, NATIVE_GATEWAY_DENY_PORT: "9901" })).toMatchObject({
      denyPort: 9901,
    });
    for (const bad of ["0", "65536", "port"]) {
      expect(() => loadNativeSandboxConfig({ ...SUBSTRATE, NATIVE_GATEWAY_DENY_PORT: bad })).toThrow(
        /NATIVE_GATEWAY_DENY_PORT/,
      );
    }
  });

  it("uses the native worker selector over the shared one", () => {
    const shared = { ...SUBSTRATE, SUBSTRATE_WORKER_SELECTOR: "pool=coding" };
    expect(
      (loadNativeSandboxConfig(shared) as { substrate: { workerSelector?: unknown } }).substrate.workerSelector,
    ).toEqual({
      pool: "coding",
    });
    const own = { ...shared, NATIVE_SANDBOX_SUBSTRATE_WORKER_SELECTOR: "pool=native" };
    expect(
      (loadNativeSandboxConfig(own) as { substrate: { workerSelector?: unknown } }).substrate.workerSelector,
    ).toEqual({
      pool: "native",
    });
    const bad = { ...shared, NATIVE_SANDBOX_SUBSTRATE_WORKER_SELECTOR: "novalue" };
    expect(() => loadNativeSandboxConfig(bad)).toThrow(/NATIVE_SANDBOX_SUBSTRATE_WORKER_SELECTOR/);
    expect(() => loadNativeSandboxConfig(bad)).not.toThrow(/novalue/);
  });

  it("names the variable, not its value, for a gateway URL that does not parse", () => {
    const bad = "http://[fake-gw-secret-val";
    expect(() => loadNativeSandboxConfig({ ...SUBSTRATE, NATIVE_GATEWAY_URL: bad })).toThrow(/NATIVE_GATEWAY_URL/);
    expect(() => loadNativeSandboxConfig({ ...SUBSTRATE, NATIVE_GATEWAY_URL: bad })).not.toThrow(/fake-gw-secret-val/);
  });

  const { SUBSTRATE_ATESPACE: _atespace, ...withoutAtespace } = SUBSTRATE;
  const { NATIVE_GATEWAY_URL: _gateway, ...withoutGateway } = SUBSTRATE;
  it.each([
    ["a local image id", { ...SUBSTRATE, NATIVE_SANDBOX_WORKER_IMAGE: `sha256:${"a".repeat(64)}` }, /registry digest/],
    ["no gateway URL", withoutGateway, /NATIVE_GATEWAY_URL is required/],
    [
      "an https gateway",
      { ...SUBSTRATE, NATIVE_GATEWAY_URL: "https://gw.example:8790/native-gateway/v1/call" },
      /http:\/\//,
    ],
    [
      "an IPv4 gateway",
      { ...SUBSTRATE, NATIVE_GATEWAY_URL: "http://10.0.0.7:8790/native-gateway/v1/call" },
      /by hostname/,
    ],
    [
      "an IPv6 gateway",
      { ...SUBSTRATE, NATIVE_GATEWAY_URL: "http://[fd00::1]:8790/native-gateway/v1/call" },
      /by hostname/,
    ],
    [
      "a warm pool",
      { ...SUBSTRATE, NATIVE_SANDBOX_WARM_POOL_SIZE: "1" },
      /NATIVE_SANDBOX_WARM_POOL_SIZE.*NATIVE_SANDBOX_LAUNCHER=substrate/,
    ],
    [
      "a golden wait over 600",
      { ...SUBSTRATE, SUBSTRATE_NATIVE_GOLDEN_WAIT_SEC: "601" },
      /SUBSTRATE_NATIVE_GOLDEN_WAIT_SEC/,
    ],
    ["no atespace", withoutAtespace, /SUBSTRATE_ATESPACE is required when NATIVE_SANDBOX_LAUNCHER=substrate\./],
  ])("refuses %s", (_name, env, message) => {
    expect(() => loadNativeSandboxConfig(env)).toThrow(message);
  });

  it("builds the Substrate executor with the shared API and no pool", () => {
    const fake = new FakeSubstrateApi({ workers: 1 });
    const executor = buildNativeSandboxExecutor({
      db: {} as never,
      providers: {} as NativeRunProviders,
      env: SUBSTRATE,
      substrateApi: fake,
      kubernetesApi: new FakeKubernetesApi(),
    });
    expect(executor).toBeInstanceOf(NativeSandboxExecutor);
    const launcher = (executor as unknown as { options: { launcher: unknown; gatewayUrl: string } }).options;
    expect(launcher.launcher).toBeInstanceOf(SubstrateNativeWorkerLauncher);
    expect(launcher.gatewayUrl).toBe(GATEWAY_URL);
    // Nothing is called at build time.
    expect(fake.templates.size).toBe(0);
  });

  it("gives the worker template the configured deny port", () => {
    const executor = buildNativeSandboxExecutor({
      db: {} as never,
      providers: {} as NativeRunProviders,
      env: { ...SUBSTRATE, NATIVE_GATEWAY_DENY_PORT: "9901" },
      substrateApi: new FakeSubstrateApi({ workers: 1 }),
      kubernetesApi: new FakeKubernetesApi(),
    });
    const launcher = (executor as unknown as { options: { launcher: { template: ActorTemplateSpec } } }).options
      .launcher;
    expect(launcher.template.containers[0].env).toContainEqual({ name: "NATIVE_GATEWAY_DENY_PORT", value: "9901" });
  });

  it("fails at startup for a size that rounds to nothing", () => {
    expect(() =>
      buildNativeSandboxExecutor({
        db: {} as never,
        providers: {} as NativeRunProviders,
        env: { ...SUBSTRATE, NATIVE_SANDBOX_CPUS: "0.0001" },
        substrateApi: new FakeSubstrateApi({ workers: 1 }),
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toThrow("substrate_limits_too_small");
  });
});
