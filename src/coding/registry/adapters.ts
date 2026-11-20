/**
 * The registry adapter map: every ecosystem the coding package registry
 * proxies, keyed by its EcosystemId. Adding a new ecosystem means adding it
 * here (and to the allowlist/profile validation that reads this map) --
 * nothing else in the registry core hardcodes "npm" or "pypi".
 *
 * `REGISTRY_ADAPTERS` is the public-registry default (allowlist syntax, tests,
 * and any code that needs no upstream). Code that reaches an upstream, or that
 * rewrites lockfile URLs, builds its map with `createRegistryAdapters` from
 * the operator's JFrog settings instead.
 */
import { loadJfrogRegistryConfig, type JfrogRegistryConfig } from "./jfrog.js";
import { createNpmAdapter } from "./npm.js";
import { createPypiAdapter } from "./pypi.js";
import type { EcosystemId, RegistryAdapter } from "./types.js";

export function createRegistryAdapters(jfrog?: JfrogRegistryConfig): ReadonlyMap<EcosystemId, RegistryAdapter> {
  return new Map([createNpmAdapter(jfrog), createPypiAdapter(jfrog)].map((adapter) => [adapter.id, adapter]));
}

export const REGISTRY_ADAPTERS: ReadonlyMap<EcosystemId, RegistryAdapter> = createRegistryAdapters();

/** The adapters for the JFrog settings in `env` (none set: the public default). Throws on an invalid setting. */
export function configuredRegistryAdapters(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<EcosystemId, RegistryAdapter> {
  const jfrog = loadJfrogRegistryConfig(env);
  return jfrog ? createRegistryAdapters(jfrog) : REGISTRY_ADAPTERS;
}
