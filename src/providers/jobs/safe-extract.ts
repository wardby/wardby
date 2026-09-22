/**
 * Extracts an untrusted tar stream (a worker's workspace, streamed out of the
 * keeper) into a trusted, empty staging directory. Every entry is checked
 * before anything touches disk; nothing is ever written through a symlink,
 * and file creation is exclusive (O_EXCL), so an entry can never replace or
 * follow something already there. validateMaterializedWorkspace runs after
 * this as a second, independent pass.
 */
import { createWriteStream } from "node:fs";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";

export interface SafeExtractLimits {
  maxBytes: number;
  maxEntries: number;
}

function fail(code: string): never {
  throw new Error(code);
}

/** "./a/b" -> "a/b"; "./" -> "" (the root itself). Rejects anything that could leave the root. */
function normalize(name: string): string {
  if (name.includes("\0") || name.startsWith("/")) fail("extract_path_invalid");
  let path = name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (path === ".") path = "";
  if (path === "") return "";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) fail("extract_path_invalid");
  return path;
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

export async function safeExtract(source: Readable, root: string, limits: SafeExtractLimits): Promise<void> {
  const base = resolve(root);
  const symlinks = new Set<string>();
  const seen = new Set<string>();
  let entries = 0;
  let bytes = 0;
  const extract = tar.extract();
  source.on("error", (err) => extract.destroy(err));
  source.pipe(extract);

  for await (const entry of extract) {
    const { header } = entry;
    entries += 1;
    if (entries > limits.maxEntries) {
      entry.resume();
      fail("extract_entry_limit");
    }
    const path = normalize(header.name);
    if (path === "") {
      entry.resume();
      continue;
    }
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      if (symlinks.has(segments.slice(0, i).join("/"))) {
        entry.resume();
        fail("extract_through_symlink");
      }
    }
    if (seen.has(path)) {
      entry.resume();
      fail("extract_duplicate_entry");
    }
    seen.add(path);
    const target = resolve(base, path);
    if (!inside(base, target)) {
      entry.resume();
      fail("extract_path_invalid");
    }
    const parent = await lstat(dirname(target)).catch(() => undefined);
    if (parent && (parent.isSymbolicLink() || !parent.isDirectory())) {
      entry.resume();
      fail("extract_through_symlink");
    }

    switch (header.type) {
      case "directory": {
        entry.resume();
        await mkdir(target, { recursive: true, mode: 0o755 });
        const created = await lstat(target);
        if (created.isSymbolicLink() || !created.isDirectory()) fail("extract_through_symlink");
        break;
      }
      case "file":
      case "contiguous-file": {
        const size = header.size ?? 0;
        if (bytes + size > limits.maxBytes) {
          entry.resume();
          fail("extract_size_limit");
        }
        bytes += size;
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        const mode = (header.mode ?? 0) & 0o111 ? 0o755 : 0o644;
        try {
          await pipeline(entry, createWriteStream(target, { flags: "wx", mode }));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") fail("extract_duplicate_entry");
          throw err;
        }
        break;
      }
      case "symlink": {
        entry.resume();
        const link = header.linkname ?? "";
        if (link === "" || link.startsWith("/") || !inside(base, resolve(dirname(target), link))) {
          fail("extract_symlink_escape");
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await symlink(link, target);
        symlinks.add(path);
        break;
      }
      default:
        entry.resume();
        fail("extract_special_entry");
    }
  }
}
