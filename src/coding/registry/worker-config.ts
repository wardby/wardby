/**
 * Builds the full worker environment/file setup for every registry adapter
 * at once, from the run's derived registry-only token -- never the run
 * capability itself. The driver calls this once per coding run and applies
 * the result before the agent starts.
 */
import { REGISTRY_ADAPTERS } from "./adapters.js";
import { deriveRegistryToken } from "./token.js";

/** The URL the worker's package manager is pointed at for one ecosystem. */
export function registryUrlFor(proxyBaseUrl: string, ecosystem: string): string {
  return `${proxyBaseUrl.replace(/\/$/, "")}/registry/${ecosystem}/`;
}

export function registryWorkerSetup(input: { proxyBaseUrl: string; capability: string; cacheRoot: string }): {
  env: Record<string, string>;
  files: { path: string; content: string; mode: number }[];
} {
  const token = deriveRegistryToken(input.capability);
  const env: Record<string, string> = {};
  const files: { path: string; content: string; mode: number }[] = [];
  for (const adapter of REGISTRY_ADAPTERS.values()) {
    const config = adapter.workerConfig({
      registryUrl: registryUrlFor(input.proxyBaseUrl, adapter.id),
      token,
      cacheDir: `${input.cacheRoot}/${adapter.id}`,
    });
    Object.assign(env, config.env);
    for (const file of config.files) {
      if (!file.path.startsWith(`${input.cacheRoot}/`)) throw new Error("registry_worker_file_outside_cache");
      files.push(file);
    }
  }
  return { env, files };
}
