/**
 * Rewrites the proxy download URLs a package manager records in lockfiles
 * back to public ones, for every adapter with a `lockfiles` hook. The driver
 * runs this on the workspace before it is collected, so a committed lockfile
 * never points at the sandbox-only proxy host.
 *
 * Best effort by design: a file that cannot be read or written safely is
 * skipped, never a reason to fail the run. The walk never follows symlinks
 * and skips the folders collection excludes by name (dependency and cache
 * folders), which are never sent back anyway.
 */
import { join } from "node:path";
import { REGISTRY_ADAPTERS } from "./adapters.js";
import type { EcosystemId, RegistryAdapter } from "./types.js";
import { rewriteWorkspaceFile, walkWorkspaceDirectories } from "./workspace-files.js";
import { registryUrlFor } from "./worker-config.js";

type Normalize = (content: string) => string;

/** Normalises every recognised lockfile under `workspace`; returns the
 *  workspace-relative paths it rewrote, sorted. */
export async function normalizeRegistryLockfiles(input: {
  workspace: string;
  proxyBaseUrl: string;
  /** The adapters whose lockfile hooks run (default: the public registries').
   *  The host passes the ones built from its JFrog settings, so a private
   *  scope's entries are rewritten back to the private registry's URLs. */
  adapters?: ReadonlyMap<EcosystemId, RegistryAdapter>;
}): Promise<string[]> {
  const byName = new Map<string, Normalize>();
  for (const adapter of (input.adapters ?? REGISTRY_ADAPTERS).values()) {
    const lockfiles = adapter.lockfiles;
    if (!lockfiles) continue;
    const registryUrl = registryUrlFor(input.proxyBaseUrl, adapter.id);
    for (const name of lockfiles.names) byName.set(name, (content) => lockfiles.normalize(content, registryUrl, name));
  }
  const rewritten: string[] = [];
  if (byName.size > 0) {
    await walkWorkspaceDirectories(input.workspace, async (directory, fileNames) => {
      for (const name of fileNames) {
        const normalize = byName.get(name);
        const path = directory ? `${directory}/${name}` : name;
        if (normalize && (await rewriteWorkspaceFile(join(input.workspace, path), normalize))) rewritten.push(path);
      }
    });
  }
  return rewritten.sort();
}
