import { describe, it, expect } from "vitest";
import {
  loadAuthConfig,
  loadContainerExecutorConfig,
  loadProviderConfig,
  loadMcpConfig,
  loadGitHubVcsConfig,
  loadGitHubEventConfig,
  loadDbosConfig,
  loadCodingConcurrencyConfig,
  loadKubernetesJobConfig,
} from "./providers.js";

describe("provider config", () => {
  it("defaults auth to delegating", () => {
    expect(loadProviderConfig({}).auth).toBe("delegating");
  });

  it("accepts self-hosted as an auth kind", () => {
    expect(loadProviderConfig({ AUTH_PROVIDER: "self-hosted" }).auth).toBe("self-hosted");
  });

  it("defaults VCS to GitHub", () => {
    expect(loadProviderConfig({}).vcs).toBe("github");
  });
});

describe("loadGitHubVcsConfig", () => {
  it("loads credentials, workspace, API, and positive limits", () => {
    expect(
      loadGitHubVcsConfig({
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "private-key",
        VCS_WORK_ROOT: "/var/lib/wardby-vcs",
        GITHUB_API_VERSION: "2026-03-10",
        VCS_MAX_CHANGED_FILES: "50",
        VCS_MAX_DIFF_BYTES: "4096",
      }),
    ).toEqual({
      appId: "123",
      privateKey: "private-key",
      workRoot: "/var/lib/wardby-vcs",
      apiVersion: "2026-03-10",
      maxChangedFiles: 50,
      maxDiffBytes: 4096,
    });
  });

  it.each(["0", "-1", "1.5", "nope"])("rejects invalid VCS limits (%s)", (value) => {
    expect(() => loadGitHubVcsConfig({ VCS_MAX_DIFF_BYTES: value })).toThrow(
      "VCS_MAX_DIFF_BYTES must be a positive integer",
    );
  });
});

describe("loadContainerExecutorConfig", () => {
  it("loads immutable-worker and resource configuration with safe defaults", () => {
    expect(
      loadContainerExecutorConfig({
        CODING_WORKER_IMAGE: `worker@sha256:${"a".repeat(64)}`,
        CODING_PROXY_CONTAINER: "wardby-proxy",
        CODING_CPUS: "1.5",
      }),
    ).toMatchObject({
      proxyContainer: "wardby-proxy",
      cpus: 1.5,
      memoryMb: 2048,
      pids: 128,
      diskMb: 2048,
      credentialRef: "env:OPENAI_API_KEY",
      anthropicCredentialRef: "env:ANTHROPIC_API_KEY",
    });
  });

  it("loads the separate immutable Claude agent and tool-runner images", () => {
    const config = loadContainerExecutorConfig({
      CODING_CLAUDE_WORKER_IMAGE: `claude-worker@sha256:${"c".repeat(64)}`,
      CODING_CLAUDE_TOOL_RUNNER_IMAGE: `claude-tools@sha256:${"d".repeat(64)}`,
      CODING_ANTHROPIC_CREDENTIAL_REF: "env:ANTHROPIC_KEY",
    });
    expect(config).toMatchObject({
      claudeWorkerImage: `claude-worker@sha256:${"c".repeat(64)}`,
      claudeToolRunnerImage: `claude-tools@sha256:${"d".repeat(64)}`,
      anthropicCredentialRef: "env:ANTHROPIC_KEY",
    });
  });

  it.each(["0", "-1", "nope"])("rejects invalid container CPU limits (%s)", (value) => {
    expect(() => loadContainerExecutorConfig({ CODING_CPUS: value })).toThrow("CODING_CPUS must be a positive");
  });

  it("builds additionalWorkerImages from known CODING_WORKER_IMAGE_* env vars", () => {
    const config = loadContainerExecutorConfig({
      CODING_WORKER_IMAGE_NODE_PYTHON_3_12: `worker-python@sha256:${"b".repeat(64)}`,
    });
    expect(config.additionalWorkerImages).toEqual({
      "node-python": { "3.12": `worker-python@sha256:${"b".repeat(64)}` },
    });
  });

  it("additionalWorkerImages is empty when no toolchain env vars are set", () => {
    const config = loadContainerExecutorConfig({});
    expect(config.additionalWorkerImages).toEqual({});
  });

  it("defaults CODING_MAX_DISK_MB to the effective CODING_DISK_MB and accepts an explicit value in bounds", () => {
    expect(loadContainerExecutorConfig({}).maxDiskMb).toBe(loadContainerExecutorConfig({}).diskMb);
    expect(loadContainerExecutorConfig({ CODING_DISK_MB: "4096" }).maxDiskMb).toBe(4096);
    expect(loadContainerExecutorConfig({ CODING_MAX_DISK_MB: "16384" }).maxDiskMb).toBe(16384);
  });

  it.each(["63", "32769", "1.5", "nope"])("rejects CODING_MAX_DISK_MB out of the 64-32768 bounds (%s)", (value) => {
    expect(() => loadContainerExecutorConfig({ CODING_MAX_DISK_MB: value })).toThrow(
      "CODING_MAX_DISK_MB must be an integer between 64 and 32768",
    );
  });

  it("rejects a CODING_MAX_DISK_MB below the effective CODING_DISK_MB", () => {
    expect(() => loadContainerExecutorConfig({ CODING_DISK_MB: "4096", CODING_MAX_DISK_MB: "2048" })).toThrow(
      "CODING_MAX_DISK_MB (2048) must be at least the effective CODING_DISK_MB (4096)",
    );
  });

  it("accepts CODING_MAX_DISK_MB exactly equal to the effective CODING_DISK_MB", () => {
    expect(loadContainerExecutorConfig({ CODING_DISK_MB: "4096", CODING_MAX_DISK_MB: "4096" }).maxDiskMb).toBe(4096);
  });
});

