/**
 * Which npm names come from a private registry and which from the public
 * one. A name inside a configured scope resolves only from the private
 * registry (never falls back to public npm: dependency confusion), and a
 * name outside them is never fetched from it.
 *
 * Kept free of imports from npm.ts, which imports this module.
 */
import type { PrivateRegistry } from "./types.js";

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

/** `@scope` for `@scope/name`, null for an unscoped name. */
export function scopeOf(name: string): string | null {
  if (!name.startsWith("@")) return null;
  const slash = name.indexOf("/");
  return slash < 0 ? null : name.slice(0, slash);
}

export function isPrivateNpmName(name: string, privateRegistry: PrivateRegistry | undefined): boolean {
  const scope = scopeOf(name);
  return privateRegistry !== undefined && scope !== null && privateRegistry.scopes.includes(scope);
}

/** The registry base URL `name` is fetched from. */
export function npmUpstreamFor(name: string, privateRegistry: PrivateRegistry | undefined): string {
  return isPrivateNpmName(name, privateRegistry) ? privateRegistry!.baseUrl : PUBLIC_NPM_REGISTRY;
}

/** Whether a lockfile entry for `name` may record `url` as where it was
 *  downloaded from: `publicBases` for a public name, the private registry
 *  for a scoped one, and the proxy's own route for either (a lockfile
 *  written through the proxy, before it is normalized at collection). */
export function sourceAllowedFor(
  name: string,
  url: string,
  options: { publicBases: readonly string[]; proxyRegistryUrl: string; privateRegistry?: PrivateRegistry },
): boolean {
  const bases = isPrivateNpmName(name, options.privateRegistry)
    ? [options.privateRegistry!.baseUrl]
    : options.publicBases;
  return [...bases, options.proxyRegistryUrl].some((base) => url.startsWith(base));
}
