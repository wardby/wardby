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

export interface ContainerExecutorConfig {
  workerImage?: string;
  claudeWorkerImage?: string;
  claudeToolRunnerImage?: string;
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

export function loadContainerExecutorConfig(env: NodeJS.ProcessEnv = process.env): ContainerExecutorConfig {
  const additionalWorkerImages: Record<string, Record<string, string>> = {};
  if (env.CODING_WORKER_IMAGE_NODE_PYTHON_3_12) {
    additionalWorkerImages["node-python"] = { "3.12": env.CODING_WORKER_IMAGE_NODE_PYTHON_3_12 };
  }
  const diskMb = optionalPositiveInteger(env.CODING_DISK_MB, "CODING_DISK_MB") ?? 2048;
  // Defaults to the effective diskMb: raising the ceiling an agents:write caller can request is an
  // explicit operator choice, so upgrading with an unchanged environment changes nothing.
  const maxDiskMb = optionalBoundedInteger(env.CODING_MAX_DISK_MB, "CODING_MAX_DISK_MB", 64, 32_768) ?? diskMb;
  if (maxDiskMb < diskMb) {
    throw new Error(`CODING_MAX_DISK_MB (${maxDiskMb}) must be at least the effective CODING_DISK_MB (${diskMb}).`);
  }
  return {
    workerImage: env.CODING_WORKER_IMAGE,
    claudeWorkerImage: env.CODING_CLAUDE_WORKER_IMAGE,
    claudeToolRunnerImage: env.CODING_CLAUDE_TOOL_RUNNER_IMAGE,
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

export function loadCodingConcurrencyConfig(env: NodeJS.ProcessEnv = process.env): CodingConcurrencyConfig {
  return {
    maxConcurrent: optionalPositiveInteger(env.CODING_MAX_CONCURRENT, "CODING_MAX_CONCURRENT") ?? 4,
    queueTimeoutSec: optionalPositiveInteger(env.CODING_QUEUE_TIMEOUT_SEC, "CODING_QUEUE_TIMEOUT_SEC") ?? 3600,
  };
}

const DNS_1123_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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
  platform: KubernetesPlatform;
  /**
   * Bound for the whole cluster preflight (canary pod scheduling included) and for how long a
   * launch waits for the keeper. Both default to the launcher's own values (90 s / 120 s), which
   * a cold managed cluster scheduling a sandboxed pod and pulling an image routinely exceeds.
   */
  preflightTimeoutMs?: number;
  readyTimeoutMs?: number;
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
  if (env.KUBERNETES_RUNTIME_CLASS) {
    config.runtimeClassName = dnsLabel(env.KUBERNETES_RUNTIME_CLASS, "KUBERNETES_RUNTIME_CLASS", "");
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
  if (preflightTimeoutMs !== undefined) config.preflightTimeoutMs = preflightTimeoutMs;
  if (readyTimeoutMs !== undefined) config.readyTimeoutMs = readyTimeoutMs;
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