describe("loadMcpConfig", () => {
  it("defaults to stdio + delegating with loopback bind", () => {
    const c = loadMcpConfig({});
    expect(c.transport).toBe("stdio");
    expect(c.canonicalUri).toBeUndefined();
    expect(c.localPrincipal).toBe("local");
  });

  it("reads http + canonical uri + audience", () => {
    const c = loadMcpConfig({
      MCP_TRANSPORT: "http",
      MCP_HTTP_BIND: "127.0.0.1:8080",
      MCP_CANONICAL_URI: "https://host/mcp",
    });
    expect(c.transport).toBe("http");
    expect(c.httpBind).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(c.canonicalUri).toBe("https://host/mcp");
  });

  it("defaults secretElicitationProtocol to off, and reads it on when explicitly set", () => {
    expect(loadMcpConfig({}).secretElicitationProtocol).toBe(false);
    expect(loadMcpConfig({ MCP_SECRET_ELICITATION_PROTOCOL: "true" }).secretElicitationProtocol).toBe(true);
  });
});

describe("loadDbosConfig", () => {
  it("generates a per-call UUID for the executor id when none is set, rather than leaving it undefined", () => {
    const config = loadDbosConfig({ DATABASE_URL: "postgresql://wardby:wardby@localhost:55432/wardby" });
    expect(config.systemDatabaseUrl).toBe("postgresql://wardby:wardby@localhost:55432/wardby");
    expect(config.schemaName).toBe("dbos");
    // v4 UUID shape: 8-4-4-4-12 hex, third group starts with "4".
    expect(config.executorId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("generates a different id on each call, so two processes never collide by default", () => {
    const a = loadDbosConfig({ DATABASE_URL: "postgresql://x" });
    const b = loadDbosConfig({ DATABASE_URL: "postgresql://x" });
    expect(a.executorId).not.toBe(b.executorId);
  });

  it("honours explicit overrides", () => {
    const config = loadDbosConfig({
      DATABASE_URL: "postgresql://a",
      DBOS_SYSTEM_DATABASE_URL: "postgresql://b",
      DBOS_SCHEMA: "durable",
      DBOS_EXECUTOR_ID: "scheduler-1",
    });
    expect(config).toEqual({ systemDatabaseUrl: "postgresql://b", schemaName: "durable", executorId: "scheduler-1" });
  });

  it("leaves systemDatabaseUrl undefined when neither variable is set", () => {
    expect(loadDbosConfig({}).systemDatabaseUrl).toBeUndefined();
  });
});

describe("loadCodingConcurrencyConfig", () => {
  it("defaults to 4 concurrent coding runs and a one-hour queue timeout", () => {
    expect(loadCodingConcurrencyConfig({})).toEqual({ maxConcurrent: 4, queueTimeoutSec: 3600 });
  });

  it("reads both settings", () => {
    expect(loadCodingConcurrencyConfig({ CODING_MAX_CONCURRENT: "12", CODING_QUEUE_TIMEOUT_SEC: "600" })).toEqual({
      maxConcurrent: 12,
      queueTimeoutSec: 600,
    });
  });

  it.each(["0", "-1", "1.5", "many"])("rejects CODING_MAX_CONCURRENT=%s", (value) => {
    expect(() => loadCodingConcurrencyConfig({ CODING_MAX_CONCURRENT: value })).toThrow(
      "CODING_MAX_CONCURRENT must be a positive integer.",
    );
  });

  it("rejects a non-positive CODING_QUEUE_TIMEOUT_SEC", () => {
    expect(() => loadCodingConcurrencyConfig({ CODING_QUEUE_TIMEOUT_SEC: "0" })).toThrow(
      "CODING_QUEUE_TIMEOUT_SEC must be a positive integer.",
    );
  });
});

describe("loadKubernetesJobConfig", () => {
  it("defaults to the wardby-coding namespace and proxy Service, with no context or runtime class", () => {
    expect(loadKubernetesJobConfig({})).toEqual({
      namespace: "wardby-coding",
      proxyService: "wardby-coding-proxy",
      platform: "generic",
    });
  });

  it("reads every setting", () => {
    expect(
      loadKubernetesJobConfig({
        KUBERNETES_NAMESPACE: "coding-staging",
        KUBERNETES_CONTEXT: "kind-wardby",
        KUBERNETES_PROXY_SERVICE: "proxy",
        KUBERNETES_RUNTIME_CLASS: "gvisor",
      }),
    ).toEqual({
      namespace: "coding-staging",
      context: "kind-wardby",
      proxyService: "proxy",
      runtimeClassName: "gvisor",
      platform: "generic",
    });
  });

  it.each(["", "Upper", "under_score", "-leading", "x".repeat(64)])("rejects KUBERNETES_NAMESPACE=%j", (value) => {
    expect(() => loadKubernetesJobConfig({ KUBERNETES_NAMESPACE: value })).toThrow(
      "KUBERNETES_NAMESPACE must be a DNS-1123 label.",
    );
  });

  it("rejects an invalid proxy Service name", () => {
    expect(() => loadKubernetesJobConfig({ KUBERNETES_PROXY_SERVICE: "Bad_Name" })).toThrow(
      "KUBERNETES_PROXY_SERVICE must be a DNS-1123 label.",
    );
  });

  it("defaults to the generic platform and leaves the timeouts unset", () => {
    const config = loadKubernetesJobConfig({});
    expect(config.platform).toBe("generic");
    expect(config.preflightTimeoutMs).toBeUndefined();
    expect(config.readyTimeoutMs).toBeUndefined();
  });

  it("accepts gke-autopilot", () => {
    expect(loadKubernetesJobConfig({ KUBERNETES_PLATFORM: "gke-autopilot" }).platform).toBe("gke-autopilot");
  });

  it("rejects an unknown platform", () => {
    expect(() => loadKubernetesJobConfig({ KUBERNETES_PLATFORM: "eks" })).toThrow(
      "KUBERNETES_PLATFORM must be one of: generic, gke-autopilot.",
    );
  });

  it("leaves the run pods' priority class unset by default", () => {
    expect(loadKubernetesJobConfig({})).not.toHaveProperty("priorityClassName");
    expect(loadKubernetesJobConfig({ KUBERNETES_RUN_PRIORITY_CLASS: "" })).not.toHaveProperty("priorityClassName");
  });

  it.each(["wardby-coding-run", "coding.runs", "a"])("reads KUBERNETES_RUN_PRIORITY_CLASS=%j", (value) => {
    expect(loadKubernetesJobConfig({ KUBERNETES_RUN_PRIORITY_CLASS: value }).priorityClassName).toBe(value);
  });

  it.each(["Upper", "under_score", "-leading", "trailing-", "a..b", ".a", "x".repeat(254)])(
    "rejects KUBERNETES_RUN_PRIORITY_CLASS=%j",
    (value) => {
      expect(() => loadKubernetesJobConfig({ KUBERNETES_RUN_PRIORITY_CLASS: value })).toThrow(
        "KUBERNETES_RUN_PRIORITY_CLASS must be a DNS-1123 subdomain.",
      );
    },
  );

  it.each(["system-cluster-critical", "system-node-critical"])(
    "refuses to run untrusted coding pods at the reserved class %j",
    (value) => {
      expect(() => loadKubernetesJobConfig({ KUBERNETES_RUN_PRIORITY_CLASS: value })).toThrow(
        "KUBERNETES_RUN_PRIORITY_CLASS must not name a system- priority class.",
      );
    },
  );

  it("reads the two cluster timeouts as bounded integers", () => {
    const config = loadKubernetesJobConfig({
      KUBERNETES_PREFLIGHT_TIMEOUT_MS: "600000",
      KUBERNETES_READY_TIMEOUT_MS: "600000",
    });
    expect(config.preflightTimeoutMs).toBe(600_000);
    expect(config.readyTimeoutMs).toBe(600_000);
    expect(() => loadKubernetesJobConfig({ KUBERNETES_READY_TIMEOUT_MS: "10" })).toThrow(
      "KUBERNETES_READY_TIMEOUT_MS must be an integer between 1000 and 900000.",
    );
  });
});

describe("loadGitHubEventConfig", () => {
  const VALID = "0123456789abcdef0123";

  it("is disabled when unset, empty, or whitespace", () => {
    expect(loadGitHubEventConfig({})).toEqual({ webhookSecret: undefined });
    expect(loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: "" })).toEqual({ webhookSecret: undefined });
    expect(loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: "   \n" })).toEqual({ webhookSecret: undefined });
  });

  it("trims and passes a valid secret through", () => {
    expect(loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: VALID })).toEqual({ webhookSecret: VALID });
    expect(loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: `  ${VALID}\n` })).toEqual({ webhookSecret: VALID });
  });

  it("throws on a secret shorter than 20 characters after trimming", () => {
    expect(() => loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: "short-secret" })).toThrow(
      "GITHUB_APP_WEBHOOK_SECRET must be at least 20 characters.",
    );
    expect(() => loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: ` ${VALID.slice(0, 19)} ` })).toThrow();
  });
});

describe("loadAuthConfig role mapping", () => {
  it("reads AUTH_ROLE_CLAIM / AUTH_ROLE_MAP, treating blanks as unset", () => {
    expect(
      loadAuthConfig({ AUTH_ROLE_CLAIM: "realm_access.roles", AUTH_ROLE_MAP: "wardby-admin=admin" }),
    ).toMatchObject({ roleClaim: "realm_access.roles", roleMap: "wardby-admin=admin" });
    expect(loadAuthConfig({ AUTH_ROLE_CLAIM: "  groups \n", AUTH_ROLE_MAP: " a=admin " })).toMatchObject({
      roleClaim: "groups",
      roleMap: "a=admin",
    });
    const blank = loadAuthConfig({ AUTH_ROLE_CLAIM: "  ", AUTH_ROLE_MAP: "" });
    expect(blank.roleClaim).toBeUndefined();
    expect(blank.roleMap).toBeUndefined();
  });
});
