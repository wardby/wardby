/**
 * Extracts an untrusted tar stream (a worker's workspace, streamed out of the
 * keeper) into a trusted, empty staging directory. Nothing is ever written
 * through a symlink, and file creation is exclusive (O_EXCL), so an entry can
 * never replace or follow something already there. validateMaterializedWorkspace
 * runs after this as a second, independent pass.
 *
 * Extraction is two-phase. Phase 1 (streaming) creates directories and regular
 * files, and only *records* symlink entries (name/target validated lexically,
 * but nothing symlink-shaped ever touches disk while the stream is live) —
 * that alone makes it impossible for a write to pass through a symlink,
 * regardless of filesystem case-folding. Phase 2 creates every recorded
 * symlink, then re-validates each one by walking the real, already-written
 * filesystem (readlink/lstat, following any chain of in-tree symlinks) to
 * confirm its fully-resolved target is still inside root; a lexical check
 * alone can't catch a chain of relative symlinks whose composed target
 * physically escapes, or a symlink that collides case-insensitively with a
 * path phase 1 already created.
 *
 * Directory creation in *either* phase never delegates to `mkdir`'s own
 * `recursive: true` walk, and never `chmod`s a path it hasn't just verified
 * itself: both of those follow an existing symlink transparently at the OS
 * level, so a recursive mkdir (or a chmod) issued against a path whose
 * middle component is a symlink — including one phase 2 created moments
 * earlier for an *unrelated* entry, aliased case-insensitively — silently
 * creates or re-permissions something outside root. `ensureDirectory` walks
 * one component at a time instead, `lstat`-verifying each one is a real,
 * non-symlink directory before creating the next component under it or
 * `chmod`ing it.
 *
 * Every await that isn't pure bookkeeping is raced against a `failed`
 * promise that's already wired to the extractor's and source's 'error'
 * events (and to `options.signal`) *before* any of those awaits happen, so a
 * failure that occurs during an async gap — e.g. between receiving an entry
 * and starting to read its body — can't be missed the way a late-attached
 * listener (as `stream/promises`' `pipeline` effectively is, here) would
 * miss it and hang forever on a truncated archive.
 */
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, readlink, realpath, symlink as createSymlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import tar from "tar-stream";

export interface SafeExtractLimits {
  maxBytes: number;
  maxEntries: number;
}

export interface SafeExtractOptions {
  signal?: AbortSignal;
}

const MAX_SYMLINK_HOPS = 40;

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

function executableMode(headerMode: number | undefined): number {
  return (headerMode ?? 0) & 0o111 ? 0o755 : 0o644;
}

/** Maps any error that escaped our own fixed extract_* codes to a path-free fallback. */
function mapError(err: unknown): Error {
  if (err instanceof Error && /^extract_/.test(err.message)) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EEXIST" || code === "ENOTDIR" || code === "ENOTEMPTY") return new Error("extract_duplicate_entry");
  return new Error("extract_io");
}

/** Lexically applies path components ("." skip, ".." pop, else append) — no filesystem access. */
function applyLexically(base: string, components: string[]): string {
  let current = base;
  for (const component of components) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    current = current === sep ? `${sep}${component}` : `${current}${sep}${component}`;
  }
  return current;
}

/**
 * Resolves `components` starting from the already-real `startReal`, like realpath but tolerant of a
 * dangling tail: once a component doesn't exist (or a non-final one isn't a directory), the rest is
 * applied lexically instead of failing. Any symlink encountered along the way is followed for real
 * (readlink + splice its target in front of what's left), which is what catches a chain of in-tree
 * symlinks that composes into a physical escape even though each hop looks fine on its own.
 */
async function resolveWalk(startReal: string, components: string[]): Promise<string> {
  let current = startReal;
  let remaining = components.slice();
  let hops = 0;
  while (remaining.length > 0) {
    const component = remaining.shift()!;
    if (component === "" || component === ".") continue;
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = current === sep ? `${sep}${component}` : `${current}${sep}${component}`;
    let stats;
    try {
      stats = await lstat(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return applyLexically(current, [component, ...remaining]);
      }
      throw err;
    }
    if (stats.isSymbolicLink()) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) fail("extract_symlink_escape");
      const linkTarget = await readlink(candidate);
      if (isAbsolute(linkTarget)) fail("extract_symlink_escape");
      remaining = linkTarget.split("/").concat(remaining);
      continue;
    }
    current = candidate;
  }
  return current;
}

