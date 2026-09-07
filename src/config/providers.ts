/**
 * Provider selection from the environment.
 *
 * Which adapter backs each seam is pure configuration — swapping the default
 * (portable) deployment for a native cloud deployment is a config change, not a
 * code change. The `assembleProviders` factory (which constructs the concrete
 * adapters) is added once the adapters exist.
 */

export type JobLauncherKind = "local" | "docker" | "ecs";
export type EmailProviderKind = "smtp" | "ses";
export type LlmProviderKind = "openai" | "anthropic" | "bedrock";
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
  llm: LlmProviderKind;
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
    llm: (env.LLM_PROVIDER as LlmProviderKind) ?? "openai",
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

export interface ContainerExecutorConfig {
  workerImage?: string;
  proxyContainer?: string;
  stateRoot?: string;
  artifactRoot?: string;
  credentialRef: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  diskMb: number;
}

function optionalPositiveNumber(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

export function loadContainerExecutorConfig(env: NodeJS.ProcessEnv = process.env): ContainerExecutorConfig {
  return {
    workerImage: env.CODING_WORKER_IMAGE,
    proxyContainer: env.CODING_PROXY_CONTAINER,
    stateRoot: env.CODING_JOB_STATE_ROOT,
    artifactRoot: env.CODING_ARTIFACT_ROOT,
    credentialRef: env.CODING_OPENAI_CREDENTIAL_REF ?? "env:OPENAI_API_KEY",
    cpus: optionalPositiveNumber(env.CODING_CPUS, "CODING_CPUS", 1),
    memoryMb: optionalPositiveInteger(env.CODING_MEMORY_MB, "CODING_MEMORY_MB") ?? 2048,
    pids: optionalPositiveInteger(env.CODING_PIDS, "CODING_PIDS") ?? 128,
    diskMb: optionalPositiveInteger(env.CODING_DISK_MB, "CODING_DISK_MB") ?? 2048,
  };
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
  /** Both modes: the audience a token must carry to be accepted (reevo's canonical URI). */
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
   */
  executorId: string | undefined;
}

/** Read DBOS executor config from the environment (only used when EXECUTOR=dbos). */
export function loadDbosConfig(env: NodeJS.ProcessEnv = process.env): DbosConfig {
  return {
    systemDatabaseUrl: env.DBOS_SYSTEM_DATABASE_URL ?? env.DATABASE_URL,
    schemaName: env.DBOS_SCHEMA ?? "dbos",
    executorId: env.DBOS_EXECUTOR_ID,
  };
}
