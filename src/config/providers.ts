/**
 * Provider selection from the environment.
 *
 * Which adapter backs each seam is pure configuration — swapping the default
 * (portable) deployment for a native cloud deployment is a config change, not a
 * code change. The `assembleProviders` factory (which constructs the concrete
 * adapters) is added once the adapters exist.
 */
import { KUBERNETES_PLATFORMS, type KubernetesPlatform } from "../providers/jobs/kubernetes-platform.js";

export type JobLauncherKind = "local" | "docker" | "kubernetes";
export type EmailProviderKind = "smtp" | "ses";
export type SecretCipherKind = "app-key" | "kms";
export type AuthProviderKind = "delegating" | "self-hosted";
export type BlobStoreKind = "local" | "s3";
export type ExecutorKind = "in-process" | "dbos";
export type DatastoreKind = "postgres";
export type EngineKind = "native" | "langgraph";
export type VcsProviderKind = "github";

export interface ProviderConfig {
  jobs: JobLauncherKind;
  email: EmailProviderKind;
  secrets: SecretCipherKind;
  auth: AuthProviderKind;
  storage: BlobStoreKind;
  executor: ExecutorKind;
  datastore: DatastoreKind;
  engine: EngineKind;
  vcs: VcsProviderKind;
}

/** Read provider selection from environment variables, defaulting to portable. */
export function loadProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  return {
    jobs: (env.JOB_LAUNCHER as JobLauncherKind) ?? "local",
    email: (env.EMAIL_PROVIDER as EmailProviderKind) ?? "smtp",
    secrets: (env.SECRET_CIPHER as SecretCipherKind) ?? "app-key",
    auth: (env.AUTH_PROVIDER as AuthProviderKind) ?? "delegating",
    storage: (env.BLOB_STORE as BlobStoreKind) ?? "local",
    executor: (env.EXECUTOR as ExecutorKind) ?? "in-process",
    datastore: (env.DATASTORE as DatastoreKind) ?? "postgres",
    engine: (env.ENGINE as EngineKind) ?? "native",
    vcs: (env.VCS_PROVIDER as VcsProviderKind) ?? "github",
  };
}

export interface GitHubVcsConfig {
  appId?: string;
  privateKey?: string;
  workRoot?: string;
  apiVersion?: string;
  maxChangedFiles?: number;
  maxDiffBytes?: number;
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

/** Trusted roots for `local:` repositories (LOCAL_REPO_ROOTS, path-delimiter separated); unset = local repositories disabled. */
export { loadLocalRepoRoots } from "../coding/local-repo.js";

export function loadGitHubVcsConfig(env: NodeJS.ProcessEnv = process.env): GitHubVcsConfig {
  return {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    workRoot: env.VCS_WORK_ROOT,
    apiVersion: env.GITHUB_API_VERSION,
    maxChangedFiles: optionalPositiveInteger(env.VCS_MAX_CHANGED_FILES, "VCS_MAX_CHANGED_FILES"),
    maxDiffBytes: optionalPositiveInteger(env.VCS_MAX_DIFF_BYTES, "VCS_MAX_DIFF_BYTES"),
  };
}

/** GitHub App webhook settings for the code-review host ingress; unset = ingress disabled. */
export function loadGitHubEventConfig(env: NodeJS.ProcessEnv = process.env): { webhookSecret?: string } {
  const secret = env.GITHUB_APP_WEBHOOK_SECRET?.trim();
  if (secret !== undefined && secret !== "" && secret.length < 20) {
    throw new Error("GITHUB_APP_WEBHOOK_SECRET must be at least 20 characters.");
  }
  return { webhookSecret: secret || undefined };
}

/**
 * The GitHub App's OAuth client credentials, for linking a principal's GitHub
 * identity (link_host_account). Unset = linking is disabled; repository
 * authorization is still enforced (only admin approvals and existing
 * authorizations then work).
 */
export function loadGitHubUserAuthConfig(env: NodeJS.ProcessEnv = process.env): {
  clientId?: string;
  clientSecret?: string;
} {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim() || undefined;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim() || undefined;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error("Set both GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET, or neither.");
  }
  if (clientId !== undefined && !/^[A-Za-z0-9.]{1,64}$/.test(clientId)) {
    throw new Error("GITHUB_APP_CLIENT_ID is not a valid GitHub App client ID.");
  }
  return { clientId, clientSecret };
}

