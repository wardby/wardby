/**
 * The bounded, symlink-safe workspace walk and file access that lockfiles.ts
 * and the PyPI lockfile session (pypi-lockfiles/session.ts) share. The walk
 * never follows symlinks and skips the folders collection excludes by name
 * (dependency and cache folders), which are never sent back anyway. A file is
 * read or rewritten through a single descriptor (no symlinks, no path
 * re-resolution between the checks and the write).
 */
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_COLLECT_EXCLUDE_NAMES } from "../collect-exclude.js";

export const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 32;
const SKIPPED_DIRECTORIES = new Set<string>([...BUILTIN_COLLECT_EXCLUDE_NAMES, ".git"]);

/** Calls `visit` for every directory under `workspace` (relative path, "" for the root) with the names of its regular files. */
export async function walkWorkspaceDirectories(
  workspace: string,
  visit: (directory: string, fileNames: string[]) => Promise<void>,
): Promise<void> {
  const walk = async (relative: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(workspace, relative), { withFileTypes: true });
    } catch {
      return;
    }
    // Dirent types come from lstat semantics: a symlink is neither a directory nor a file here.
    await visit(
      relative,
      entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    );
    for (const entry of entries) {
      if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
        await walk(relative ? `${relative}/${entry.name}` : entry.name, depth + 1);
      }
    }
  };
  await walk("", 0);
}

/** The text of a regular file, or null when it cannot be read safely (symlink, too large, unreadable). */
export async function readWorkspaceFile(path: string, maxBytes = MAX_LOCKFILE_BYTES): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) return null;
    return (await file.readFile()).toString("utf8");
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/** Rewrites one file in place. `rewrite` returns the new content, or null to leave the file.
 *  Returns whether it changed; any failure leaves the file as it was found or skips it. */
export async function rewriteWorkspaceFile(path: string, rewrite: (before: string) => string | null): Promise<boolean> {
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
    const after = rewrite(before);
    if (after === null || after === before) return false;
    await file.truncate(0);
    await file.write(after, 0, "utf8");
    return true;
  } catch {
    return false;
  } finally {
    await file.close();
  }
}
