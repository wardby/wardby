/**
 * The registry adapter map: every ecosystem the coding package registry
 * proxies, keyed by its EcosystemId. Adding a new ecosystem means adding it
 * here (and to the allowlist/profile validation that reads this map) --
 * nothing else in the registry core hardcodes "npm" or "pypi".
 */
import { npmAdapter } from "./npm.js";
import { pypiAdapter } from "./pypi.js";
import type { EcosystemId, RegistryAdapter } from "./types.js";

export const REGISTRY_ADAPTERS: ReadonlyMap<EcosystemId, RegistryAdapter> = new Map(
  [npmAdapter, pypiAdapter].map((adapter) => [adapter.id, adapter]),
);