export interface JiraConfig {
  /** The site people browse, e.g. https://your-site.atlassian.net — used for issue links. A bare https origin. */
  siteUrl: string;
  /** Where REST calls go: always https://api.atlassian.com/ex/jira/<cloudId>, the only base a service-account token works against. */
  apiBaseUrl: string;
  /** A service account's API token, sent as a Bearer token. Personal (Basic email:token) auth is not supported. */
  auth: { kind: "bearer"; token: string };
  webhookSecret: string;
  /** Optional, for expiry warnings; Atlassian API tokens last at most a year. */
  tokenExpiresAt?: Date;
  /** Company-managed sites still on the legacy Epic Link field: its id (customfield_N). Optional. */
  epicLinkField?: string;
}

const JIRA_GATEWAY = /^https:\/\/api\.atlassian\.com\/ex\/jira\/[0-9a-f-]{36}$/i;

function httpsOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must be an https URL.`);
  return value.replace(/\/+$/, "");
}

/**
 * Jira Cloud issue-tracker settings (docs/jira-agents.md). Unset = Jira is
 * disabled. wardby acts in Jira only as an Atlassian service account, so
 * everything an agent does is attributed to that account: the token is sent
 * as a Bearer token and REST calls go through the api.atlassian.com gateway
 * (WARDBY_JIRA_API_BASE_URL, required). Personal tokens (Basic email:token)
 * are rejected.
 */
export function loadJiraConfig(env: NodeJS.ProcessEnv = process.env): JiraConfig | null {
  const site = env.WARDBY_JIRA_SITE_URL?.trim();
  const token = env.WARDBY_JIRA_API_TOKEN?.trim();
  const secret = env.WARDBY_JIRA_WEBHOOK_SECRET?.trim();
  const base = env.WARDBY_JIRA_API_BASE_URL?.trim();
  const expires = env.WARDBY_JIRA_API_TOKEN_EXPIRES_AT?.trim() || undefined;
  if (env.WARDBY_JIRA_API_EMAIL?.trim()) {
    throw new Error(
      "WARDBY_JIRA_API_EMAIL is no longer supported: personal (Basic email:token) Jira tokens are not accepted. " +
        "Use an Atlassian service account's API token with WARDBY_JIRA_API_BASE_URL=https://api.atlassian.com/ex/jira/<cloudId>.",
    );
  }
  if (!site && !token && !secret && !base) return null;
  if (!site || !token || !secret || !base) {
    throw new Error(
      "Set WARDBY_JIRA_SITE_URL, WARDBY_JIRA_API_BASE_URL, WARDBY_JIRA_API_TOKEN and WARDBY_JIRA_WEBHOOK_SECRET together, or none of them.",
    );
  }
  if (secret.length < 20) throw new Error("WARDBY_JIRA_WEBHOOK_SECRET must be at least 20 characters.");
  const siteUrl = httpsOrigin(site, "WARDBY_JIRA_SITE_URL");
  const siteParsed = new URL(siteUrl);
  if (
    siteParsed.pathname !== "/" ||
    siteParsed.search ||
    siteParsed.hash ||
    siteParsed.username ||
    siteParsed.password
  ) {
    throw new Error("WARDBY_JIRA_SITE_URL must be a bare https origin such as https://your-site.atlassian.net.");
  }
  const apiBaseUrl = httpsOrigin(base, "WARDBY_JIRA_API_BASE_URL");
  if (!JIRA_GATEWAY.test(apiBaseUrl)) {
    throw new Error(
      "WARDBY_JIRA_API_BASE_URL must be https://api.atlassian.com/ex/jira/<cloudId>, the only base a service " +
        "account's API token works against.",
    );
  }
  let tokenExpiresAt: Date | undefined;
  if (expires) {
    tokenExpiresAt = new Date(expires);
    if (Number.isNaN(tokenExpiresAt.getTime()))
      throw new Error("WARDBY_JIRA_API_TOKEN_EXPIRES_AT must be an ISO date.");
  }
  const epicLinkField = env.WARDBY_JIRA_EPIC_LINK_FIELD?.trim() || undefined;
  if (epicLinkField && !/^customfield_\d+$/.test(epicLinkField)) {
    throw new Error("WARDBY_JIRA_EPIC_LINK_FIELD must be a custom field id such as customfield_10014.");
  }
  return {
    siteUrl,
    apiBaseUrl,
    auth: { kind: "bearer", token },
    webhookSecret: secret,
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
    ...(epicLinkField ? { epicLinkField } : {}),
  };
}

export interface SlackConfig {
  botToken: string;
  apiBaseUrl: string;
  customize: boolean;
}

/** Slack workflow notifications; null when WARDBY_SLACK_BOT_TOKEN is unset (and no other Slack variable is). */
export function loadSlackConfig(env: NodeJS.ProcessEnv = process.env): SlackConfig | null {
  const token = env.WARDBY_SLACK_BOT_TOKEN?.trim();
  const base = env.WARDBY_SLACK_API_BASE_URL?.trim();
  const customizeRaw = env.WARDBY_SLACK_CUSTOMIZE?.trim().toLowerCase();
  if (!token) {
    if (base || customizeRaw)
      throw new Error("WARDBY_SLACK_API_BASE_URL/WARDBY_SLACK_CUSTOMIZE need WARDBY_SLACK_BOT_TOKEN.");
    return null;
  }
  if (!token.startsWith("xoxb-")) throw new Error("WARDBY_SLACK_BOT_TOKEN must be a bot token (xoxb-…).");
  let apiBaseUrl = "https://slack.com/api";
  if (base) {
    const url = new URL(base);
    if (url.protocol !== "https:") throw new Error("WARDBY_SLACK_API_BASE_URL must be an https URL.");
    apiBaseUrl = base.replace(/\/+$/, "");
  }
  if (customizeRaw && customizeRaw !== "true" && customizeRaw !== "false") {
    throw new Error("WARDBY_SLACK_CUSTOMIZE must be true or false.");
  }
  return { botToken: token, apiBaseUrl, customize: customizeRaw === "true" };
}

export interface ContainerExecutorConfig {
  workerImage?: string;
  claudeWorkerImage?: string;
  claudeToolRunnerImage?: string;
  /** Claude tool-runner images for toolchains beyond "node", keyed by toolchain, then version. */
  claudeToolRunnerImages: Record<string, Record<string, string>>;
  proxyContainer?: string;
  stateRoot?: string;
  artifactRoot?: string;
  credentialRef: string;
  anthropicCredentialRef: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  diskMb: number;
  /**
   * Operator ceiling on the per-agent CodingProfile.workspaceDiskMb (Task 9):
   * without it, any agents:write caller could size the RAM-backed Docker
   * tmpfs (and keeper memory) up to 32 GiB per run, times CODING_MAX_CONCURRENT.
   */
  maxDiskMb: number;
  additionalWorkerImages: Record<string, Record<string, string>>;
}

function optionalPositiveNumber(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function optionalBoundedInteger(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * An image variable's value, trimmed; empty or blank is unset. An env file that ships
 * `CODING_WORKER_IMAGE=` must read as "no Codex worker", not as an invalid image.
 */
export function imageVariable(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function loadContainerExecutorConfig(env: NodeJS.ProcessEnv = process.env): ContainerExecutorConfig {
  const additionalWorkerImages: Record<string, Record<string, string>> = {};
  const nodePythonWorker = imageVariable(env.CODING_WORKER_IMAGE_NODE_PYTHON_3_12);
  if (nodePythonWorker) additionalWorkerImages["node-python"] = { "3.12": nodePythonWorker };
  const claudeToolRunnerImages: Record<string, Record<string, string>> = {};
  const nodePythonToolRunner = imageVariable(env.CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12);
  if (nodePythonToolRunner) claudeToolRunnerImages["node-python"] = { "3.12": nodePythonToolRunner };
  const diskMb = optionalPositiveInteger(env.CODING_DISK_MB, "CODING_DISK_MB") ?? 2048;
  // Defaults to the effective diskMb: raising the ceiling an agents:write caller can request is an
  // explicit operator choice, so upgrading with an unchanged environment changes nothing.
  const maxDiskMb = optionalBoundedInteger(env.CODING_MAX_DISK_MB, "CODING_MAX_DISK_MB", 64, 32_768) ?? diskMb;
  if (maxDiskMb < diskMb) {
    throw new Error(`CODING_MAX_DISK_MB (${maxDiskMb}) must be at least the effective CODING_DISK_MB (${diskMb}).`);
  }
  return {
    workerImage: imageVariable(env.CODING_WORKER_IMAGE),
    claudeWorkerImage: imageVariable(env.CODING_CLAUDE_WORKER_IMAGE),
    claudeToolRunnerImage: imageVariable(env.CODING_CLAUDE_TOOL_RUNNER_IMAGE),
    claudeToolRunnerImages,
    proxyContainer: env.CODING_PROXY_CONTAINER,
    stateRoot: env.CODING_JOB_STATE_ROOT,
    artifactRoot: env.CODING_ARTIFACT_ROOT,
    credentialRef: env.CODING_OPENAI_CREDENTIAL_REF ?? "env:OPENAI_API_KEY",
    anthropicCredentialRef: env.CODING_ANTHROPIC_CREDENTIAL_REF ?? "env:ANTHROPIC_API_KEY",
    cpus: optionalPositiveNumber(env.CODING_CPUS, "CODING_CPUS", 1),
    memoryMb: optionalPositiveInteger(env.CODING_MEMORY_MB, "CODING_MEMORY_MB") ?? 2048,
    pids: optionalPositiveInteger(env.CODING_PIDS, "CODING_PIDS") ?? 128,
    diskMb,
    maxDiskMb,
    additionalWorkerImages,
  };
}

/**
 * Caps coding runs holding a concurrency slot across every control-plane
 * replica (enforced in Postgres, see PrismaContainerExecutionStore), and how
 * long a run may wait for one before failing with coding_queue_timeout.
 */
export interface CodingConcurrencyConfig {
  maxConcurrent: number;
  queueTimeoutSec: number;
}

/**
 * How long a shutting-down instance waits for its in-flight native runs
 * before closing the executor (SHUTDOWN_DRAIN_SECONDS, default 600; 0 = do
 * not wait). Keep the platform's termination grace period above this.
 */
/** The native sandbox (docs/native-sandbox.md): where sandbox-mode native runs execute. */
interface NativeSandboxCommonConfig {
  workerImage: string;
  /** What a worker dials; undefined = the launcher's default (Docker: the gateway alias; Kubernetes: the Service's ClusterIP). */
  gatewayUrl?: string;
  cpus: number;
  memoryMb: number;
  /** Docker only: Kubernetes has no per-pod process limit (it is a node-level kubelet setting). */
  pids: number;
}

export interface DockerNativeSandboxConfig extends NativeSandboxCommonConfig {
  launcher: "docker";
  /** The container running `wardby native-gateway`, joined to each run's network. */
  gatewayContainer: string;
}

export interface KubernetesNativeSandboxConfig extends NativeSandboxCommonConfig {
  launcher: "kubernetes";
  /** Where run pods (and the native gateway) live. */
  namespace: string;
  context?: string;
  /** The native gateway's Service in that namespace. */
  gatewayService: string;
  runtimeClassName?: string;
}

export type NativeSandboxConfig = DockerNativeSandboxConfig | KubernetesNativeSandboxConfig;

/** Undefined when NATIVE_SANDBOX_LAUNCHER is unset (sandbox-mode runs then fail closed). Throws on a bad configuration. */
export function loadNativeSandboxConfig(env: NodeJS.ProcessEnv = process.env): NativeSandboxConfig | undefined {
  const launcher = env.NATIVE_SANDBOX_LAUNCHER?.trim();
  if (!launcher) return undefined;
  if (launcher !== "docker" && launcher !== "kubernetes") {
    throw new Error(`NATIVE_SANDBOX_LAUNCHER must be "docker" or "kubernetes" (got "${launcher}").`);
  }
  const workerImage = imageVariable(env.NATIVE_SANDBOX_WORKER_IMAGE);
  if (!workerImage)
    throw new Error(`NATIVE_SANDBOX_WORKER_IMAGE is required when NATIVE_SANDBOX_LAUNCHER=${launcher}.`);
  const gatewayUrl = env.NATIVE_GATEWAY_URL?.trim();
  if (gatewayUrl && !/^https?:\/\/[^\s]+$/.test(gatewayUrl)) {
    throw new Error(`NATIVE_GATEWAY_URL must be an http(s) URL (got "${gatewayUrl}").`);
  }
  const common = {
    workerImage,
    ...(gatewayUrl ? { gatewayUrl } : {}),
    cpus: optionalPositiveNumber(env.NATIVE_SANDBOX_CPUS, "NATIVE_SANDBOX_CPUS", 1),
    memoryMb: optionalPositiveInteger(env.NATIVE_SANDBOX_MEMORY_MB, "NATIVE_SANDBOX_MEMORY_MB") ?? 512,
    pids: optionalPositiveInteger(env.NATIVE_SANDBOX_PIDS, "NATIVE_SANDBOX_PIDS") ?? 128,
  };
  if (launcher === "kubernetes") {
    // A cluster pulls by registry digest; a local image id means nothing to it.
    if (!/@sha256:[0-9a-f]{64}$/.test(workerImage)) {
      throw new Error(
        "NATIVE_SANDBOX_WORKER_IMAGE must be a registry digest (repo@sha256:...) when NATIVE_SANDBOX_LAUNCHER=kubernetes.",
      );
    }
    const namespace = env.NATIVE_SANDBOX_NAMESPACE?.trim() || env.KUBERNETES_NAMESPACE?.trim() || "wardby-coding";
    const runtimeClassName =
      env.NATIVE_SANDBOX_RUNTIME_CLASS?.trim() || env.KUBERNETES_RUNTIME_CLASS?.trim() || undefined;
    const context = env.KUBERNETES_CONTEXT?.trim() || undefined;
    return {
      launcher,
      ...common,
      namespace,
      gatewayService: env.NATIVE_GATEWAY_SERVICE?.trim() || "wardby-native-gateway",
      ...(context ? { context } : {}),
      ...(runtimeClassName ? { runtimeClassName } : {}),
    };
  }
  const gatewayContainer = env.NATIVE_GATEWAY_CONTAINER?.trim();
  if (!gatewayContainer) throw new Error("NATIVE_GATEWAY_CONTAINER is required when NATIVE_SANDBOX_LAUNCHER=docker.");
  return { launcher, ...common, gatewayContainer };
}

export function loadShutdownDrainSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.SHUTDOWN_DRAIN_SECONDS?.trim();
  if (!value) return 600;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("SHUTDOWN_DRAIN_SECONDS must be a non-negative integer.");
  }
  return parsed;
}

export function loadCodingConcurrencyConfig(env: NodeJS.ProcessEnv = process.env): CodingConcurrencyConfig {
  return {
    maxConcurrent: optionalPositiveInteger(env.CODING_MAX_CONCURRENT, "CODING_MAX_CONCURRENT") ?? 4,
    queueTimeoutSec: optionalPositiveInteger(env.CODING_QUEUE_TIMEOUT_SEC, "CODING_QUEUE_TIMEOUT_SEC") ?? 3600,
  };
}

const DNS_1123_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const DNS_1123_SUBDOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

function dnsLabel(value: string | undefined, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (!DNS_1123_LABEL.test(value)) throw new Error(`${name} must be a DNS-1123 label.`);
  return value;
}

/** JOB_LAUNCHER=kubernetes: where coding-run pods go, how they reach the in-cluster proxy, and which platform's admission rules apply. */
export interface KubernetesJobConfig {
  namespace: string;
  context?: string;
  proxyService: string;
  runtimeClassName?: string;
  /**
   * PriorityClass for coding-run pods (and the preflight canary). Unset = no class, the pod
   * spec exactly as before. The class must exist in the cluster, or every create is refused.
   */
  priorityClassName?: string;
  platform: KubernetesPlatform;
  /**
   * Bound for the whole cluster preflight (canary pod scheduling included) and for how long a
   * launch waits for the keeper. Both default to the launcher's own values (90 s / 120 s), which
   * a cold managed cluster scheduling a sandboxed pod and pulling an image routinely exceeds.
   */
  preflightTimeoutMs?: number;
  readyTimeoutMs?: number;
  /**
   * Time budget for a single NetworkPolicy-enforcement probe (the keeper running two sequential
   * connects); a streak's probes share one exec whose timeout the launcher derives from this.
   * Defaults to the launcher's own 10 s, which a resource-constrained keeper (e.g. a
   * laptop `kind` cluster's default 250m CPU / 128Mi limit) can exceed even though the probe
   * itself is healthy — observed live: raising this to 60_000 was enough on `kind`. GKE Autopilot
   * is unaffected by leaving this unset. The launcher derives its overall enforcement wall-clock
   * bound from whichever value is effective here (see KubernetesJobLauncher), so raising this
   * alone is sufficient — no separate overall-timeout knob needs to move in lockstep.
   */
  enforcementExecTimeoutMs?: number;
  /**
   * The namespace ResourceQuota coding-run pods count against (KUBERNETES_RESOURCE_QUOTA). When
   * set, a run whose pod would not fit the quota's free room waits in the coding queue instead of
   * failing when the API server refuses the pod. Unset = no check (the RBAC grant is by name).
   */
  resourceQuota?: string;
}

export function loadKubernetesJobConfig(env: NodeJS.ProcessEnv = process.env): KubernetesJobConfig {
  const platform = (env.KUBERNETES_PLATFORM ?? "generic") as KubernetesPlatform;
  if (!KUBERNETES_PLATFORMS.includes(platform)) {
    throw new Error(`KUBERNETES_PLATFORM must be one of: ${KUBERNETES_PLATFORMS.join(", ")}.`);
  }
  const config: KubernetesJobConfig = {
    namespace: dnsLabel(env.KUBERNETES_NAMESPACE, "KUBERNETES_NAMESPACE", "wardby-coding"),
    proxyService: dnsLabel(env.KUBERNETES_PROXY_SERVICE, "KUBERNETES_PROXY_SERVICE", "wardby-coding-proxy"),
    platform,
  };
  if (env.KUBERNETES_CONTEXT) config.context = env.KUBERNETES_CONTEXT;
  if (env.KUBERNETES_RESOURCE_QUOTA) {
    config.resourceQuota = dnsLabel(env.KUBERNETES_RESOURCE_QUOTA, "KUBERNETES_RESOURCE_QUOTA", "");
  }
  if (env.KUBERNETES_RUNTIME_CLASS) {
    config.runtimeClassName = dnsLabel(env.KUBERNETES_RUNTIME_CLASS, "KUBERNETES_RUNTIME_CLASS", "");
  }
  if (env.KUBERNETES_RUN_PRIORITY_CLASS) {
    const name = env.KUBERNETES_RUN_PRIORITY_CLASS;
    if (!DNS_1123_SUBDOMAIN.test(name)) {
      throw new Error("KUBERNETES_RUN_PRIORITY_CLASS must be a DNS-1123 subdomain.");
    }
    // The system- classes are the cluster's own critical tier: an untrusted coding pod there
    // would preempt the control plane and kube-system workloads instead of yielding to them.
    if (name.startsWith("system-")) {
      throw new Error("KUBERNETES_RUN_PRIORITY_CLASS must not name a system- priority class.");
    }
    config.priorityClassName = name;
  }
  const preflightTimeoutMs = optionalBoundedInteger(
    env.KUBERNETES_PREFLIGHT_TIMEOUT_MS,
    "KUBERNETES_PREFLIGHT_TIMEOUT_MS",
    1_000,
    900_000,
  );
  const readyTimeoutMs = optionalBoundedInteger(
    env.KUBERNETES_READY_TIMEOUT_MS,
    "KUBERNETES_READY_TIMEOUT_MS",
    1_000,
    900_000,
  );
  // Ceiling of 2 minutes: this bounds a single probe exec, not the overall gate (which the
  // launcher derives from it), so it never needs to be anywhere near the 15-minute cluster
  // timeouts above.
  const enforcementExecTimeoutMs = optionalBoundedInteger(
    env.KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS,
    "KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS",
    1_000,
    120_000,
  );
  if (preflightTimeoutMs !== undefined) config.preflightTimeoutMs = preflightTimeoutMs;
  if (readyTimeoutMs !== undefined) config.readyTimeoutMs = readyTimeoutMs;
  if (enforcementExecTimeoutMs !== undefined) config.enforcementExecTimeoutMs = enforcementExecTimeoutMs;
  return config;
}

export interface McpConfig {
  allowedOrigins?: string[];
  transport: "http" | "stdio";
  httpBind?: { host: string; port: number };
  canonicalUri?: string;
  localPrincipal: string;
  /**
   * Use the MCP spec's own multi-round-trip URL-mode elicitation
   * (`InputRequiredResult`) for interactive secret entry, instead of the
   * plain-text "here's a link, call me again" fallback. Off by default:
   * as of Claude Code 2.1.263, this stdio client doesn't declare the
   * elicitation capability for local project servers, so the protocol
   * path fails outright ("did not declare the required capability").
   * Flip this on once that's fixed client-side — no server code changes
   * needed, both paths share the same signed-token/browser-form core.
   */
  secretElicitationProtocol: boolean;
}

/** Read MCP server transport/binding config from the environment. */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const transport = (env.MCP_TRANSPORT as "http" | "stdio") ?? "stdio";
  const bind = env.MCP_HTTP_BIND?.split(":");
  return {
    transport,
    httpBind: bind ? { host: bind[0], port: Number(bind[1]) } : undefined,
    canonicalUri: env.MCP_CANONICAL_URI,
    allowedOrigins: env.MCP_ALLOWED_ORIGINS ? env.MCP_ALLOWED_ORIGINS.split(",").map((s) => s.trim()) : undefined,
    localPrincipal: env.LOCAL_PRINCIPAL ?? "local",
    secretElicitationProtocol: env.MCP_SECRET_ELICITATION_PROTOCOL === "true",
  };
}

export interface AuthConfig {
  /** Delegating mode: the external IdP's issuer URL. */
  issuer?: string;
  /** Delegating mode: JWKS endpoint for signature verification. */
  jwksUri?: string;
  /** Delegating mode: access-token claim carrying the IdP's roles/groups (AUTH_ROLE_CLAIM). */
  roleClaim?: string;
  /** Delegating mode: `idpValue=wardbyRole,...` (AUTH_ROLE_MAP). */
  roleMap?: string;
  /** Both modes: the audience a token must carry to be accepted (wardby's canonical URI). */
  audience?: string;
  /** Self-hosted mode: independent 32-byte hex keys. */
  signingKey?: string;
  credentialHashKey?: string;
  maxClients?: number;
}

/** Read auth-adapter config (issuer/JWKS/audience/signing key) from the environment. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    issuer: env.AUTH_ISSUER,
    jwksUri: env.AUTH_JWKS_URI,
    roleClaim: env.AUTH_ROLE_CLAIM?.trim() || undefined,
    roleMap: env.AUTH_ROLE_MAP?.trim() || undefined,
    audience: env.AUTH_AUDIENCE,
    signingKey: env.AUTH_SIGNING_KEY,
    credentialHashKey: env.AUTH_CREDENTIAL_HASH_KEY,
    maxClients: env.AUTH_MAX_CLIENTS ? Number(env.AUTH_MAX_CLIENTS) : undefined,
  };
}

export interface SecretConfig {
  /** app-key mode: 32-byte hex-encoded AES-256-GCM master key. */
  appKey?: string;
}

/** Read secret-cipher config (the app-key master key) from the environment. */
export function loadSecretConfig(env: NodeJS.ProcessEnv = process.env): SecretConfig {
  return {
    appKey: env.SECRET_APP_KEY,
  };
}

export interface DbosConfig {
  /**
   * Where DBOS keeps its workflow/step tables. Defaults to DATABASE_URL —
   * the tables live in their own schema (`schemaName`), so Prisma's `public`
   * schema and the migration drift check are untouched.
   */
  systemDatabaseUrl: string | undefined;
  schemaName: string;
  /**
   * Stable per-*process* executor identity. At launch DBOS re-drives every
   * PENDING workflow that this id owned, so a restarted process picks up its
   * own interrupted runs — which also means two processes sharing an id each
   * re-drive the other's live workflows. There is deliberately no default:
   * `DbosExecutor` refuses to construct without one (a default would silently
   * give the scheduler and the MCP server the same identity).
   *
   * Defaults to a freshly generated UUID per call (per process) when unset
   * — not left undefined — so two replicas of a horizontally-scaled
   * deployment (e.g. a Cloud Run service with min_instance_count > 1) never
   * silently share an identity just because no one set one explicitly. An
   * explicit DBOS_EXECUTOR_ID still always wins, for local dev or a small
   * deployment wanting a stable, human-readable id across restarts.
   */
  executorId: string | undefined;
}

/** Read DBOS executor config from the environment (only used when EXECUTOR=dbos). */
export function loadDbosConfig(env: NodeJS.ProcessEnv = process.env): DbosConfig {
  return {
    systemDatabaseUrl: env.DBOS_SYSTEM_DATABASE_URL ?? env.DATABASE_URL,
    schemaName: env.DBOS_SCHEMA ?? "dbos",
    executorId: env.DBOS_EXECUTOR_ID ?? crypto.randomUUID(),
  };
}
