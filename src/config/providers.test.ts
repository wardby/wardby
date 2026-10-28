import { describe, it, expect } from "vitest";
import {
  loadAuthConfig,
  loadContainerExecutorConfig,
  loadProviderConfig,
  loadBlobStoreConfig,
  loadMcpConfig,
  loadGitHubVcsConfig,
  loadGitHubEventConfig,
  loadGitHubUserAuthConfig,
  loadDbosConfig,
  loadCodingConcurrencyConfig,
  loadShutdownDrainSeconds,
  loadKubernetesJobConfig,
  loadJiraConfig,
  loadSlackConfig,
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

  it("treats an unset BLOB_STORE as no blob store", () => {
    expect(loadProviderConfig({}).storage).toBeUndefined();
    expect(loadBlobStoreConfig({})).toBeUndefined();
  });

  it("accepts local, gcs and s3 and rejects anything else", () => {
    expect(loadProviderConfig({ BLOB_STORE: "gcs" }).storage).toBe("gcs");
    expect(loadProviderConfig({ BLOB_STORE: "s3" }).storage).toBe("s3");
    expect(() => loadProviderConfig({ BLOB_STORE: "azure" })).toThrow(/BLOB_STORE must be one of/);
  });

  it("requires BLOB_STORE_LOCAL_DIR for the local blob store", () => {
    expect(loadBlobStoreConfig({ BLOB_STORE: "local", BLOB_STORE_LOCAL_DIR: "/var/blobs" })).toEqual({
      kind: "local",
      localDir: "/var/blobs",
    });
    expect(() => loadBlobStoreConfig({ BLOB_STORE: "local" })).toThrow(/BLOB_STORE_LOCAL_DIR/);
  });

  it("requires a bucket for gcs and reads it", () => {
    expect(loadBlobStoreConfig({ BLOB_STORE: "gcs", BLOB_STORE_GCS_BUCKET: " snapshots " })).toEqual({
      kind: "gcs",
      bucket: "snapshots",
    });
    expect(() => loadBlobStoreConfig({ BLOB_STORE: "gcs" })).toThrow(/BLOB_STORE_GCS_BUCKET/);
  });

  it("requires a bucket and region for s3 and reads the optional endpoint", () => {
    const env = { BLOB_STORE: "s3", BLOB_STORE_S3_BUCKET: "snapshots", BLOB_STORE_S3_REGION: "eu-west-1" };
    expect(loadBlobStoreConfig(env)).toEqual({ kind: "s3", bucket: "snapshots", region: "eu-west-1" });
    expect(loadBlobStoreConfig({ ...env, BLOB_STORE_S3_ENDPOINT: "http://minio:9000" })).toEqual({
      kind: "s3",
      bucket: "snapshots",
      region: "eu-west-1",
      endpoint: "http://minio:9000",
    });
    expect(() => loadBlobStoreConfig({ ...env, BLOB_STORE_S3_BUCKET: "" })).toThrow(/BLOB_STORE_S3_BUCKET/);
    expect(() => loadBlobStoreConfig({ ...env, BLOB_STORE_S3_REGION: undefined })).toThrow(/BLOB_STORE_S3_REGION/);
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
  it("treats empty or blank image variables as unset and trims the rest", () => {
    const image = `worker@sha256:${"a".repeat(64)}`;
    const config = loadContainerExecutorConfig({
      CODING_WORKER_IMAGE: "",
      CODING_CLAUDE_WORKER_IMAGE: `  ${image}  `,
      CODING_CLAUDE_TOOL_RUNNER_IMAGE: " ",
      CODING_WORKER_IMAGE_NODE_PYTHON_3_12: "",
      CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12: "  ",
    });
    expect(config.workerImage).toBeUndefined();
    expect(config.claudeWorkerImage).toBe(image);
    expect(config.claudeToolRunnerImage).toBeUndefined();
    expect(config.additionalWorkerImages).toEqual({});
    expect(config.claudeToolRunnerImages).toEqual({});
  });

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

  it("loads Claude's node-python 3.12 tool-runner image when it is configured", () => {
    const image = `claude-tools-python@sha256:${"e".repeat(64)}`;
    expect(loadContainerExecutorConfig({ CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12: image })).toMatchObject({
      claudeToolRunnerImages: { "node-python": { "3.12": image } },
    });
    expect(loadContainerExecutorConfig({}).claudeToolRunnerImages).toEqual({});
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

describe("loadShutdownDrainSeconds", () => {
  it("defaults to 600, accepts 0 and positive integers, and rejects anything else", () => {
    expect(loadShutdownDrainSeconds({})).toBe(600);
    expect(loadShutdownDrainSeconds({ SHUTDOWN_DRAIN_SECONDS: "" })).toBe(600);
    expect(loadShutdownDrainSeconds({ SHUTDOWN_DRAIN_SECONDS: "0" })).toBe(0);
    expect(loadShutdownDrainSeconds({ SHUTDOWN_DRAIN_SECONDS: "120" })).toBe(120);
    for (const bad of ["-1", "1.5", "ten"]) {
      expect(() => loadShutdownDrainSeconds({ SHUTDOWN_DRAIN_SECONDS: bad })).toThrow(/SHUTDOWN_DRAIN_SECONDS/);
    }
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

  it("reads KUBERNETES_RESOURCE_QUOTA as a DNS label, unset by default", () => {
    expect(loadKubernetesJobConfig({}).resourceQuota).toBeUndefined();
    expect(loadKubernetesJobConfig({ KUBERNETES_RESOURCE_QUOTA: "wardby-coding" }).resourceQuota).toBe("wardby-coding");
    expect(() => loadKubernetesJobConfig({ KUBERNETES_RESOURCE_QUOTA: "Not A Label" })).toThrow(
      /KUBERNETES_RESOURCE_QUOTA/,
    );
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

  it("accepts eks", () => {
    expect(loadKubernetesJobConfig({ KUBERNETES_PLATFORM: "eks" }).platform).toBe("eks");
  });

  it("accepts gke-autopilot", () => {
    expect(loadKubernetesJobConfig({ KUBERNETES_PLATFORM: "gke-autopilot" }).platform).toBe("gke-autopilot");
  });

  it("rejects an unknown platform", () => {
    expect(() => loadKubernetesJobConfig({ KUBERNETES_PLATFORM: "aks" })).toThrow(
      "KUBERNETES_PLATFORM must be one of: generic, gke-autopilot, eks.",
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

  it("leaves the enforcement probe exec timeout unset by default", () => {
    expect(loadKubernetesJobConfig({}).enforcementExecTimeoutMs).toBeUndefined();
  });

  it("reads KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS as a bounded integer", () => {
    expect(loadKubernetesJobConfig({ KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS: "60000" }).enforcementExecTimeoutMs).toBe(
      60_000,
    );
  });

  it.each(["0", "500", "120001", "not-a-number"])(
    "rejects an out-of-range KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS=%j",
    (value) => {
      expect(() => loadKubernetesJobConfig({ KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS: value })).toThrow(
        "KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS must be an integer between 1000 and 120000.",
      );
    },
  );
});

describe("loadGitHubEventConfig", () => {
  const VALID = "0123456789abcdef0123";

  it("is disabled when unset, empty, or whitespace", () => {
    expect(loadGitHubEventConfig({})).toEqual({ webhookSecret: undefined, mentionExplanations: true });
    expect(loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: "" })).toMatchObject({ webhookSecret: undefined });
    expect(loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: "   \n" })).toMatchObject({ webhookSecret: undefined });
  });

  it("trims and passes a valid secret through", () => {
    expect(loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: VALID })).toMatchObject({ webhookSecret: VALID });
    expect(loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: `  ${VALID}\n` })).toMatchObject({
      webhookSecret: VALID,
    });
  });

  it("throws on a secret shorter than 20 characters after trimming", () => {
    expect(() => loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: "short-secret" })).toThrow(
      "GITHUB_APP_WEBHOOK_SECRET must be at least 20 characters.",
    );
    expect(() => loadGitHubEventConfig({ GITHUB_APP_WEBHOOK_SECRET: ` ${VALID.slice(0, 19)} ` })).toThrow();
  });

  it("reads WARDBY_MENTION_EXPLANATIONS as true or false, empty = true", () => {
    expect(loadGitHubEventConfig({}).mentionExplanations).toBe(true);
    expect(loadGitHubEventConfig({ WARDBY_MENTION_EXPLANATIONS: "" }).mentionExplanations).toBe(true);
    expect(loadGitHubEventConfig({ WARDBY_MENTION_EXPLANATIONS: "true" }).mentionExplanations).toBe(true);
    expect(loadGitHubEventConfig({ WARDBY_MENTION_EXPLANATIONS: " false\n" }).mentionExplanations).toBe(false);
    for (const bad of ["no", "0", "FALSE"]) {
      expect(() => loadGitHubEventConfig({ WARDBY_MENTION_EXPLANATIONS: bad })).toThrow(
        "WARDBY_MENTION_EXPLANATIONS must be true or false.",
      );
    }
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

describe("loadGitHubUserAuthConfig", () => {
  const ID = "Iv23liAbCdEf01234567";
  const SECRET = "0123456789abcdef0123456789abcdef01234567";

  it("is disabled when neither is set", () => {
    expect(loadGitHubUserAuthConfig({})).toEqual({ clientId: undefined, clientSecret: undefined });
    expect(loadGitHubUserAuthConfig({ GITHUB_APP_CLIENT_ID: " ", GITHUB_APP_CLIENT_SECRET: "" })).toEqual({
      clientId: undefined,
      clientSecret: undefined,
    });
  });

  it("trims and passes both through", () => {
    expect(
      loadGitHubUserAuthConfig({ GITHUB_APP_CLIENT_ID: ` ${ID} `, GITHUB_APP_CLIENT_SECRET: `${SECRET}\n` }),
    ).toEqual({ clientId: ID, clientSecret: SECRET });
  });

  it("refuses one without the other, and a malformed client id", () => {
    expect(() => loadGitHubUserAuthConfig({ GITHUB_APP_CLIENT_ID: ID })).toThrow(
      "Set both GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET, or neither.",
    );
    expect(() => loadGitHubUserAuthConfig({ GITHUB_APP_CLIENT_SECRET: SECRET })).toThrow(/Set both/);
    expect(() =>
      loadGitHubUserAuthConfig({ GITHUB_APP_CLIENT_ID: "123456", GITHUB_APP_CLIENT_SECRET: SECRET }),
    ).not.toThrow();
    expect(() =>
      loadGitHubUserAuthConfig({ GITHUB_APP_CLIENT_ID: "bad id/../", GITHUB_APP_CLIENT_SECRET: SECRET }),
    ).toThrow("GITHUB_APP_CLIENT_ID is not a valid GitHub App client ID.");
  });
});

describe("loadJiraConfig", () => {
  const GATEWAY = "https://api.atlassian.com/ex/jira/11111111-2222-3333-4444-555555555555";
  const base = {
    WARDBY_JIRA_SITE_URL: "https://your-site.atlassian.net/",
    WARDBY_JIRA_API_TOKEN: "tok",
    WARDBY_JIRA_API_BASE_URL: GATEWAY,
    WARDBY_JIRA_WEBHOOK_SECRET: "x".repeat(24),
  };
  it("is null when nothing is set", () => {
    expect(loadJiraConfig({})).toBeNull();
  });
  it("uses Bearer auth against the API gateway", () => {
    expect(loadJiraConfig(base)).toEqual({
      siteUrl: "https://your-site.atlassian.net",
      apiBaseUrl: GATEWAY,
      auth: { kind: "bearer", token: "tok" },
      webhookSecret: "x".repeat(24),
    });
  });
  it("accepts an optional Epic Link custom field id", () => {
    expect(loadJiraConfig({ ...base, WARDBY_JIRA_EPIC_LINK_FIELD: "customfield_10014" })?.epicLinkField).toBe(
      "customfield_10014",
    );
    expect(loadJiraConfig(base)?.epicLinkField).toBeUndefined();
  });
  it("rejects an Epic Link field that is not a custom field id", () => {
    expect(() => loadJiraConfig({ ...base, WARDBY_JIRA_EPIC_LINK_FIELD: "parent" })).toThrow(
      /WARDBY_JIRA_EPIC_LINK_FIELD/,
    );
  });
  it("accepts an uppercase cloudId", () => {
    const upper = "https://api.atlassian.com/ex/jira/ABCDEF12-2222-3333-4444-555555555555";
    expect(loadJiraConfig({ ...base, WARDBY_JIRA_API_BASE_URL: upper })?.apiBaseUrl).toBe(upper);
  });
  it("refuses a personal/Basic setup: an email set", () => {
    expect(() => loadJiraConfig({ ...base, WARDBY_JIRA_API_EMAIL: "bot@example.com" })).toThrow(/service account/);
  });
  it("requires the gateway API base URL", () => {
    const { WARDBY_JIRA_API_BASE_URL: _omit, ...noBase } = base;
    expect(() => loadJiraConfig(noBase)).toThrow(/WARDBY_JIRA_API_BASE_URL/);
    expect(() => loadJiraConfig({ ...base, WARDBY_JIRA_API_BASE_URL: "https://your-site.atlassian.net" })).toThrow(
      "api.atlassian.com/ex/jira/<cloudId>",
    );
  });
  it("requires the site URL to be a bare https origin", () => {
    for (const bad of [
      "https://your-site.atlassian.net/wiki",
      "https://your-site.atlassian.net/?a=1",
      "https://your-site.atlassian.net/#x",
      "https://user:pw@your-site.atlassian.net",
    ]) {
      expect(() => loadJiraConfig({ ...base, WARDBY_JIRA_SITE_URL: bad })).toThrow(/WARDBY_JIRA_SITE_URL/);
    }
  });
  it("refuses a partial config, a non-https site, a short secret, and a bad expiry", () => {
    expect(() => loadJiraConfig({ WARDBY_JIRA_SITE_URL: base.WARDBY_JIRA_SITE_URL })).toThrow(/WARDBY_JIRA_API_TOKEN/);
    expect(() => loadJiraConfig({ ...base, WARDBY_JIRA_SITE_URL: "http://your-site.atlassian.net" })).toThrow(/https/);
    expect(() => loadJiraConfig({ ...base, WARDBY_JIRA_WEBHOOK_SECRET: "short" })).toThrow(/20 characters/);
    expect(() => loadJiraConfig({ ...base, WARDBY_JIRA_API_TOKEN_EXPIRES_AT: "soon" })).toThrow(/ISO date/);
  });
  it("parses the token expiry", () => {
    expect(loadJiraConfig({ ...base, WARDBY_JIRA_API_TOKEN_EXPIRES_AT: "2027-09-01" })?.tokenExpiresAt).toEqual(
      new Date("2027-09-01T00:00:00.000Z"),
    );
  });
});

describe("loadSlackConfig", () => {
  it("is null when no Slack variable is set", () => {
    expect(loadSlackConfig({})).toBeNull();
  });
  it("parses a bot token with defaults", () => {
    expect(loadSlackConfig({ WARDBY_SLACK_BOT_TOKEN: "xoxb-1-2-abc" })).toEqual({
      botToken: "xoxb-1-2-abc",
      apiBaseUrl: "https://slack.com/api",
      customize: false,
    });
  });
  it("refuses a non-bot token", () => {
    expect(() => loadSlackConfig({ WARDBY_SLACK_BOT_TOKEN: "xoxp-user" })).toThrow(/xoxb-/);
  });
  it("refuses Slack options without a token", () => {
    expect(() => loadSlackConfig({ WARDBY_SLACK_CUSTOMIZE: "true" })).toThrow(/WARDBY_SLACK_BOT_TOKEN/);
  });
  it("accepts an https base override and customize=true", () => {
    expect(
      loadSlackConfig({
        WARDBY_SLACK_BOT_TOKEN: "xoxb-x",
        WARDBY_SLACK_API_BASE_URL: "https://slack.example.test/api/",
        WARDBY_SLACK_CUSTOMIZE: "true",
      }),
    ).toEqual({ botToken: "xoxb-x", apiBaseUrl: "https://slack.example.test/api", customize: true });
  });
  it("refuses a non-https base", () => {
    expect(() =>
      loadSlackConfig({ WARDBY_SLACK_BOT_TOKEN: "xoxb-x", WARDBY_SLACK_API_BASE_URL: "http://x/api" }),
    ).toThrow(/https/);
  });
});

describe("loadLocalRepoRoots (via providers config)", () => {
  it("is empty when LOCAL_REPO_ROOTS is unset", async () => {
    const { loadLocalRepoRoots } = await import("./providers.js");
    expect(loadLocalRepoRoots({})).toEqual({ roots: [], missing: [] });
  });
});
