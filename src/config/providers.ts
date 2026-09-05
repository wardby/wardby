/**
 * Provider selection from the environment.
 *
 * Which adapter backs each seam is pure configuration — swapping the default
 * (portable) deployment for a native cloud deployment is a config change, not a
 * code change. The `assembleProviders` factory (which constructs the concrete
 * adapters) is added once the adapters exist.
 */

export type JobLauncherKind = "local" | "ecs";
export type EmailProviderKind = "smtp" | "ses";
export type LlmProviderKind = "openai" | "bedrock";
export type SecretCipherKind = "app-key" | "kms";
export type AuthProviderKind = "generic-oidc" | "fusionauth";
export type BlobStoreKind = "local" | "s3";

export interface ProviderConfig {
  jobs: JobLauncherKind;
  email: EmailProviderKind;
  llm: LlmProviderKind;
  secrets: SecretCipherKind;
  auth: AuthProviderKind;
  storage: BlobStoreKind;
}

/** Read provider selection from environment variables, defaulting to portable. */
export function loadProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProviderConfig {
  return {
    jobs: (env.JOB_LAUNCHER as JobLauncherKind) ?? "local",
    email: (env.EMAIL_PROVIDER as EmailProviderKind) ?? "smtp",
    llm: (env.LLM_PROVIDER as LlmProviderKind) ?? "openai",
    secrets: (env.SECRET_CIPHER as SecretCipherKind) ?? "app-key",
    auth: (env.AUTH_PROVIDER as AuthProviderKind) ?? "generic-oidc",
    storage: (env.BLOB_STORE as BlobStoreKind) ?? "local",
  };
}
