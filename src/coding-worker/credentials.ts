/**
 * The Codex worker's credentials from its environment. On Docker and Kubernetes only
 * WARDBY_RUN_CAPABILITY is set, and the result is exactly that: the registry token is derived
 * from it as before. On Substrate the egress gateway injects the real capability, so the worker
 * holds only the placeholder (equal to the bridge's PLACEHOLDER_CAPABILITY; a test keeps them
 * equal), sends it in the x-api-key header, and is handed the run's registry token directly,
 * because it cannot derive that from a placeholder.
 *
 * Header mode needs all three together. Requiring the placeholder means a real capability can
 * never end up in Codex's `-c` command-line config, where header mode puts it.
 */
export const INJECTED_CAPABILITY_PLACEHOLDER = "rrp_placeholder_injected_by_gateway";
export const CAPABILITY_HEADER_ENV = "WARDBY_CAPABILITY_HEADER";
export const REGISTRY_TOKEN_ENV = "WARDBY_REGISTRY_TOKEN";
export const REGISTRY_TOKEN_SHAPE = /^rrg_[A-Za-z0-9_-]{43}$/;

export interface WorkerCredentials {
  capability: string;
  capabilityHeader?: "x-api-key";
  registryToken?: string;
}

/** Throws Error("worker_credentials_invalid") (not a safe code: surfaces as worker_execution_failed). */
export function readWorkerCredentials(env: NodeJS.ProcessEnv): WorkerCredentials {
  const capability = env.WARDBY_RUN_CAPABILITY;
  if (!capability) throw new Error("wardby_run_capability_missing");
  const header = env[CAPABILITY_HEADER_ENV];
  const registryToken = env[REGISTRY_TOKEN_ENV];
  if (header === undefined && registryToken === undefined) return { capability };
  // The message never names a value: neither the token nor the capability.
  if (
    header !== "x-api-key" ||
    capability !== INJECTED_CAPABILITY_PLACEHOLDER ||
    registryToken === undefined ||
    !REGISTRY_TOKEN_SHAPE.test(registryToken)
  ) {
    throw new Error("worker_credentials_invalid");
  }
  return { capability, capabilityHeader: header, registryToken };
}
