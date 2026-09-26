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
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_COLLECT_EXCLUDE_NAMES } from "../collect-exclude.js";
import { REGISTRY_ADAPTERS } from "./adapters.js";
import { registryUrlFor } from "./worker-config.js";

const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 32;
const SKIPPED_DIRECTORIES = new Set<string>([...BUILTIN_COLLECT_EXCLUDE_NAMES, ".git"]);

type Normalize = (content: string) => string;

/** Rewrites one file in place through a single descriptor (no symlinks, no
 *  path re-resolution between the checks and the write). Returns whether it
 *  changed; any failure leaves the file as it was found or skips it. */
async function normalizeFile(path: string, normalize: Normalize): Promise<boolean> {
  let file;
  try {
    file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return false;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_LOCKFILE_BYTES) return false;
    const before = (await file.readFile()).toString("utf8");
    const after = normalize(before);
    if (after === before) return false;
    await file.truncate(0);
    await file.write(after, 0, "utf8");
    return true;
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

/** Normalises every recognised lockfile under `workspace`; returns the
 *  workspace-relative paths it rewrote, sorted. */
export async function normalizeRegistryLockfiles(input: {
  workspace: string;
  proxyBaseUrl: string;
}): Promise<string[]> {
  const byName = new Map<string, Normalize>();
  for (const adapter of REGISTRY_ADAPTERS.values()) {
    const lockfiles = adapter.lockfiles;
    if (!lockfiles) continue;
    const registryUrl = registryUrlFor(input.proxyBaseUrl, adapter.id);
    for (const name of lockfiles.names) byName.set(name, (content) => lockfiles.normalize(content, registryUrl));
  }
  const rewritten: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(input.workspace, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      // Dirent types come from lstat semantics: a symlink is neither a directory nor a file here.
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) await walk(path, depth + 1);
      } else if (entry.isFile()) {
        const normalize = byName.get(entry.name);
        if (normalize && (await normalizeFile(join(input.workspace, path), normalize))) rewritten.push(path);
      }
    }
  };
  if (byName.size > 0) await walk("", 0);
  return rewritten.sort();
}
