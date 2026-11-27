import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import type { Power } from "../../core/power.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeKubernetesApi } from "../jobs/fake-kubernetes-api.js";
import { FakeSubstrateApi } from "../substrate/fake-api.js";
import { SubstrateJobLauncher } from "../jobs/substrate/launcher.js";
import { PrismaSubstrateTemplateStore } from "../jobs/substrate/template-store.js";
import {
  assertSubstrateDigestImages,
  buildConfiguredExecutor,
  buildSubstrateJobLauncher,
  planTicketStarter,
  reReviewOnCodingRunTerminal,
  reviewRouterStarter,
} from "./composition.js";
import { RoutingExecutor } from "./routing.js";
import { getReviewActionHook, setReviewActionHook } from "../../core/documents/review-hooks.js";
import type { Executor } from "./types.js";
import type { dispatchRun as dispatchRunType } from "../../core/dispatch.js";

const native: Executor = { async start() {}, async stop() {} };

/** The SubstrateJobLauncher a configured executor holds (its options.jobs, behind any router). */
function findSubstrateLauncher(value: unknown, depth = 0): SubstrateJobLauncher | undefined {
  if (value instanceof SubstrateJobLauncher) return value;
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findSubstrateLauncher(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}
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

  it("leaves the tunnel to Docker and Kubernetes: its settings are not read here", () => {
    expect(build({ CODING_TUNNEL_PORT: "8789" })).toBeInstanceOf(RoutingExecutor);
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
    });
    expect(launcher).toBeInstanceOf(SubstrateJobLauncher);
  });

  it("passes the MCP token resolver to the launcher, and nothing without one", () => {
    const build = (resolveMcpToken?: (runId: string) => Promise<string | undefined>) =>
      (
        buildSubstrateJobLauncher({
          env,
          db,
          workspaceRoot: join(dir, "ws"),
          resolveCapability: async () => "cap",
          ...(resolveMcpToken ? { resolveMcpToken } : {}),
          substrateApi: new FakeSubstrateApi({ workers: 1 }),
          kubernetesApi: new FakeKubernetesApi(),
        }) as unknown as { options: { resolveMcpToken?: unknown } }
      ).options.resolveMcpToken;
    const resolveMcpToken = async () => undefined;
    expect(build(resolveMcpToken)).toBe(resolveMcpToken);
    expect(build()).toBeUndefined();
  });

  it("passes the service-state reporter to the Substrate launcher", () => {
    const onServiceState = async () => undefined;
    const launcher = buildSubstrateJobLauncher({
      env,
      db,
      workspaceRoot: join(dir, "ws"),
      resolveCapability: async () => "cap",
      onServiceState,
      substrateApi: new FakeSubstrateApi({ workers: 1 }),
      kubernetesApi: new FakeKubernetesApi(),
    });
    expect((launcher as unknown as { options: { onServiceState?: unknown } }).options.onServiceState).toBe(
      onServiceState,
    );
    // The configured executor's Substrate branch passes the reporter it builds for Docker and Kubernetes.
    const executor = build({}) as unknown as { options?: { jobs?: unknown } } & Record<string, unknown>;
    const jobs = findSubstrateLauncher(executor);
    expect(jobs).toBeInstanceOf(SubstrateJobLauncher);
    expect(typeof (jobs as unknown as { options: { onServiceState?: unknown } }).options.onServiceState).toBe(
      "function",
    );
  });

  it("passes the collect grace and startup timeout to the launcher, in milliseconds", () => {
    const launcher = buildSubstrateJobLauncher({
      env: { ...env, SUBSTRATE_COLLECT_GRACE_SEC: "45", SUBSTRATE_STARTUP_TIMEOUT_SEC: "900" },
      db,
      workspaceRoot: join(dir, "ws"),
      resolveCapability: async () => "cap",
      substrateApi: new FakeSubstrateApi({ workers: 1 }),
      kubernetesApi: new FakeKubernetesApi(),
    });
    const options = (launcher as unknown as { options: { collectGraceMs?: number; startupTimeoutMs?: number } })
      .options;
    expect(options.collectGraceMs).toBe(45_000);
    expect(options.startupTimeoutMs).toBe(900_000);
  });

  it("passes the template settings to the launcher, in milliseconds", () => {
    const build = (extra: Record<string, string>) =>
      (
        buildSubstrateJobLauncher({
          env: { ...env, ...extra },
          db,
          workspaceRoot: join(dir, "ws"),
          resolveCapability: async () => "cap",
          substrateApi: new FakeSubstrateApi({ workers: 1 }),
          kubernetesApi: new FakeKubernetesApi(),
        }) as unknown as {
          options: { templates: unknown; templateTtlMs?: number; templateReadyMs?: number; templateRetryMs?: number };
        }
      ).options;
    const options = build({
      SUBSTRATE_TEMPLATE_TTL_SEC: "86400",
      SUBSTRATE_TEMPLATE_READY_SEC: "300",
      SUBSTRATE_TEMPLATE_RETRY_SEC: "120",
    });
    expect(options.templates).toBeInstanceOf(PrismaSubstrateTemplateStore);
    expect(options.templateTtlMs).toBe(86_400_000);
    expect(options.templateReadyMs).toBe(300_000);
    expect(options.templateRetryMs).toBe(120_000);
    const defaults = build({});
    expect(defaults.templates).toBeInstanceOf(PrismaSubstrateTemplateStore);
    for (const key of ["templateTtlMs", "templateReadyMs", "templateRetryMs"]) expect(defaults).not.toHaveProperty(key);
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
  const cipher = {} as unknown as NonNullable<Parameters<typeof buildConfiguredExecutor>[0]["secretCipher"]>;

  it("sets the review action hook on a native-only deployment only with the cipher", () => {
    setReviewActionHook(undefined);
    expect(buildConfiguredExecutor({ native, db, env: { ...baseEnv } })).toBe(native);
    expect(getReviewActionHook()).toBeUndefined();
    expect(buildConfiguredExecutor({ native, db, env: { ...baseEnv }, secretCipher: cipher })).toBe(native);
    expect(getReviewActionHook()).toBeTypeOf("function");
    setReviewActionHook(undefined);
    const sandbox: Executor = { async start() {}, async stop() {} };
    const routed = buildConfiguredExecutor({
      native,
      nativeSandbox: sandbox,
      db,
      env: { ...baseEnv },
      secretCipher: cipher,
    });
    expect(routed).toBeInstanceOf(RoutingExecutor);
    expect(getReviewActionHook()).toBeTypeOf("function");
    setReviewActionHook(undefined);
  });

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

  it("reads the tunnel's CA certificate at start-up, so a missing or non-certificate file fails there", () => {
    const dir = mkdtempSync(join(tmpdir(), "tunnel-trust-"));
    try {
      const good = join(dir, "ca.crt");
      writeFileSync(good, "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n");
      const key = join(dir, "ca.key");
      writeFileSync(key, "-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n");
      const build = (file: string) =>
        buildConfiguredExecutor({
          native,
          db,
          env: {
            ...baseEnv,
            CODING_TUNNEL_PORT: "8789",
            CODING_TUNNEL_ALLOWED_HOSTS: "github.com",
            CODING_TUNNEL_TRUST_CA_CERT_FILE: file,
            JOB_LAUNCHER: "kubernetes",
            CODING_CLAUDE_WORKER_IMAGE: REGISTRY_IMAGE,
            CODING_CLAUDE_TOOL_RUNNER_IMAGE: REGISTRY_IMAGE,
          },
          kubernetesApi: new FakeKubernetesApi(),
        });
      expect(build(good)).toBeInstanceOf(RoutingExecutor);
      expect(() => build(join(dir, "missing.crt"))).toThrow("tunnel_ca_unreadable");
      expect(() => build(key)).toThrow("tunnel_ca_invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes the tunnel's CA certificate as PEM text, and refuses a key there without echoing it", () => {
    const keyBody = "ZmFrZS1jYS1rZXktbWFya2VyLTEyMw==";
    const build = (pem: string) =>
      buildConfiguredExecutor({
        native,
        db,
        env: {
          ...baseEnv,
          CODING_TUNNEL_PORT: "8789",
          CODING_TUNNEL_ALLOWED_HOSTS: "github.com",
          CODING_TUNNEL_TRUST_CA_CERT: pem,
          JOB_LAUNCHER: "kubernetes",
          CODING_CLAUDE_WORKER_IMAGE: REGISTRY_IMAGE,
          CODING_CLAUDE_TOOL_RUNNER_IMAGE: REGISTRY_IMAGE,
        },
        kubernetesApi: new FakeKubernetesApi(),
      });
    expect(build("-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n")).toBeInstanceOf(RoutingExecutor);
    let message = "";
    try {
      build(`-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----\n`);
    } catch (error) {
      message = String(error instanceof Error ? error.message : error);
    }
    expect(message).toBe("tunnel_ca_invalid");
    expect(message).not.toContain(keyBody);
  });

  it("reads the tunnel settings for Kubernetes and Docker, so an invalid one fails at start-up", () => {
    const tunnel = { CODING_TUNNEL_PORT: "8789" };
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: {
          ...baseEnv,
          ...tunnel,
          JOB_LAUNCHER: "kubernetes",
          CODING_CLAUDE_WORKER_IMAGE: REGISTRY_IMAGE,
          CODING_CLAUDE_TOOL_RUNNER_IMAGE: REGISTRY_IMAGE,
        },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toThrow("CODING_TUNNEL_ALLOWED_HOSTS");
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: {
          ...baseEnv,
          ...tunnel,
          JOB_LAUNCHER: "docker",
          CODING_PROXY_CONTAINER: "proxy",
          CODING_CLAUDE_WORKER_IMAGE: LOCAL_IMAGE,
          CODING_CLAUDE_TOOL_RUNNER_IMAGE: LOCAL_IMAGE,
        },
      }),
    ).toThrow("CODING_TUNNEL_ALLOWED_HOSTS");
    const valid = { ...tunnel, CODING_TUNNEL_ALLOWED_HOSTS: "github.com" };
    expect(
      buildConfiguredExecutor({
        native,
        db,
        env: {
          ...baseEnv,
          ...valid,
          JOB_LAUNCHER: "kubernetes",
          CODING_CLAUDE_WORKER_IMAGE: REGISTRY_IMAGE,
          CODING_CLAUDE_TOOL_RUNNER_IMAGE: REGISTRY_IMAGE,
        },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toBeInstanceOf(RoutingExecutor);
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

  it("rejects a Claude node-python 3.14 tool-runner image that isn't a registry digest on Kubernetes", () => {
    const REGISTRY_IMAGE = `registry.example/wardby-coding-worker@sha256:${"a".repeat(64)}`;
    expect(() =>
      buildConfiguredExecutor({
        native,
        db,
        env: {
          ...baseEnv,
          JOB_LAUNCHER: "kubernetes",
          CODING_WORKER_IMAGE: REGISTRY_IMAGE,
          CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_14: LOCAL_IMAGE,
        },
        kubernetesApi: new FakeKubernetesApi(),
      }),
    ).toThrow("CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_14 must be a registry digest");
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
  it("resolves once both are done, so the outbox chore ends only then", async () => {
    const review = await import("../../core/review-fix.js");
    const events = await import("../../core/host-events.js");
    const reReview = vi.spyOn(review, "reReviewAfterNoChangeFix").mockResolvedValueOnce(undefined);
    const release = vi.spyOn(events, "startDeferredForRequest").mockResolvedValueOnce(undefined);
    const deps = { db, executor: native, hosts: {}, repoAccess: {} } as never;
    await reReviewOnCodingRunTerminal(() => deps)("run-1");
    expect(reReview).toHaveBeenCalledWith("run-1", deps);
    expect(release).toHaveBeenCalledWith(deps, "run-1");
    reReview.mockRestore();
    release.mockRestore();
  });

  it("rejects when either fails, after trying both, so the chore is retried", async () => {
    const review = await import("../../core/review-fix.js");
    const events = await import("../../core/host-events.js");
    const reReview = vi.spyOn(review, "reReviewAfterNoChangeFix").mockRejectedValueOnce(new Error("boom"));
    const release = vi.spyOn(events, "startDeferredForRequest").mockResolvedValueOnce(undefined);
    const deps = { db, executor: native, hosts: {}, repoAccess: {} } as never;
    await expect(reReviewOnCodingRunTerminal(() => deps)("run-2")).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledWith(deps, "run-2");
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
    await reReviewOnCodingRunTerminal(() => deps)("cont");
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
    await step.run("turn:1:tool:0", () => reReviewOnCodingRunTerminal(() => deps)("run-3"));
    expect(seen).toHaveLength(2);
    expect(seen).toEqual([undefined, undefined]);
    reReview.mockRestore();
    release.mockRestore();
  });
});

describe("planTicketStarter", () => {
  const set = { id: "set-1", number: 12, repository: "o/r", issueProvider: null, issueKey: null } as never;
  /** A transaction as the start's guard sees it under the set's lock. */
  const tx = (approvedAt: Date | null, inFlight: number | null) => ({
    $queryRaw: vi.fn(async () => [{ approvedAt }]),
    codingRun: { findFirst: vi.fn(async () => (inFlight === null ? null : { planTicket: inFlight })) },
  });
  const starter = (seen: ReturnType<typeof tx>) =>
    planTicketStarter({
      db,
      executor: () => native,
      issueTrackers: undefined,
      dispatch: vi.fn(async (options: Parameters<typeof dispatchRunType>[0]) => {
        expect(await options.beforePersist!(seen as never, {} as never)).toBe(false);
        return null;
      }),
    });
  const input = {
    builderAgentId: "b",
    set,
    ticket: 4,
    starterId: null,
    trigger: "comment" as const,
    followedByChain: true,
  };

  it("a start the guard refuses reports what the guard saw under the lock, not plan_not_approved", async () => {
    expect(await starter(tx(new Date(), 3))(input)).toEqual({ running: 3 });
    expect(await starter(tx(null, null))(input)).toEqual({ refused: "plan_not_approved" });
  });

  it("asks dispatch to build from the started set only (expectedPlanSetId)", async () => {
    const dispatch = vi.fn(async (_options: Parameters<typeof dispatchRunType>[0]) => null);
    await planTicketStarter({ db, executor: () => native, issueTrackers: undefined, dispatch })(input);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ expectedPlanSetId: "set-1", planTicket: 4 }));
  });

  it("records the run as the chain's only when the chain follows it", async () => {
    for (const followedByChain of [true, false]) {
      const write = vi.fn(async () => [{ id: "set-1" }]);
      const start = planTicketStarter({
        db,
        executor: () => native,
        issueTrackers: undefined,
        dispatch: vi.fn(async (options: Parameters<typeof dispatchRunType>[0]) => {
          const run = { id: "run-9", status: "pending", error: null };
          await options.afterPersist!({ $queryRaw: write } as never, run as never);
          return { run } as never;
        }),
      });
      expect(await start({ ...input, followedByChain })).toEqual({ runId: "run-9" });
      expect(write).toHaveBeenCalledTimes(followedByChain ? 1 : 0);
    }
  });
});

describe("reviewRouterStarter", () => {
  const input = {
    routerAgentId: "r",
    task: "Review action: …",
    triggeredById: "p-1",
    jobId: "job-1",
    documentIds: ["d1", "d2"],
  };

  it("starts the router as a review_action run with the task, and records the run and its grants in one transaction", async () => {
    const jobUpdate = vi.fn(async () => ({}));
    const grants = vi.fn(async () => ({ count: 2 }));
    const dispatch = vi.fn(async (options: Parameters<typeof dispatchRunType>[0]) => {
      expect(await options.beforePersist!({} as never, { router: true } as never)).toBe(true);
      const run = { id: "run-7", status: "pending", error: null };
      await options.afterPersist!(
        { reviewJob: { update: jobUpdate }, runDocumentGrant: { createMany: grants } } as never,
        run as never,
      );
      return { run } as never;
    });
    const start = reviewRouterStarter({ db, executor: () => native, dispatch });
    expect(await start(input)).toEqual({ runId: "run-7" });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "r",
        trigger: "review_action",
        taskOverride: "Review action: …",
        triggeredById: "p-1",
      }),
    );
    expect(jobUpdate).toHaveBeenCalledWith({ where: { id: "job-1" }, data: { routerRunId: "run-7" } });
    expect(grants).toHaveBeenCalledWith({
      data: [
        { runId: "run-7", documentId: "d1" },
        { runId: "run-7", documentId: "d2" },
      ],
      skipDuplicates: true,
    });
  });

  it("an agent that is no longer a router is refused (review_router_invalid) and no run is made", async () => {
    const dispatch = vi.fn(async (options: Parameters<typeof dispatchRunType>[0]) => {
      expect(await options.beforePersist!({} as never, { router: false } as never)).toBe(false);
      return null;
    });
    expect(await reviewRouterStarter({ db, executor: () => native, dispatch })(input)).toEqual({
      refused: "review_router_invalid",
    });
  });

  it("a refused or failed run reports a refusal code, and a dispatch that throws rejects", async () => {
    for (const status of ["refused", "failed"]) {
      const dispatch = vi.fn(async () => ({ run: { id: "x", status, error: "budget_exhausted: over" } }) as never);
      expect(await reviewRouterStarter({ db, executor: () => native, dispatch })(input)).toEqual({
        refused: `run_${status}`,
      });
    }
    const throwing = vi.fn(async () => {
      throw new Error("agent_not_found");
    });
    // A throw is not turned into a refusal: the review hook records route_failed and the action still succeeds.
    await expect(reviewRouterStarter({ db, executor: () => native, dispatch: throwing })(input)).rejects.toThrow(
      "agent_not_found",
    );
  });
});