export async function safeExtract(
  source: Readable,
  root: string,
  limits: SafeExtractLimits,
  options?: SafeExtractOptions,
): Promise<void> {
  const base = resolve(root);
  const recordedSymlinks = new Map<string, string>();
  const seen = new Set<string>();
  let entries = 0;
  let bytes = 0;

  const extract = tar.extract();
  let rejectFailed!: (err: unknown) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailed = reject;
  });
  failed.catch(() => undefined);
  const onStreamError = (err: unknown): void => rejectFailed(err);
  extract.once("error", onStreamError);
  source.once("error", onStreamError);

  const signal = options?.signal;
  const onAbort = (): void => rejectFailed(new Error("extract_aborted"));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  function guard<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, failed]);
  }

  // Created (and so subscribed to tar-stream's internal 'entry'/'close' events) before any `await`,
  // including the realpath below: tar-stream's async iterator only delivers an entry to listeners that
  // were attached before it was emitted, so creating this after an async gap can silently miss the very
  // first entry and hang forever waiting for one that already came and went.
  const extractIterator = extract[Symbol.asyncIterator]();
  source.pipe(extract);

  try {
    const rootReal = await guard(realpath(base));

    /**
     * Creates (if needed) and verifies every directory named by `segments`, one component at a time,
     * starting from `rootReal`, and returns the resulting real path. For each component: `lstat` it; if
     * it doesn't exist, `mkdir` just that one component (non-recursive — its parent was already verified
     * real by the previous iteration), re-`lstat`ing on a raced `EEXIST`. Then — whether it already
     * existed or was just created — `lstat` it again: if that's a symlink, `extract_through_symlink`
     * (this is what stops phase 2a from creating or `chmod`ing through a symlink an *earlier* entry in
     * this same extraction created, including one that's only a case-insensitive alias of the component
     * being resolved); if it exists but isn't a directory at all, `extract_duplicate_entry` (preserves
     * the existing "file blocking a nested path" behavior). Only once a component is freshly confirmed by
     * `lstat` to be a real, non-symlink directory does it get `chmod`'d to 0o755 — never by a path that
     * was merely assumed to still be what an earlier check saw.
     */
    async function ensureDirectory(segments: string[]): Promise<string> {
      let current = rootReal;
      for (const component of segments) {
        const child = current === sep ? `${sep}${component}` : `${current}${sep}${component}`;
        let exists = true;
        try {
          await guard(lstat(child));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          exists = false;
        }
        if (!exists) {
          try {
            await guard(mkdir(child, { mode: 0o755 }));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          }
        }
        const stats = await guard(lstat(child));
        if (stats.isSymbolicLink()) fail("extract_through_symlink");
        if (!stats.isDirectory()) fail("extract_duplicate_entry");
        await guard(chmod(child, 0o755));
        current = child;
      }
      return current;
    }

    // Phase 1 (streaming): create directories and regular files; validate and record symlinks.
    for (;;) {
      const step = await guard(extractIterator.next());
      if (step.done) break;
      const entry = step.value;
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
        if (recordedSymlinks.has(segments.slice(0, i).join("/"))) {
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

      // Count every entry type's declared size before draining/consuming its body: a symlink (or any
      // other type) can carry a body up to its declared size, and this must be rejected before we ever
      // read a byte of it, not after.
      const declaredSize = header.size ?? 0;
      if (bytes + declaredSize > limits.maxBytes) {
        entry.resume();
        fail("extract_size_limit");
      }
      bytes += declaredSize;

      switch (header.type) {
        case "directory": {
          entry.resume();
          try {
            await ensureDirectory(segments);
          } catch (err) {
            throw mapError(err);
          }
          break;
        }
        case "file":
        case "contiguous-file": {
          if (entry.destroyed) throw mapError(new Error("entry stream destroyed"));
          let fh: FileHandle;
          try {
            const parentReal = await ensureDirectory(segments.slice(0, -1));
            const fileTarget = resolve(parentReal, segments[segments.length - 1]);
            const openPromise = open(fileTarget, "wx", 0o644);
            try {
              fh = await guard(openPromise);
            } catch (err) {
              // If `failed` won the race, `open()` may still resolve later with a real handle that
              // nothing else will ever close — close it then. Harmless (and a no-op) if `open()` itself
              // is what rejected instead, since then it never produced a handle at all.
              openPromise.then((handle) => handle.close().catch(() => undefined)).catch(() => undefined);
              throw err;
            }
          } catch (err) {
            throw mapError(err);
          }
          try {
            let streamed = 0;
            const bodyIterator = entry[Symbol.asyncIterator]();
            for (;;) {
              const chunkStep = await guard(bodyIterator.next());
              if (chunkStep.done) break;
              const chunk = chunkStep.value as Buffer;
              streamed += chunk.byteLength;
              if (streamed > limits.maxBytes) fail("extract_size_limit");
              await guard(fh.write(chunk));
            }
            await guard(fh.chmod(executableMode(header.mode)));
          } finally {
            await fh.close().catch(() => undefined);
          }
          break;
        }
        case "symlink": {
          entry.resume();
          const link = header.linkname ?? "";
          if (link === "" || link.startsWith("/") || !inside(base, resolve(dirname(target), link))) {
            fail("extract_symlink_escape");
          }
          recordedSymlinks.set(path, link);
          break;
        }
        default:
          entry.resume();
          fail("extract_special_entry");
      }
    }

    // Phase 2a: materialize every recorded symlink, now that the real tree is final. `ensureDirectory`
    // rejects (extract_through_symlink) rather than create or chmod through a symlink an earlier
    // iteration of this same loop created — including one that's merely a case-insensitive alias of the
    // parent this symlink names — and a same-path collision with a phase-1-created path surfaces as
    // EEXIST from `symlink()` itself, mapped to extract_duplicate_entry.
    for (const [path, link] of recordedSymlinks) {
      const segments = path.split("/");
      try {
        const parentReal = await ensureDirectory(segments.slice(0, -1));
        const target = resolve(parentReal, segments[segments.length - 1]);
        await guard(createSymlink(link, target));
      } catch (err) {
        throw mapError(err);
      }
    }

    // Phase 2b: validate every created symlink against the real filesystem. A lexical check can't see a
    // chain of in-tree symlinks (e.g. s -> "..", t -> "s/..") whose composed, physically-resolved target
    // lands outside root even though each link's own text looks contained.
    for (const [path, link] of recordedSymlinks) {
      const segments = path.split("/");
      const parentReal = await guard(resolveWalk(rootReal, segments.slice(0, -1)));
      const finalReal = await guard(resolveWalk(parentReal, link.split("/")));
      if (!(finalReal === rootReal || finalReal.startsWith(`${rootReal}${sep}`))) {
        fail("extract_symlink_escape");
      }
    }
  } catch (err) {
    source.destroy();
    extract.destroy();
    throw mapError(err);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    extract.removeListener("error", onStreamError);
    source.removeListener("error", onStreamError);
  }
}
