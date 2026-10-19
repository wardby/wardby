// Wardby's pre-agent dependency cache, run by trusted wardby code (the Codex
// worker driver and the Claude tool runner) before the agent starts.
//
// It finds the repo's npm projects (a committed package-lock.json at the root
// or up to three folders down; at most MAX_PROJECTS), and for each one plans
// the lockfile with the registry proxy (the same request the npm shim sends),
// asks the proxy's dependency cache for a snapshot of node_modules made for
// exactly that lockfile, image and policy, and then either:
//   hit     - downloads it, verifies its sha256, checks every tar entry,
//             extracts it into a temp folder, checks the tree against the
//             lockfile and renames it into place;
//   nearest - restores the newest snapshot of an older lockfile the same way
//             (minus the lockfile check), lets `npm install` bring it up to
//             date, checks the tree, and snapshots the result;
//   cold    - runs `npm ci`, checks the tree, and snapshots it.
// Projects run one after another with a shared disk budget, which bounds the
// restores, gates each install (MIN_INSTALL_BUDGET_BYTES or a known tree
// size), and is re-measured before each snapshot archive (skipped, or stopped
// mid-write, when it would not fit); npm's download cache is removed after the
// module's own install. One project's failure never affects another. It always seals the run's upload window once,
// after every project, so nothing the agent does can ever be uploaded. Only
// then, for a project whose lockfile lists install scripts, it runs
// `npm rebuild` (snapshots are always built with --ignore-scripts, so what the
// scripts produce is never uploaded).
//
// A snapshot is untrusted input (storage could be tampered with), so the
// archive is parsed here, in one place, and every entry is checked before
// anything is written; extraction then writes exactly the entries that were
// checked (no second tar implementation to disagree with this one).
//
// The cache never fails a run: every error becomes `skipped` with a stable
// reason code, and the agent installs as it would without the cache. Logs
// carry event names, codes and counts only: never tokens, URLs or npm output.
//
// Dependency-free on purpose (it runs before anything is installed).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { basename, join, posix, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createGunzip } from "node:zlib";

const MIB = 1024 * 1024;

/** Time bounds (ms). `uploadWindowMs` mirrors the proxy's upload window
 *  (WARDBY_DEPENDENCY_CACHE_UPLOAD_SECONDS, 15 min by default), measured from
 *  this module's start, which is after the proxy session began: a snapshot is
 *  not uploaded once less than `uploadMarginMs` of it is left (a lookup's
 *  `uploadExpiresInMs`, when a proxy reports one, is used instead when
 *  sooner). With the default totalMs (20 min) a slow run simply stops
 *  uploading after ~14 min while still restoring and installing.
 *  `transferMs` is the floor for a download or upload,
 *  which also gets `transferMsPerMiB` for every MiB it moves; `tarMs` is the
 *  floor for packing a snapshot, which gets `tarMsPerMiB` for every MiB of
 *  the installed tree it reads (gzip is CPU-bound, so a large tree on a
 *  small pod needs longer), and never runs past the upload deadline. After
 *  `totalMs` the work is aborted and gets `settleMs` to clean up; then the
 *  workspace is closed to it (no rename, removal or install) and it is sealed.
 *  `httpMs` bounds each small proxy call (lookup, seal); `planMs` the
 *  lockfile plan alone, which on a proxy with a cold package-fact cache
 *  checks every package of a large lockfile before it answers (still bounded
 *  by `totalMs`, like every step). A proxy that stops at its own plan time
 *  bound (REGISTRY_PLAN_TIMEOUT_MS) answers 503 `wardby_plan_incomplete` and
 *  keeps what it verified; the plan is then sent again after
 *  `planRetryPauseMs`, resuming there, until `planMs` is used up. */
export const DEFAULT_TIMEOUTS = Object.freeze({
  httpMs: 120_000,
  planMs: 600_000,
  planRetryPauseMs: 2_000,
  transferMs: 300_000,
  transferMsPerMiB: 1_000,
  installMs: 600_000,
  tarMs: 300_000,
  tarMsPerMiB: 500,
  totalMs: 1_200_000,
  killGraceMs: 5_000,
  settleMs: 6_000,
  rebuildMs: 300_000,
  uploadWindowMs: 900_000,
  uploadMarginMs: 60_000,
});

/** The workspace budget when the caller names none and CODING_DISK_MB is unset. */
export const DEFAULT_BUDGET_MB = 2048;
/** The least room a cold install needs when no better estimate is known
 *  (`budget_too_small` below it): npm writes node_modules and, beside it, its
 *  download cache (`<npm_config_cache>/_cacache`, about as large again before
 *  this module removes it), and the snapshot archive follows. 1 GiB covers a
 *  large tree (about 450 MiB of node_modules plus 350 MiB of npm cache). */
export const MIN_INSTALL_BUDGET_BYTES = 1024 * MIB;
/** A cold install's room when the size of this project's tree is known (a
 *  hit or nearest snapshot that was scanned): node_modules plus npm's cache. */
const INSTALL_NEED_FACTOR = 2;
/** A nearest restore must leave room for the delta install and the archive:
 *  its unpacked size times this, before it is extracted. */
const NEAREST_NEED_FACTOR = 1.5;
/** node_modules bytes per archive byte when no snapshot of this project was
 *  seen (gzip of a typical npm tree is about 3:1). */
const ARCHIVE_RATIO_ESTIMATE = 3;
/** Most entries a snapshot may hold (an inode bomb is not a byte bomb). */
export const MAX_ARCHIVE_ENTRIES = 1_000_000;
const MAX_JSON_BYTES = 1 * MIB;
const MAX_PAX_BYTES = 1 * MIB;
const MAX_NAME_BYTES = 4096;
const ROOT = "node_modules";
/** Most npm projects one run prepares; more are reported `too_many_projects`. */
export const MAX_PROJECTS = 4;
/** Deepest project folder, in path segments (the proxy's own limit). */
const MAX_PROJECT_DEPTH = 3;
/** Most folders discovery looks at, so a huge checkout can't stall the run. */
const MAX_DISCOVERY_DIRS = 10_000;
/** A project path segment the proxy accepts (key.ts parseProjectPath): no
 *  leading dot, so dot-folders are never projects. */
const PROJECT_SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,99}$/;
/** This module's own temp names under <workspace>/.cache (randomName below). */
const OWN_TEMP = /^dep(?:-restore|-snap|-npmcache)?-[0-9a-f]{16}(?:\.tgz)?$/;

class Skip extends Error {
  /** `detail`: log-only facts about why (a rule name and counts, never path contents). */
  constructor(reason, detail) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- tar parsing

/** Pulls exact byte counts out of an async iterable of Buffers. */
class ByteReader {
  constructor(iterable) {
    this.iterator = iterable[Symbol.asyncIterator]();
    this.chunks = [];
    this.buffered = 0;
    this.done = false;
  }

  async fill(count) {
    while (this.buffered < count && !this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
    return this.buffered >= count;
  }

  /** Exactly `count` bytes, or null at the end of the stream. */
  async read(count) {
    if (!(await this.fill(count))) return null;
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, count);
    const rest = all.subarray(count);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }

  /** Hands `count` bytes to `onChunk` piece by piece, without holding them all. */
  async consume(count, onChunk) {
    let left = count;
    while (left > 0) {
      if (this.buffered === 0 && !(await this.fill(1))) throw new Skip("unsafe_archive");
      const head = this.chunks[0];
      const take = Math.min(left, head.length);
      if (onChunk) await onChunk(head.subarray(0, take));
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      this.buffered -= take;
      left -= take;
    }
  }

  async close() {
    await this.iterator.return?.();
  }
}

function cString(block, start, length) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(block, start, length) {
  // A base-256 number (high bit set) is only needed past 8 GiB: refuse it.
  if (block[start] & 0x80) throw new Skip("unsafe_archive");
  const text = cString(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Skip("unsafe_archive");
  return text ? parseInt(text, 8) : 0;
}

function checksumOk(block) {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : block[index];
  return octal(block, 148, 8) === sum;
}

/** The records of a pax extended header that matter here. */
function parsePax(data) {
  const out = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Skip("unsafe_archive");
    const length = Number(data.subarray(offset, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= space - offset || offset + length > data.length)
      throw new Skip("unsafe_archive");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals === -1) throw new Skip("unsafe_archive");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path" || key === "linkpath") out[key] = value;
    else if (key === "size") {
      if (!/^\d+$/.test(value)) throw new Skip("unsafe_archive");
      out.size = Number(value);
    }
    offset += length;
  }
  return out;
}

/**
 * Walks a gzipped tar file entry by entry. `onEntry({ path, type, size,
 * linkname, mode })` returns an optional data sink (an async function taking
 * each chunk) for a regular file. Supports ustar, GNU long names (L/K) and pax
 * extended headers (x); every other meta entry is refused.
 */
async function walkTar(file, { signal, maxStreamBytes }, onEntry) {
  let seen = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxStreamBytes) callback(new Skip("over_budget"));
      else callback(null, chunk);
    },
  });
  const source = createReadStream(file);
  const gunzip = createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  const decompressed = source
    .pipe(gunzip)
    .on("error", (error) => counter.destroy(error))
    .pipe(counter);
  const reader = new ByteReader(decompressed);
  try {
    let pending = {};
    for (;;) {
      signal?.throwIfAborted();
      const block = await reader.read(512);
      if (!block) throw new Skip("unsafe_archive"); // no end-of-archive marker
      if (block.every((byte) => byte === 0)) return; // end of archive
      if (!checksumOk(block)) throw new Skip("unsafe_archive");
      const type = String.fromCharCode(block[156] || 0x30);
      let size = octal(block, 124, 12);
      const padding = (512 - (size % 512)) % 512;
      if (type === "L" || type === "K" || type === "x") {
        if (size > (type === "x" ? MAX_PAX_BYTES : MAX_NAME_BYTES)) throw new Skip("unsafe_archive");
        const data = await reader.read(size + padding);
        if (!data) throw new Skip("unsafe_archive");
        const body = data.subarray(0, size);
        if (type === "x") pending = { ...pending, ...parsePax(body) };
        else {
          const end = body.indexOf(0);
          const text = body.subarray(0, end === -1 ? body.length : end).toString("utf8");
          if (type === "L") pending.path = text;
          else pending.linkpath = text;
        }
        continue;
      }
      const magic = block.subarray(257, 263).toString("latin1");
      const prefix = magic === "ustar\0" ? cString(block, 345, 155) : "";
      const name = cString(block, 0, 100);
      const path = pending.path ?? (prefix ? `${prefix}/${name}` : name);
      const linkname = pending.linkpath ?? cString(block, 157, 100);
      if (pending.size !== undefined) size = pending.size;
      pending = {};
      const sink = await onEntry({ path, type, size, linkname, mode: octal(block, 100, 8) });
      const dataPadding = (512 - (size % 512)) % 512;
      await reader.consume(size, sink);
      await reader.consume(dataPadding);
    }
  } finally {
    await reader.close().catch(() => undefined);
    source.destroy();
  }
}

/**
 * The rules every entry must pass, kept as state across one walk:
 * - only regular files ("0"), directories ("5") and symlinks ("2");
 * - a relative path under `node_modules/`, with no empty, "." or ".." segment;
 * - no path seen twice (counting the parents a path implies), and nothing
 *   beneath a symlink or a file;
 * - a symlink's target, taken from the link's own folder, stays in
 *   node_modules (and is never absolute);
 * - the summed file sizes and the entry count stay under the budget.
 */
class EntryRules {
  constructor(budgetBytes, maxEntries) {
    this.budgetBytes = budgetBytes;
    this.maxEntries = maxEntries;
    this.kinds = new Map();
    this.folded = new Map();
    this.unpackedBytes = 0;
    this.entries = 0;
  }

  check(entry) {
    const kind =
      entry.type === "0" || entry.type === "\0"
        ? "file"
        : entry.type === "5"
          ? "dir"
          : entry.type === "2"
            ? "link"
            : null;
    if (!kind) throw new Skip("unsafe_archive");
    const path = kind === "dir" ? entry.path.replace(/\/+$/, "") : entry.path;
    if (!safeRelative(path)) throw new Skip("unsafe_archive");
    const segments = path.split("/");
    if (segments[0] !== ROOT || (segments.length === 1 && kind !== "dir")) throw new Skip("unsafe_archive");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join("/");
      const parentKind = this.kinds.get(parent);
      if (parentKind && parentKind !== "dir" && parentKind !== "implied") throw new Skip("unsafe_archive");
      if (!parentKind) this.claim(parent, "implied");
    }
    const existing = this.kinds.get(path);
    // A folder's own entry may follow entries that implied it; nothing else repeats.
    if (existing && !(existing === "implied" && kind === "dir")) throw new Skip("unsafe_archive");
    this.claim(path, kind);
    if (kind === "link") {
      const target = entry.linkname;
      if (!plainLinkTarget(path, target)) throw new Skip("unsafe_archive");
    }
    this.entries += 1;
    if (this.entries > this.maxEntries) throw new Skip("over_budget");
    if (kind === "file") {
      this.unpackedBytes += entry.size;
      if (this.unpackedBytes > this.budgetBytes) throw new Skip("over_budget");
    } else if (entry.size !== 0) throw new Skip("unsafe_archive");
    return { kind, path };
  }

  /** Records a path. Two different paths that a case-insensitive or
   *  normalization-insensitive file system (APFS, NTFS) would treat as one are
   *  refused: there `a/s` is the link `a/S`, and writing beneath it escapes. */
  claim(path, kind) {
    const key = foldPath(path);
    const owner = this.folded.get(key);
    if (owner !== undefined && owner !== path)
      throw new Skip("unsafe_archive", {
        rule: "case_fold_duplicate",
        pathLength: path.length,
        entry: this.entries + 1,
      });
    this.folded.set(key, path);
    this.kinds.set(path, kind);
  }
}

/** Case- and normalization-folded form of a path (over-folding only refuses more). */
function foldPath(path) {
  return path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

function safeRelative(path) {
  if (!path || path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A symlink target this module accepts: relative, `..` only as leading
 * segments, and inside node_modules when resolved from the link's folder.
 * The kernel applies `..` after following each link in the path, so a `..`
 * after a named segment (`a/s/../..`) can leave the folder that a lexical
 * normalize says it stays in when `a/s` is itself a link. npm's own links
 * (`.bin` entries, `file:` packages) only ever climb first, then descend.
 */
function plainLinkTarget(linkPath, target) {
  if (!target || target.includes("\0") || target.startsWith("/")) return false;
  let descended = false;
  for (const segment of target.split("/")) {
    if (segment === "..") {
      if (descended) return false;
    } else if (segment !== "" && segment !== ".") descended = true;
  }
  return insideRoot(posix.normalize(posix.join(posix.dirname(linkPath), target)));
}

function insideRoot(normalized) {
  return normalized === ROOT || normalized.startsWith(`${ROOT}/`);
}

/** Checks every entry of the archive without writing anything. */
export async function scanArchive(file, { budgetBytes, maxEntries = MAX_ARCHIVE_ENTRIES, signal } = {}) {
  const rules = new EntryRules(budgetBytes, maxEntries);
  await walkTar(file, { signal, maxStreamBytes: streamCap(budgetBytes, maxEntries) }, (entry) => {
    rules.check(entry);
    return undefined;
  });
  return { entries: rules.entries, unpackedBytes: rules.unpackedBytes };
}

// The decompressed stream is file bytes plus headers and padding; bound it too.
const streamCap = (budgetBytes, maxEntries) => budgetBytes + (maxEntries + 2) * 2048 + MAX_PAX_BYTES;

// "wx" plus O_NOFOLLOW where the platform has it: never follows, creates or replaces.
// O_EXCL alone already refuses any existing name, a planted link included (and
// makes every written file a new one with a single link: see verifyLinks);
// O_NOFOLLOW is a second guard where the platform has it.
const CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);

/** Each folder from `destination` down through `segments`, made if missing;
 *  refused if any of them is a symlink or not a folder (defence in depth
 *  against a file system that resolves two entry names to one path).
 *  mkdir first (it never follows a link at the last component): a folder it
 *  made is a real one; only when something already exists there (EEXIST)
 *  is it checked with lstat. Parents are checked before children, and each
 *  folder once (`verified`). */
async function safeDirectory(destination, segments, verified) {
  let current = destination;
  for (const segment of ["", ...segments]) {
    if (segment) current = join(current, segment);
    if (verified.has(current)) continue;
    try {
      await mkdir(current, { mode: 0o755 });
      verified.add(current);
      continue;
    } catch (error) {
      if (error?.code !== "EEXIST") throw new Skip("unsafe_archive");
    }
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new Skip("unsafe_archive");
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Skip("unsafe_archive");
    verified.add(current);
  }
}

/** Files up to this size are gathered in memory and written in one go. */
const BUFFERED_FILE_BYTES = 1 * MIB;

/** Creates `target` (never following or replacing anything) and writes
 *  `data` to it with synchronous calls: for a small file the three async
 *  round trips of open/write/close cost more than the work itself. */
function writeNewFileSync(target, mode, data) {
  const fd = openSync(target, CREATE_FLAGS, mode);
  try {
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
  } finally {
    closeSync(fd);
  }
}

/** Writes the checked entries under `destination` (the same walk and rules,
 *  so what is written is exactly what was checked). No owner, no setuid.
 *  Returns the symlinks it made (absolute paths, in archive order), for
 *  verifyLinks once the whole tree is written. */
export async function extractArchive(file, destination, { budgetBytes, maxEntries = MAX_ARCHIVE_ENTRIES, signal }) {
  const rules = new EntryRules(budgetBytes, maxEntries);
  const verified = new Set();
  const links = [];
  let openHandle;
  try {
    await extractEntries();
  } finally {
    await openHandle?.close().catch(() => undefined);
  }
  return { links };
  async function extractEntries() {
    await walkTar(file, { signal, maxStreamBytes: streamCap(budgetBytes, maxEntries) }, async (entry) => {
      const { kind, path } = rules.check(entry);
      signal?.throwIfAborted();
      const segments = path.split("/");
      const target = join(destination, ...segments);
      if (kind === "dir") {
        await safeDirectory(destination, segments, verified);
        return undefined;
      }
      await safeDirectory(destination, segments.slice(0, -1), verified);
      if (kind === "link") {
        await symlink(entry.linkname, target);
        links.push(target);
        return undefined;
      }
      const mode = entry.mode & 0o111 ? 0o755 : 0o644;
      if (entry.size <= BUFFERED_FILE_BYTES) {
        if (entry.size === 0) {
          writeNewFileSync(target, mode, Buffer.alloc(0));
          return undefined;
        }
        // A file that arrives in one piece is written from it directly;
        // otherwise its pieces are copied into one buffer of its declared size.
        let buffer;
        let filled = 0;
        return (chunk) => {
          if (!buffer && chunk.length === entry.size) {
            writeNewFileSync(target, mode, chunk);
            return;
          }
          buffer ??= Buffer.allocUnsafe(entry.size);
          chunk.copy(buffer, filled);
          filled += chunk.length;
          if (filled === entry.size) writeNewFileSync(target, mode, buffer);
        };
      }
      const handle = await open(target, CREATE_FLAGS, mode);
      openHandle = handle;
      let written = 0;
      return async (chunk) => {
        written += chunk.length;
        await handle.write(chunk);
        if (written === entry.size) {
          openHandle = undefined;
          await handle.close();
        }
      };
    });
  }
}

/**
 * After extraction: every symlink extractArchive made must pass the same
 * target rule as the scan, and its native realpath (the kernel's resolution,
 * following every link on the way) must be inside the real node_modules
 * folder. Run once the whole tree is written, since a link's resolution can
 * depend on links written after it.
 *
 * Only the links need checking on disk; extraction itself guarantees the
 * rest, so the tree is not walked again (a walk is one call per file, which
 * is slow under gVisor):
 * - it creates only files, folders and symlinks (EntryRules), so no other
 *   kind of entry exists;
 * - each file is created with O_CREAT | O_EXCL (CREATE_FLAGS) in a folder it
 *   made or checked (safeDirectory, never through a link), so a file is
 *   always new and has one link: a hard link cannot appear (tar hard-link
 *   entries are refused) and nothing else writes to the tree before the
 *   restore finishes.
 *
 * So this is only a complete check for a tree extractArchive wrote alone:
 * `links` must be every link it reported, and nothing else may have written
 * to `root` since. Each listed path is lstat'ed through its parent folders,
 * which extraction guarantees are real folders.
 *
 * A dangling link (no realpath) is accepted only on the target rule: its
 * folder is a real folder (safeDirectory never makes or follows a link), its
 * leading `..` segments are therefore resolved exactly as written, and every
 * later segment only descends, through real folders or through links that
 * are themselves checked here. So whatever later fills the gap is inside.
 * npm leaves such links for optional packages it skipped.
 */
export async function verifyLinks(root, links, signal) {
  const realTop = await realpath(join(root, ROOT));
  for (const path of links) {
    signal?.throwIfAborted();
    let info;
    try {
      info = lstatSync(path);
    } catch {
      throw new Skip("unsafe_archive");
    }
    if (!info.isSymbolicLink()) throw new Skip("unsafe_archive");
    const target = await readlink(path);
    if (!plainLinkTarget(toPosix(path.slice(root.length + 1)), target)) throw new Skip("unsafe_archive");
    let real;
    try {
      real = await realpath(path); // native: resolves `..` after each link, like open() will
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Skip("unsafe_archive"); // ELOOP and the like
    }
    if (real !== realTop && !real.startsWith(realTop + sep)) throw new Skip("unsafe_archive");
  }
}

const toPosix = (path) => path.split("\\").join("/");

// ---------------------------------------------------------------- consistency

/**
 * Compares npm's hidden lockfile (`node_modules/.package-lock.json`) and the
 * installed package.json files with the committed lockfile's `packages`.
 * Only keys under `node_modules/` are compared (the tree this module
 * restores). Compared: the set of paths, `version`, `integrity` (when the
 * lockfile has one) and `link`/`resolved` for links. Ignored, because npm
 * rewrites or derives them: `resolved` of registry packages (the registry
 * host is replaced), `dev`/`optional`/`devOptional`/`peer`, `license`,
 * `engines`, `os`/`cpu`, `bin`, `funding`, dependency maps and the like.
 * An `optional`/`devOptional` entry may be missing (npm skips optional
 * packages for another platform) but then must not be on disk either.
 */
export async function checkConsistency(projectRoot, lockfile, signal) {
  const fail = (detail) => ({ ok: false, detail });
  let hidden;
  try {
    hidden = JSON.parse(await readFile(join(projectRoot, ROOT, ".package-lock.json"), "utf8"));
  } catch {
    return fail("no_hidden_lockfile");
  }
  const installed = hidden && typeof hidden.packages === "object" && hidden.packages ? hidden.packages : null;
  if (!installed) return fail("no_hidden_lockfile");
  const wanted = lockfile.packages;
  const inTree = (key) => key.startsWith(`${ROOT}/`);
  for (const key of Object.keys(installed)) {
    if (!inTree(key)) continue;
    if (!Object.hasOwn(wanted, key)) return fail("extraneous");
  }
  for (const [key, entry] of Object.entries(wanted)) {
    signal?.throwIfAborted();
    if (!inTree(key) || !entry || typeof entry !== "object") continue;
    if (!safeRelative(key)) return fail("bad_key");
    const have = Object.hasOwn(installed, key) ? installed[key] : undefined;
    if (!have) {
      if (!entry.optional && !entry.devOptional) return fail("missing");
      if (await present(join(projectRoot, ...key.split("/")))) return fail("unlisted");
      continue;
    }
    if (Boolean(entry.link) !== Boolean(have.link)) return fail("link");
    if (entry.link) {
      if (entry.resolved !== have.resolved) return fail("link");
      continue;
    }
    if (entry.version !== have.version) return fail("version");
    if (entry.integrity !== undefined && entry.integrity !== have.integrity) return fail("integrity");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(projectRoot, ...key.split("/"), "package.json"), "utf8"));
    } catch {
      return fail("manifest");
    }
    if (manifest?.version !== entry.version) return fail("manifest");
  }
  return { ok: true };
}

async function present(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- HTTP

function timeoutSignal(signal, ms) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** Maps a failed call to a stable reason: a timeout (or the overall
 *  deadline) is `timeout`; anything else is `failure`. */
function asSkip(error, failure) {
  if (error instanceof Skip) return error;
  if (error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError") return new Skip("timeout");
  if (error?.name === "AbortError" && error?.cause instanceof Skip) return error.cause;
  if (error?.name === "AbortError") return new Skip("timeout");
  return new Skip(failure);
}

/** One request. Resolves with the response once headers arrive; the signal
 *  (and its timeout) keeps bounding the body after that. */
function request(url, { method = "GET", headers = {}, body, signal }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const outgoing = client.request(url, { method, headers, signal }, resolve);
    outgoing.on("error", reject);
    if (body === undefined) outgoing.end();
    else if (Buffer.isBuffer(body)) outgoing.end(body);
    else pipeline(body, outgoing).catch((error) => outgoing.destroy(error));
  });
}

async function readJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new Error("too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function callJson(url, options, timeoutMs, failure) {
  try {
    const signal = timeoutSignal(options.signal, timeoutMs);
    const response = await request(url, { ...options, signal });
    return { status: response.statusCode ?? 0, body: await readJson(response) };
  } catch (error) {
    throw asSkip(error, failure);
  }
}

// ---------------------------------------------------------------- child processes

/** Runs a command with no output captured (npm output is never logged),
 *  in its own process group so a timeout kills everything it started. */
function run(command, args, { cwd, env, timeoutMs, killGraceMs, signal, session, stdout }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || session?.closed) {
      reject(asSkip(signal?.reason, "timeout"));
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", stdout ? "pipe" : "ignore", "ignore"],
        detached: true,
      });
    } catch {
      reject(new Skip("install_failed"));
      return;
    }
    session?.children.add(child.pid);
    let reason;
    let exited = false;
    const kill = (why) => {
      if (reason) return;
      reason = why;
      if (exited) return;
      const group = (sig) => {
        try {
          process.kill(-child.pid, sig);
        } catch {
          // already gone
        }
      };
      group("SIGTERM");
      setTimeout(() => group("SIGKILL"), killGraceMs).unref();
    };
    const timer = setTimeout(() => kill(new Skip("timeout")), timeoutMs);
    const onAbort = () => kill(asSkip(signal.reason, "timeout"));
    signal?.addEventListener("abort", onAbort, { once: true });
    // `stdout(stream)`: consumes the output (only tar's archive uses it); its
    // failure kills the command with its reason, else `tar_failed` (e.g. EIO, ENOSPC).
    const consumed = stdout
      ? stdout(child.stdout).then(
          () => undefined,
          (error) => kill(asSkip(error, "tar_failed")),
        )
      : Promise.resolve();
    child.on("error", () => {
      session?.children.delete(child.pid);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Skip("install_failed"));
    });
    child.on("exit", (code) => {
      exited = true;
      session?.children.delete(child.pid);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void consumed.then(() => {
        if (reason) reject(reason);
        else resolve(code ?? 1);
      });
    });
  });
}

// ---------------------------------------------------------------- setup

/** The plan URL and token, read exactly as the npm shim reads them: the
 *  registry is npm_config_registry, which must be WARDBY_NPM_PLAN_REGISTRY,
 *  and the token is that registry's _authToken in the driver's npmrc. */
async function registryAuth(env) {
  const registry = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  const userconfig = env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG;
  if (!registry || !userconfig) return undefined;
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  if (!env.WARDBY_NPM_PLAN_REGISTRY || base !== env.WARDBY_NPM_PLAN_REGISTRY) return undefined;
  const prefix = `${base.replace(/^https?:/, "")}:_authToken=`;
  let npmrc;
  try {
    npmrc = await readFile(userconfig, "utf8");
  } catch {
    return undefined;
  }
  const line = npmrc.split(/\r?\n/).find((entry) => entry.trim().startsWith(prefix));
  const token = line?.trim().slice(prefix.length).trim();
  return token ? { base, token } : undefined;
}

/** The workspace budget in bytes: `budgetBytes`, else CODING_DISK_MB, else
 *  DEFAULT_BUDGET_MB; never more than the file system has free. */
async function workspaceBudget(workspace, env, budgetBytes) {
  const fromEnv = Number(env.CODING_DISK_MB);
  let budget = budgetBytes ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv * MIB : DEFAULT_BUDGET_MB * MIB);
  try {
    const fs = await statfs(workspace);
    budget = Math.min(budget, Number(fs.bavail) * Number(fs.bsize));
  } catch {
    // unknown: the budget alone
  }
  return { remaining: Math.max(0, budget), limit: Math.max(0, budget) };
}

/** `<workspace>/.cache`, created if missing; refused when it is anything but
 *  a real folder (a repo could commit a `.cache` symlink). */
async function cacheDirectory(workspace) {
  const path = join(workspace, ".cache");
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) throw new Skip("cache_dir_unsafe");
  } catch (error) {
    if (error instanceof Skip) throw error;
    try {
      await mkdir(path, { mode: 0o700 });
    } catch {
      throw new Skip("cache_dir_unsafe");
    }
  }
  return path;
}

const randomName = (prefix) => `${prefix}-${randomBytes(8).toString("hex")}`;

/** Remembers a temp path for this project and for the session, so the
 *  session can still remove it if the project never settles. */
function track(context, ...paths) {
  context.temps.push(...paths);
  for (const path of paths) context.session.temps?.add(path);
}

// ---------------------------------------------------------------- one project

/** The project's lockfile, read once: its exact bytes are what is planned,
 *  hashed and compared against. */
async function readProject(projectDir) {
  let bytes;
  try {
    bytes = await readFile(join(projectDir, "package-lock.json"));
  } catch {
    throw new Skip("no_lockfile");
  }
  let lockfile;
  let manifest;
  try {
    lockfile = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Skip("lockfile_unreadable");
  }
  if (!lockfile || typeof lockfile !== "object" || !(lockfile.lockfileVersion >= 2)) throw new Skip("lockfile_version");
  if (!lockfile.packages || typeof lockfile.packages !== "object") throw new Skip("lockfile_unreadable");
  try {
    manifest = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  } catch {
    throw new Skip("no_package_json");
  }
  if (manifest && typeof manifest === "object" && manifest.workspaces !== undefined) throw new Skip("workspaces");
  if (await present(join(projectDir, "npm-shrinkwrap.json"))) throw new Skip("shrinkwrap_present");
  if (await present(join(projectDir, ROOT))) throw new Skip("node_modules_present");
  if (!Object.keys(lockfile.packages).some((key) => key.startsWith(`${ROOT}/`))) throw new Skip("no_dependencies");
  return { bytes, lockfile, manifestBytes: await readFile(join(projectDir, "package.json")) };
}

/** Metadata from a trusted pre-agent upload is usable only when the downloaded
 * archive also verifies against its recorded digest. Legacy snapshots omit it
 * and deliberately retain the full scan before extraction. */
function archiveManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value;
  if (
    record.scanVersion !== 1 ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256) ||
    !Number.isSafeInteger(record.entries) ||
    record.entries < 1 ||
    record.entries > MAX_ARCHIVE_ENTRIES ||
    !Number.isSafeInteger(record.unpackedBytes) ||
    record.unpackedBytes < 0
  )
    return undefined;
  return { sha256: record.sha256, entries: record.entries, unpackedBytes: record.unpackedBytes };
}

/** Streams a snapshot to `file`, checking its length and sha256 on the way. */
async function download(context, id, file, maxBytes, manifest) {
  const { cacheBase, query, token, signal, timeouts } = context;
  const url = new URL(`blob/${id}?${query}`, cacheBase);
  // The size is unknown until the headers arrive: bound by maxBytes.
  const timeoutMs = timeouts.transferMs + Math.ceil(maxBytes / MIB) * timeouts.transferMsPerMiB;
  const bounded = timeoutSignal(signal, timeoutMs);
  let response;
  try {
    response = await request(url, { headers: { authorization: `Bearer ${token}` }, signal: bounded });
  } catch (error) {
    throw asSkip(error, "download_failed");
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Skip("download_failed");
  }
  const length = Number(response.headers["content-length"]);
  const expected = String(response.headers["x-wardby-sha256"] ?? "");
  if (!Number.isSafeInteger(length) || length < 0 || !/^[0-9a-f]{64}$/.test(expected)) {
    response.destroy();
    throw new Skip("download_failed");
  }
  if (manifest && expected !== manifest.sha256) {
    response.destroy();
    throw new Skip("download_failed");
  }
  if (length > maxBytes) {
    response.destroy();
    throw new Skip("too_large");
  }
  const hash = createHash("sha256");
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > length) callback(new Skip("size_mismatch"));
      else {
        hash.update(chunk);
        callback(null, chunk);
      }
    },
  });
  try {
    await pipeline(response, meter, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal: bounded });
  } catch (error) {
    throw asSkip(error, "download_failed");
  }
  if (received !== length) throw new Skip("size_mismatch");
  if (hash.digest("hex") !== expected) throw new Skip("sha_mismatch");
  return length;
}

/** Download, scan, extract into a temp folder, re-check the written tree,
 *  optionally check it against the lockfile, then rename into place. */
async function restore(context, project, id, maxBytes, { consistency, manifest }) {
  const { cacheDir, signal, budget } = context;
  const archive = join(cacheDir, `${randomName("dep")}.tgz`);
  const temp = join(cacheDir, randomName("dep-restore"));
  track(context, archive, temp);
  const measure = async (stage, action) => {
    const started = Date.now();
    try {
      return await action();
    } finally {
      context.log("restore_phase", { stage, ms: Date.now() - started });
    }
  };
  const sizeBytes = await measure("download", () => download(context, id, archive, maxBytes, manifest));
  const limit = Math.max(0, budget.remaining - sizeBytes);
  const refused = (error) => {
    const skip = asSkip(error, "unsafe_archive");
    if (skip.detail) context.log("archive_refused", skip.detail);
    throw skip;
  };
  // A manifest (the scan recorded at upload, bound to the digest download()
  // just verified) stands in for a second scan. Its unpackedBytes only feeds
  // the early estimate below and context.known: extractArchive's budgetBytes
  // remains the real bound, and it applies every scan rule again.
  const scan =
    manifest ?? (await measure("scan", () => scanArchive(archive, { budgetBytes: limit, signal })).catch(refused));
  // This project's tree size and compression, for the estimates below (a cold
  // install after a rejected restore, the snapshot's archive size). Recorded
  // only from a snapshot that passed every check up to the point it was
  // judged: here, a scan that accepted every entry (refused only for room),
  // and below, a tree extracted and verified on disk. Never from one refused
  // as unsafe, whose sizes are untrusted.
  const measured = { unpackedBytes: scan.unpackedBytes, archiveBytes: sizeBytes };
  // A nearest is only worth restoring with room left for the delta install and the archive.
  if (!consistency && scan.unpackedBytes * NEAREST_NEED_FACTOR > limit) {
    context.known = measured;
    throw new Skip("budget_too_small");
  }
  await mkdir(temp, { mode: 0o700 });
  const { links } = await measure("extract", () => extractArchive(archive, temp, { budgetBytes: limit, signal })).catch(
    refused,
  );
  await removeTemp(context.workspace, archive);
  await context.testHooks?.beforeVerifyLinks?.(temp);
  await measure("verify_links", () => verifyLinks(temp, links, signal));
  context.known = measured;
  // A sanity check that this is the tree for this lockfile, not an
  // integrity control: integrity is the sha256 the proxy recorded in its
  // database at upload time, verified above against the bytes received.
  if (consistency) {
    const check = await measure("check_consistency", () => checkConsistency(temp, project.lockfile, signal));
    if (!check.ok) {
      context.log("inconsistent", { detail: check.detail });
      throw new Skip("inconsistent");
    }
  }
  const target = join(project.dir, ROOT);
  if (await present(target)) throw new Skip("node_modules_present");
  await context.testHooks?.beforeRename?.();
  // Past the deadline nothing new is put in place (checked right before the rename).
  if (signal.aborted || context.session.closed) throw asSkip(signal.reason, "timeout");
  context.created = target;
  await rename(join(temp, ROOT), target);
  await removeTemp(context.workspace, temp);
  // npm trusts its hidden lockfile only when it is newer than the folders.
  const now = new Date();
  await utimes(join(target, ".package-lock.json"), now, now).catch(() => undefined);
  budget.remaining -= scan.unpackedBytes;
  context.restoredBytes = scan.unpackedBytes;
  return sizeBytes;
}

/** Bytes of the regular files under `dir` (links not followed). */
async function treeBytes(dir, signal) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    signal?.throwIfAborted();
    const directory = stack.pop();
    let names;
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const info = await lstat(join(directory, name)).catch(() => undefined);
      if (info?.isDirectory()) stack.push(join(directory, name));
      else if (info?.isFile()) total += info.size;
    }
  }
  return total;
}

/** Charges the shared budget for what an install added beyond a restore. */
async function chargeInstall(context, project) {
  const bytes = await treeBytes(join(project.dir, ROOT), context.signal);
  context.installedBytes = bytes;
  const added = Math.max(0, bytes - (context.restoredBytes ?? 0));
  context.budget.remaining = Math.max(0, context.budget.remaining - added);
}

async function install(context, project, args) {
  const { env, npmPath, signal, timeouts } = context;
  context.created = join(project.dir, ROOT);
  const started = Date.now();
  const code = await run(npmPath, args, {
    cwd: project.dir,
    env,
    timeoutMs: timeouts.installMs,
    killGraceMs: timeouts.killGraceMs,
    signal,
    session: context.session,
  });
  const installMs = Date.now() - started;
  context.log("install", { command: args[0], code, ms: installMs });
  if (code !== 0) throw new Skip("install_failed");
  return installMs;
}

/** Puts back package.json and package-lock.json if an install rewrote them:
 *  the agent's working tree must look exactly as it was committed. */
async function restoreCommitted(context, project) {
  if (context.session.closed) return;
  for (const [name, bytes] of [
    ["package-lock.json", project.bytes],
    ["package.json", project.manifestBytes],
  ]) {
    const path = join(project.dir, name);
    const now = await readFile(path).catch(() => undefined);
    if (!now || !now.equals(bytes)) await writeFile(path, bytes);
  }
}

/** How long packing a snapshot may take: `tarMs` plus `tarMsPerMiB` for
 *  every MiB of the installed tree, cut to what is left of the upload window
 *  (an archive finished after it could not be uploaded). `limit` names the
 *  bound that applies: `pack` or `upload_window`. Still bounded by `totalMs`
 *  through the run's signal. */
export function archiveLimit(timeouts, treeBytes, uploadDeadline, now = Date.now()) {
  const packMs = timeouts.tarMs + Math.ceil(Math.max(0, treeBytes) / MIB) * (timeouts.tarMsPerMiB ?? 0);
  if (uploadDeadline !== undefined && uploadDeadline - now < packMs)
    return { limit: "upload_window", limitMs: Math.max(0, uploadDeadline - now) };
  return { limit: "pack", limitMs: packMs };
}

/** Archives node_modules and uploads it. Never throws: the installed tree is
 *  fine either way, so a failure here only logs. */
async function snapshot(context, project, maxBytes) {
  const { cacheDir, cacheBase, query, token, signal, timeouts, session } = context;
  const archive = join(cacheDir, `${randomName("dep-snap")}.tgz`);
  track(context, archive);
  const started = Date.now();
  let stage = "estimate";
  let estimate;
  let written = 0;
  // Which bound a timeout in this stage hit, and how long it allowed.
  let bound;
  const skip = (reason) => {
    if (reason !== "timeout") {
      context.log("snapshot_skipped", { reason });
      return undefined;
    }
    const fired = signal.aborted ? { limit: "deadline", limitMs: timeouts.totalMs } : (bound ?? {});
    context.log("snapshot_skipped", {
      reason,
      stage,
      writtenBytes: written,
      ...(estimate !== undefined ? { estimateBytes: estimate } : {}),
      elapsedMs: Date.now() - started,
      ...fired,
    });
    return undefined;
  };
  try {
    if (!(await present(join(project.dir, ROOT, ".package-lock.json")))) return skip("no_hidden_lockfile");
    // Only an archive that fits what is left of the disk budget, measured now
    // (npm's own writes included), is written; the installed tree stays either way.
    const room = await measureRemaining(context);
    estimate = archiveEstimate(context);
    if (estimate > room) {
      context.log("snapshot_skipped", {
        reason: "budget",
        stage: "estimate",
        estimateBytes: estimate,
        roomBytes: room,
      });
      return undefined;
    }
    bound = archiveLimit(timeouts, context.installedBytes ?? 0, context.uploadDeadline);
    // Not packed at all when the archive could no longer be uploaded.
    if (bound.limit === "upload_window" && bound.limitMs <= 0) return skip("upload_window_passed");
    stage = "archive";
    const code = await run("tar", ["-czf", "-", "-C", project.dir, ROOT], {
      env: { PATH: context.env.PATH ?? process.env.PATH ?? "", COPYFILE_DISABLE: "1" },
      timeoutMs: bound.limitMs,
      killGraceMs: timeouts.killGraceMs,
      signal,
      session,
      // Counted before each chunk is written: the file never grows past the room or maxBytes.
      stdout: (output) =>
        pipeline(
          output,
          new Transform({
            transform(chunk, _encoding, callback) {
              written += chunk.length;
              if (written > room) callback(new Skip("budget"));
              else if (written > maxBytes) callback(new Skip("too_large"));
              else callback(null, chunk);
            },
          }),
          createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        ),
    }).catch((error) => asSkip(error, "tar_failed").reason);
    if (code !== 0) {
      const reason = typeof code === "string" ? code : "tar_failed";
      if (reason === "budget") {
        await removeTemp(context.workspace, archive);
        await context.testHooks?.afterArchiveAborted?.(archive);
        context.log("snapshot_skipped", { reason, stage: "archive", writtenBytes: written, roomBytes: room });
        return undefined;
      }
      return skip(reason);
    }
    const { size } = await stat(archive);
    if (size > maxBytes) return skip("too_large");
    // Upload only what a restore would accept. The proxy binds these measured
    // bounds to its digest, so a later restore that verifies that digest may
    // safely avoid parsing the same archive a second time.
    let validation;
    stage = "scan";
    bound = undefined;
    try {
      validation = await scanArchive(archive, { budgetBytes: Number.MAX_SAFE_INTEGER, signal });
    } catch (error) {
      return skip(asSkip(error, "unsafe_archive").reason);
    }
    if (session.sealed || signal.aborted) return skip("sealed");
    // The proxy refuses an upload after its window; don't start one that can't land.
    if (context.uploadDeadline !== undefined && Date.now() >= context.uploadDeadline)
      return skip("upload_window_passed");
    const timeoutMs = timeouts.transferMs + Math.ceil(size / MIB) * timeouts.transferMsPerMiB;
    stage = "upload";
    bound = { limit: "upload", limitMs: timeoutMs };
    const result = await callJson(
      new URL(`blob?${query}`, cacheBase),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/gzip",
          "content-length": String(size),
          "x-wardby-archive-scan-version": "1",
          "x-wardby-archive-entries": String(validation.entries),
          "x-wardby-archive-unpacked-bytes": String(validation.unpackedBytes),
        },
        body: createReadStream(archive),
        signal,
      },
      timeoutMs,
      "upload_failed",
    );
    const stored = result.status === 201 ? "stored" : result.status === 200 ? "exists" : "refused";
    context.log("snapshot", {
      status: result.status,
      stored,
      ...(stored === "refused" && typeof result.body?.error === "string" ? { code: result.body.error } : {}),
      bytes: size,
    });
    return stored === "refused" ? undefined : size;
  } catch (error) {
    return skip(asSkip(error, "upload_failed").reason);
  } finally {
    await removeTemp(context.workspace, archive);
  }
}

/** What is left of the disk budget now: the budget less what the workspace
 *  grew by since it was measured (the same bounded walk as
 *  dependencyCacheBudget), and never more than the file system has free.
 *  Falls back to the running account when the walk can't finish. Updates
 *  the shared budget, so the next project starts from what is really left. */
async function measureRemaining(context) {
  const { budget, workspace, signal } = context;
  let room = budget.remaining;
  if (budget.limit !== undefined && budget.baseUsed !== undefined) {
    const used = await workspaceUsage(workspace, { signal });
    if (used !== undefined) room = budget.limit - (used - budget.baseUsed);
  }
  try {
    const fs = await statfs(workspace);
    room = Math.min(room, Number(fs.bavail) * Number(fs.bsize));
  } catch {
    // unknown: the budget alone
  }
  budget.remaining = Math.max(0, room);
  return budget.remaining;
}

/** The archive's expected size: this project's tree at the compression its
 *  last snapshot had (a nearest or rejected hit, when one was scanned), else
 *  ARCHIVE_RATIO_ESTIMATE. A low guess only costs a tar that is stopped. */
function archiveEstimate(context) {
  const installed = context.installedBytes ?? 0;
  const known = context.known;
  if (known && known.unpackedBytes > 0) return Math.ceil(installed * (known.archiveBytes / known.unpackedBytes));
  return Math.ceil(installed / ARCHIVE_RATIO_ESTIMATE);
}

/** Room an install needs before it starts: twice this project's known tree
 *  (node_modules plus npm's cache) when a snapshot of it was scanned, else
 *  `minInstallBytes` (MIN_INSTALL_BUDGET_BYTES). */
function installNeed(context) {
  const known = context.known?.unpackedBytes;
  if (known !== undefined) return Math.ceil(known * INSTALL_NEED_FACTOR);
  return context.minInstallBytes ?? MIN_INSTALL_BUDGET_BYTES;
}

/**
 * Removes npm's content cache (`<npm_config_cache>/_cacache`) that this
 * module's own install filled, before the snapshot is archived: otherwise it
 * shares the disk with node_modules and the archive. Only that folder, only
 * when it is under <workspace>/.cache and reached through real folders; the
 * npmrc and the rest of npm's folder stay (the agent's npm reads them). The
 * agent's npm downloads again whatever it needs. Never throws; logs only.
 */
async function removeNpmContentCache(context, project) {
  const say = (status, fields = {}) => context.log("npm_cache_cleared", { status, ...fields });
  if (context.signal.aborted || context.session.closed) return;
  const configured = context.env.npm_config_cache ?? context.env.NPM_CONFIG_CACHE;
  if (typeof configured !== "string" || !configured) return say("not_configured");
  const cacheDir = join(context.workspace, ".cache");
  const npmCache = resolve(project.dir, configured);
  if (npmCache !== cacheDir && !npmCache.startsWith(cacheDir + sep)) return say("outside_workspace");
  try {
    const target = join(npmCache, "_cacache");
    let current = cacheDir;
    for (const segment of ["", ...target.slice(cacheDir.length + 1).split(sep)]) {
      if (segment) current = join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (error?.code === "ENOENT") return say("absent");
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) return say("unsafe");
    }
    await context.testHooks?.beforeNpmCacheMove?.();
    if (!(await cacheDirIntact(context.workspace))) return say("unsafe");
    // Nothing once the work is over: the workspace may already be the agent's.
    // Checked here, with no await before the rename.
    if (context.signal.aborted || context.session.closed) return say("stopped");
    // Moved out of npm's folder in one step and only then removed: a removal
    // still running after the caller stopped waiting touches only this
    // module's own temp (which the session's cleanup also removes), never a
    // `_cacache` the agent's npm has started to fill.
    const doomed = join(cacheDir, randomName("dep-npmcache"));
    await rename(target, doomed);
    track(context, doomed);
    await context.testHooks?.beforeNpmCacheRemove?.();
    await removeTemp(context.workspace, doomed);
    say("removed");
  } catch {
    say("failed");
  }
}

/** The proxy's answer when it stopped at its own plan time bound, keeping
 *  what it verified: sending the plan again resumes there. */
const isPlanIncomplete = (plan) =>
  plan.status === 503 && typeof plan.body?.error === "string" && plan.body.error.startsWith("wardby_plan_incomplete");

/** Most plan requests for one project, and for the whole run: the proxy
 *  allows REGISTRY_PLAN_MAX_PER_RUN (20 by default) per run, and the agent's
 *  own npm needs some of them. */
export const MAX_PLAN_ATTEMPTS = 5;
export const MAX_PLAN_REQUESTS_PER_RUN = 8;

/** POST -/plan, sent again after `planRetryPauseMs` while the proxy answers
 *  that it is incomplete, all within `planMs` (and the overall deadline,
 *  through the signal), at most MAX_PLAN_ATTEMPTS times. Every other answer
 *  is returned as it is; running out of time or attempts is `timeout`, and
 *  the run's MAX_PLAN_REQUESTS_PER_RUN used up is `plan_failed`. */
async function requestPlan(context, project) {
  const { auth, timeouts, signal, log, session } = context;
  const planMs = Math.min(timeouts.planMs ?? DEFAULT_TIMEOUTS.planMs, timeouts.totalMs ?? DEFAULT_TIMEOUTS.totalMs);
  const pauseMs = timeouts.planRetryPauseMs ?? DEFAULT_TIMEOUTS.planRetryPauseMs;
  const until = Date.now() + planMs;
  for (let attempt = 1; ; attempt += 1) {
    if ((session.planRequests ?? 0) >= MAX_PLAN_REQUESTS_PER_RUN) {
      log("plan_limit_reached", { requests: session.planRequests });
      throw new Skip("plan_failed");
    }
    session.planRequests = (session.planRequests ?? 0) + 1;
    const plan = await callJson(
      new URL("-/plan", auth.base),
      {
        method: "POST",
        headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
        body: project.bytes,
        signal,
      },
      Math.max(1, until - Date.now()),
      "plan_failed",
    );
    if (!isPlanIncomplete(plan)) return plan;
    log("plan_incomplete", { attempt });
    if (attempt >= MAX_PLAN_ATTEMPTS || until - Date.now() <= pauseMs) throw new Skip("timeout");
    try {
      await sleep(pauseMs, undefined, { signal });
    } catch (error) {
      throw asSkip(error, "timeout");
    }
  }
}

/**
 * The flow for one npm project (`projectPath` relative to the workspace, as
 * discoverProjects returns it). Never throws.
 */
export async function prepareProject(options) {
  const { workspace, projectPath = ".", log, session } = options;
  const project = { dir: projectPath === "." ? workspace : join(workspace, ...projectPath.split("/")) };
  const context = { ...options, temps: [], created: undefined };
  try {
    Object.assign(project, await readProject(project.dir));
    // Decided now, from the committed bytes, before any third-party code runs.
    if (options.facts) options.facts.needsRebuild = listsInstallScripts(project.lockfile);
    context.cacheDir = await cacheDirectory(workspace);
    if (!context.auth) throw new Skip("no_registry");
    const { auth, timeouts, signal } = context;
    context.token = auth.token;
    context.cacheBase = new URL("/cache/npm/", auth.base);

    // The plan: the shim's request, with these exact bytes.
    const plan = await requestPlan(context, project);
    if (plan.status !== 200 || typeof plan.body?.approved !== "number" || !Array.isArray(plan.body?.refused))
      throw new Skip("plan_failed");
    log("plan", { approved: plan.body.approved, refused: plan.body.refused.length });
    if (plan.body.refused.length > 0) return { result: "refused", reason: "plan_refused" };

    const lockHash = createHash("sha256").update(project.bytes).digest("hex");
    context.query = new URLSearchParams({ project: projectPath, lock: lockHash }).toString();
    const lookup = await callJson(
      new URL(`lookup?${context.query}`, context.cacheBase),
      { headers: { authorization: `Bearer ${auth.token}` }, signal },
      timeouts.httpMs,
      "lookup_failed",
    );
    if (lookup.status === 404) throw new Skip("cache_unavailable");
    if (lookup.status === 409 && typeof lookup.body?.error === "string" && /^[a-z_]{1,40}$/.test(lookup.body.error))
      throw new Skip(lookup.body.error);
    const answer = lookup.body;
    if (
      lookup.status !== 200 ||
      typeof answer?.key !== "string" ||
      !/^[a-z0-9]{1,64}$/.test(answer.key) ||
      typeof answer.hit !== "boolean" ||
      !Number.isSafeInteger(answer.maxBytes)
    )
      throw new Skip("lookup_failed");
    const nearestId =
      typeof answer.nearest?.id === "string" && /^[a-z0-9]{1,64}$/.test(answer.nearest.id)
        ? answer.nearest.id
        : undefined;
    log("lookup", { hit: answer.hit, nearest: Boolean(nearestId) });
    if (Number.isSafeInteger(answer.uploadExpiresInMs) && answer.uploadExpiresInMs >= 0) {
      const reported = Date.now() + answer.uploadExpiresInMs - timeouts.uploadMarginMs;
      context.uploadDeadline = Math.min(context.uploadDeadline ?? Infinity, reported);
    }
    const key = answer.key;

    if (answer.hit) {
      const started = Date.now();
      try {
        const sizeBytes = await restore(context, project, key, answer.maxBytes, {
          consistency: true,
          manifest: archiveManifest(answer.manifest),
        });
        context.created = undefined; // a verified hit stays
        return { result: "hit", key, sizeBytes, restoreMs: Date.now() - started };
      } catch (error) {
        // A hit that fails to download, verify or check is only a miss: clean up and install cold.
        // Not one that would not fit: a cold install writes the same tree.
        const reason = await missedRestore(context, error);
        log("hit_rejected", { reason });
        if (reason === "over_budget") throw new Skip(reason);
      }
    }

    let result = "cold";
    let restoreMs;
    let installMs;
    if (nearestId) {
      const started = Date.now();
      try {
        await restore(context, project, nearestId, answer.maxBytes, {
          consistency: false,
          manifest: archiveManifest(answer.nearest?.manifest),
        });
        restoreMs = Date.now() - started;
        result = "nearest";
      } catch (error) {
        // A rejected nearest is only a miss: clean up and install cold.
        log("nearest_rejected", { reason: await missedRestore(context, error) });
      }
    }
    // Not enough room for an install: leave the workspace as it was; the agent installs for itself.
    // A nearest already passed its own check (NEAREST_NEED_FACTOR) before it was extracted.
    if (result === "cold" && context.budget.remaining < installNeed(context)) {
      log("install_skipped", {
        reason: "budget_too_small",
        needBytes: installNeed(context),
        roomBytes: context.budget.remaining,
      });
      throw new Skip("budget_too_small");
    }
    if (result === "nearest") {
      try {
        installMs = await install(context, project, [
          "install",
          "--no-save",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ]);
      } finally {
        await restoreCommitted(context, project);
      }
    } else installMs = await install(context, project, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);

    const check = await checkConsistency(project.dir, project.lockfile, signal);
    if (check.ok || result === "cold") await chargeInstall(context, project);
    if (!check.ok) {
      log("inconsistent", { detail: check.detail });
      // A tree npm ci built from the committed lockfile is what the agent
      // would install itself: keep it, but never snapshot it. A tree built
      // over a restored snapshot is removed.
      if (result === "nearest") throw new Skip("inconsistent");
      context.created = undefined;
      return { result, key, installMs, reason: "inconsistent" };
    }
    context.created = undefined;
    await removeNpmContentCache(context, project);
    const sizeBytes = await snapshot(context, project, answer.maxBytes);
    return {
      result,
      key,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(restoreMs !== undefined ? { restoreMs } : {}),
      installMs,
    };
  } catch (error) {
    const reason = asSkip(error, "internal_error").reason;
    await cleanup(context);
    return { result: "skipped", reason };
  } finally {
    if (!context.session.closed) for (const path of context.temps) await removeTemp(workspace, path);
  }
}

/** A restore (hit or nearest) that failed: rethrows when the work itself is
 *  over (the deadline, the run's cancellation or the seal), otherwise cleans
 *  up and returns the reason, so the caller installs cold instead. */
async function missedRestore(context, error) {
  const reason = asSkip(error, "internal_error").reason;
  if (STOPPED.has(reason) || context.signal.aborted || context.session.closed) throw error;
  // A .cache that is no longer a real folder: stop here rather than work through it.
  if (!(await cacheDirIntact(context.workspace))) throw new Skip("cache_dir_unsafe");
  await cleanup(context);
  return reason;
}
const STOPPED = new Set(["timeout", "cancelled", "sealed"]);

/** Removes a node_modules this run created and every temp file. */
async function cleanup(context) {
  // Once the caller stopped waiting, the workspace is the agent's: touch nothing.
  if (context.session.closed) return;
  if (context.created) {
    await rm(context.created, { recursive: true, force: true }).catch(() => undefined);
    context.created = undefined;
  }
  for (const path of context.temps.splice(0)) await removeTemp(context.workspace, path);
}

/** Removes one of this module's temp paths, only while <workspace>/.cache is
 *  still a real folder (never through a .cache swapped for a symlink). */
async function removeTemp(workspace, path) {
  if (!(await cacheDirIntact(workspace))) return;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

async function cacheDirIntact(workspace) {
  try {
    const info = await lstat(join(workspace, ".cache"));
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- discovery

async function isFile(path) {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** Root first, then by path (code point order, the same on every machine). */
const byProjectOrder = (a, b) => (a === "." ? -1 : b === "." ? 1 : a < b ? -1 : a > b ? 1 : 0);

/**
 * The folders holding a committed package-lock.json (a regular file): the
 * root ("."), then folders up to MAX_PROJECT_DEPTH levels down, root first
 * and then sorted by path. Never enters node_modules, dot-folders, symlinked
 * folders or a folder whose name the proxy would refuse as a project path,
 * so every path returned passes the proxy's projectPath rule.
 */
export async function discoverProjects(workspace, signal) {
  const found = [];
  if (await isFile(join(workspace, "package-lock.json"))) found.push(".");
  let visited = 0;
  const queue = [[]];
  while (queue.length) {
    signal?.throwIfAborted();
    const segments = queue.shift();
    if (segments.length >= MAX_PROJECT_DEPTH) continue;
    let entries;
    try {
      entries = await readdir(join(workspace, ...segments), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Dirent types come from lstat: a symlinked folder is not a directory here.
      if (!entry.isDirectory() || entry.name === ROOT || !PROJECT_SEGMENT.test(entry.name)) continue;
      visited += 1;
      if (visited > MAX_DISCOVERY_DIRS) return found.sort(byProjectOrder);
      const child = [...segments, entry.name];
      if (await isFile(join(workspace, ...child, "package-lock.json"))) found.push(child.join("/"));
      queue.push(child);
    }
  }
  return found.sort(byProjectOrder);
}

/** One glob segment as a regular expression (`*` and `?` within a segment). */
function segmentPattern(segment) {
  let source = "";
  for (const char of segment) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.|+(){}[\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Whether `segments` (or a folder above them) matches a workspaces glob. */
function globCovers(glob, segments) {
  const parts = glob
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (!parts.length || parts.some((part) => part.startsWith("!") || part === "..")) return false;
  // Braces, classes and extglobs are not interpreted: fail toward skipping.
  if (/[{}()[\]]/.test(glob)) return true;
  const match = (p, s) => {
    if (p === parts.length) return true; // the glob matched a folder at or above this one
    if (parts[p] === "**") {
      for (let skip = s; skip <= segments.length; skip += 1) if (match(p + 1, skip)) return true;
      return false;
    }
    return s < segments.length && segmentPattern(parts[p]).test(segments[s]) && match(p + 1, s + 1);
  };
  return match(0, 0);
}

/** Reads a regular file of at most `maxBytes` through one no-follow handle, so
 *  the file checked is the file read (no check-then-read race, no symlink
 *  followed). Throws when it is a symlink, not a regular file, or too large. */
export async function readRegularFile(path, maxBytes, encoding) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("not_readable_file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("not_readable_file");
    const bytes = buffer.subarray(0, length);
    return encoding ? bytes.toString(encoding) : bytes;
  } finally {
    await handle.close();
  }
}

/** The `workspaces` globs a project's package.json declares (array or { packages }). */
async function workspaceGlobs(workspace, projectPath) {
  const file = join(workspace, ...(projectPath === "." ? [] : projectPath.split("/")), "package.json");
  try {
    const manifest = JSON.parse(await readRegularFile(file, MAX_JSON_BYTES, "utf8"));
    const declared = manifest?.workspaces;
    const list = Array.isArray(declared) ? declared : Array.isArray(declared?.packages) ? declared.packages : [];
    return list.filter((glob) => typeof glob === "string");
  } catch {
    return [];
  }
}

/** The projects to prepare (at most MAX_PROJECTS) and those skipped up front:
 *  a folder inside another project's workspaces globs is `workspace_member`
 *  (npm-workspaces monorepos are out of scope), extras are `too_many_projects`. */
async function planProjects(workspace, signal) {
  const found = await discoverProjects(workspace, signal);
  const globs = new Map();
  for (const path of found) globs.set(path, await workspaceGlobs(workspace, path));
  const run = [];
  const skipped = [];
  for (const path of found) {
    const member = found.some((owner) => {
      if (owner === path) return false;
      const inside = owner === "." ? path : path.startsWith(`${owner}/`) ? path.slice(owner.length + 1) : undefined;
      return inside !== undefined && globs.get(owner).some((glob) => globCovers(glob, inside.split("/")));
    });
    if (member) skipped.push({ path, result: "skipped", reason: "workspace_member" });
    else if (run.length < MAX_PROJECTS) run.push(path);
    else skipped.push({ path, result: "skipped", reason: "too_many_projects" });
  }
  return { run, skipped };
}

// ---------------------------------------------------------------- install scripts

/** Whether the committed lockfile lists an installed package (a key under
 *  node_modules/, not a link) with an install script. */
function listsInstallScripts(lockfile) {
  return Object.entries(lockfile?.packages ?? {}).some(
    ([key, entry]) =>
      key.startsWith(`${ROOT}/`) &&
      entry &&
      typeof entry === "object" &&
      !entry.link &&
      entry.hasInstallScript === true,
  );
}

/** The only variables a rebuild sees: what npm needs to reach the registry
 *  through the shim, never the driver's secrets. */
const REBUILD_ENV_NAMES = new Set(["PATH", "HOME", "LANG", "TMPDIR"]);
const REBUILD_ENV_PREFIX = /^(?:npm_config_|NPM_CONFIG_|WARDBY_NPM_)/;
function rebuildEnv(env) {
  const out = {};
  for (const [name, value] of Object.entries(env))
    if (typeof value === "string" && (REBUILD_ENV_NAMES.has(name) || REBUILD_ENV_PREFIX.test(name))) out[name] = value;
  return out;
}

/**
 * After the seal: `npm rebuild` through the shim for a project whose
 * lockfile lists install scripts (snapshots are built with
 * --ignore-scripts). Output is never captured; a failure only logs.
 */
async function rebuild({ workspace, path, env, npmPath, timeouts, signal, session, log }) {
  const dir = path === "." ? workspace : join(workspace, ...path.split("/"));
  const started = Date.now();
  let outcome;
  try {
    const code = await run(npmPath, ["rebuild"], {
      cwd: dir,
      env: rebuildEnv(env),
      timeoutMs: timeouts.rebuildMs,
      killGraceMs: timeouts.killGraceMs,
      signal,
      session,
    });
    outcome = code === 0 ? "ok" : "failed";
  } catch (error) {
    outcome = asSkip(error, "failed").reason === "timeout" ? "timeout" : "failed";
  }
  log("rebuild", { project: path, status: outcome, ms: Date.now() - started });
  return outcome;
}

/** The registry auth `prepareDependencies` and `sealUploadWindow` use: the
 *  environment's (registryAuth), with `proxyUrl` / `token` overriding it. */
async function resolveAuth(env, proxyUrl, token) {
  let auth = await registryAuth(env);
  if (proxyUrl && (auth || token)) auth = { token: auth?.token, base: new URL("/registry/npm/", proxyUrl).toString() };
  if (auth && token) auth = { ...auth, token };
  return auth?.token ? auth : undefined;
}

/** Pauses between seal attempts: up to three attempts in all. */
const SEAL_RETRY_PAUSES_MS = Object.freeze([250, 1_000]);

/** POST /cache/npm/seal, retried (after a network failure or a 5xx, not a
 *  4xx) while `timeoutMs` lasts: every attempt and pause fits inside it.
 *  Confirmed only on the proxy's one success answer (200 `{ sealed: true }`);
 *  never throws. The proxy also seals on the run's first model request. */
async function postSeal(auth, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = { status: 0, confirmed: false };
  for (let attempt = 0; ; attempt += 1) {
    last = await postSealOnce(auth, until - Date.now());
    if (last.confirmed || (last.status >= 400 && last.status < 500)) return last;
    const pause = SEAL_RETRY_PAUSES_MS[attempt];
    if (pause === undefined || until - Date.now() <= pause) return last;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

async function postSealOnce(auth, timeoutMs) {
  if (timeoutMs <= 0) return { status: 0, confirmed: false };
  try {
    const sealed = await callJson(
      new URL("/cache/npm/seal", auth.base),
      { method: "POST", headers: { authorization: `Bearer ${auth.token}` } },
      timeoutMs,
      "seal_failed",
    );
    return { status: sealed.status, confirmed: sealed.status === 200 && sealed.body?.sealed === true };
  } catch {
    // an unsealed session expires with its upload window
    return { status: 0, confirmed: false };
  }
}

/**
 * Seals the run's upload window without preparing anything: for a caller
 * that is about to hand the workspace to the agent before (or instead of)
 * `prepareDependencies` (the Claude Code tool runner's first command). The
 * proxy's seal is idempotent. Same auth as `prepareDependencies`; never throws.
 */
export async function sealUploadWindow({ env, proxyUrl, token, timeoutMs = DEFAULT_TIMEOUTS.httpMs } = {}) {
  let auth;
  try {
    auth = await resolveAuth(env ?? {}, proxyUrl, token);
  } catch {
    return { status: 0, confirmed: false };
  }
  if (!auth) return { status: 0, confirmed: false };
  return postSeal(auth, timeoutMs);
}

/** The most of a run's remaining time the cache may take, as a share. */
export const DEADLINE_SHARE = 0.5;

/**
 * The cache's whole time bound in ms (the budget walk and prepareDependencies
 * together, which the caller splits): DEFAULT_TIMEOUTS.totalMs, or half the
 * time left before the run's deadline when that is sooner, so a short run
 * keeps most of its time for the agent. `deadlineAt` is the run's deadline
 * (an ISO string, Date or epoch ms); a missing or unreadable one leaves the
 * default. 0 when the deadline has passed.
 */
export function dependencyCacheTimeLimit(deadlineAt, now = Date.now()) {
  const at =
    deadlineAt instanceof Date
      ? deadlineAt.getTime()
      : typeof deadlineAt === "string"
        ? Date.parse(deadlineAt)
        : deadlineAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return DEFAULT_TIMEOUTS.totalMs;
  return Math.max(0, Math.min(DEFAULT_TIMEOUTS.totalMs, Math.floor(DEADLINE_SHARE * (at - now))));
}

/** What the budget check keeps back from the volume: max(64 MiB, 5%). */
const BUDGET_MARGIN_MIN_BYTES = 64 * MIB;
const BUDGET_MARGIN_FRACTION = 0.05;
/** Below this the cache is skipped (`budget_too_small`): no restore is worth trying. */
export const MIN_BUDGET_BYTES = 64 * MIB;
/** Bounds on measuring the workspace: time and entries. Past either, `budget_unknown`. */
export const BUDGET_MEASURE_TIMEOUT_MS = 30_000;
const BUDGET_MEASURE_MAX_ENTRIES = 500_000;

/**
 * The bytes the cache may restore or install into the workspace volume: the
 * run's volume size (`diskMb`, the Kubernetes emptyDir sizeLimit / Docker
 * tmpfs size, which statfs cannot see on Kubernetes) minus what the
 * workspace already uses minus a margin. Usage is a bounded walk of the whole
 * workspace (nothing excluded: the volume's limit counts everything),
 * allocated blocks where the platform reports them, links not followed.
 * Never throws: `{ reason: "budget_unknown" }` when diskMb is missing or the
 * walk can't finish in time, `{ reason: "budget_too_small" }` when what is
 * left is under MIN_BUDGET_BYTES; the caller then skips the cache.
 */
export async function dependencyCacheBudget({
  workspace,
  diskMb,
  signal,
  timeoutMs = BUDGET_MEASURE_TIMEOUT_MS,
  maxEntries = BUDGET_MEASURE_MAX_ENTRIES,
}) {
  if (!Number.isSafeInteger(diskMb) || diskMb <= 0) return { reason: "budget_unknown" };
  const used = await workspaceUsage(workspace, { signal, timeoutMs, maxEntries });
  if (used === undefined) return { reason: "budget_unknown" };
  const total = diskMb * MIB;
  const margin = Math.max(BUDGET_MARGIN_MIN_BYTES, Math.floor(total * BUDGET_MARGIN_FRACTION));
  const budgetBytes = total - used - margin;
  if (budgetBytes < MIN_BUDGET_BYTES) return { reason: "budget_too_small", usedBytes: used };
  return { budgetBytes, usedBytes: used };
}

/** Bytes the workspace uses: a bounded walk of all of it (allocated blocks
 *  where the platform reports them, links not followed). undefined past the
 *  time or entry bound, or on any error. */
async function workspaceUsage(
  workspace,
  { signal, timeoutMs = BUDGET_MEASURE_TIMEOUT_MS, maxEntries = BUDGET_MEASURE_MAX_ENTRIES } = {},
) {
  const deadlineAt = Date.now() + timeoutMs;
  let used = 0;
  let entries = 0;
  try {
    const stack = [workspace];
    while (stack.length) {
      signal?.throwIfAborted();
      if (Date.now() >= deadlineAt) return undefined;
      const directory = stack.pop();
      const names = await readdir(directory);
      for (const name of names) {
        if (++entries > maxEntries) return undefined;
        const info = await lstat(join(directory, name));
        used += Number.isFinite(info.blocks) && info.blocks > 0 ? info.blocks * 512 : info.size;
        if (info.isDirectory()) stack.push(join(directory, name));
      }
    }
  } catch {
    return undefined;
  }
  return used;
}

// ---------------------------------------------------------------- entry point

const KEPT = new Set(["hit", "nearest", "cold"]);

/**
 * Restores or installs the dependencies of every npm project in the
 * workspace (see discoverProjects), seals the run's upload window once, then
 * rebuilds install scripts. Never throws; nothing in the workspace changes
 * after it returns. `proxyUrl`/`token` override what the registry
 * environment names (the npm shim's npm_config_registry,
 * WARDBY_NPM_PLAN_REGISTRY and npmrc token).
 */
export async function prepareDependencies({
  workspace,
  env: givenEnv,
  proxyUrl,
  token,
  npmPath = "/opt/wardby/bin/npm",
  log = () => {},
  budgetBytes,
  usedBytes,
  minInstallBytes = MIN_INSTALL_BUDGET_BYTES,
  timeouts: overrides = {},
  signal: cancel,
  testHooks,
}) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...overrides };
  // Required: the agent-equivalent shell env. No process.env fallback, so a
  // caller can't hand the driver's secrets to npm by omission.
  const env = givenEnv ?? {};
  const uploadDeadline = Date.now() + timeouts.uploadWindowMs - timeouts.uploadMarginMs;
  const say = (event, fields = {}) => {
    try {
      log(event, fields);
    } catch {
      // a logger never fails the cache
    }
  };
  const session = { sealed: false, closed: false, children: new Set(), temps: new Set(), planRequests: 0 };
  // `deadline` bounds everything (projects and rebuilds); `sealing` stops the
  // project work (and any upload) at the seal.
  const deadline = new AbortController();
  const sealing = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(new Skip("timeout")), timeouts.totalMs);
  const workSignal = AbortSignal.any([deadline.signal, sealing.signal]);
  let auth;
  let planned; // set once planning succeeded
  const done = new Map(); // path -> result, filled as projects finish
  const facts = new Map(); // path -> { needsRebuild }, from the committed lockfile
  let failure;
  let sealConfirmed = false;

  let sealing$;
  const seal = () =>
    (sealing$ ??= (async () => {
      session.sealed = true;
      sealing.abort(new Skip("sealed"));
      if (!auth) return;
      const { status, confirmed } = await postSeal(auth, timeouts.httpMs);
      sealConfirmed = confirmed;
      say("seal", { status, confirmed: sealConfirmed });
    })());

  const phases = (async () => {
    try {
      auth = await resolveAuth(env, proxyUrl, token);
      const budget = await workspaceBudget(workspace, env, budgetBytes);
      // What the workspace used when the budget was set: later measurements count the growth from it.
      budget.baseUsed =
        Number.isSafeInteger(usedBytes) && usedBytes >= 0
          ? usedBytes
          : await workspaceUsage(workspace, { signal: workSignal });
      await testHooks?.beforeDiscovery?.();
      const { run: toRun, skipped } = await planProjects(workspace, workSignal);
      for (const entry of skipped) done.set(entry.path, { result: entry.result, reason: entry.reason });
      if (!toRun.length && !skipped.length) done.set(".", { result: "skipped", reason: "no_lockfile" });
      planned = toRun.length || skipped.length ? [...toRun, ...skipped.map((entry) => entry.path)] : ["."];
      for (const path of toRun) {
        if (workSignal.aborted) break;
        const projectFacts = {};
        facts.set(path, projectFacts);
        const result = await prepareProject({
          workspace,
          projectPath: path,
          env,
          npmPath,
          log: (event, fields) => say(event, { project: path, ...fields }),
          auth,
          budget,
          timeouts,
          signal: workSignal,
          session,
          testHooks,
          facts: projectFacts,
          uploadDeadline,
          minInstallBytes,
        });
        if (!session.closed) done.set(path, result);
      }
    } catch {
      failure = "internal_error";
    } finally {
      await seal();
    }
    // After the seal: nothing below can be uploaded. Still bounded by the
    // deadline. Install scripts are third-party code holding the run token:
    // they run only once the proxy confirmed the upload window is shut.
    if (!sealConfirmed && auth) say("rebuild_skipped", { reason: "unsealed" });
    for (const path of planned ?? []) {
      const result = done.get(path);
      if (!result || !KEPT.has(result.result) || session.closed) continue;
      if (!facts.get(path)?.needsRebuild) {
        done.set(path, { ...result, rebuild: "skipped" });
        continue;
      }
      if (!sealConfirmed) {
        done.set(path, { ...result, rebuild: "unsealed" });
        continue;
      }
      const outcome = await rebuild({
        workspace,
        path,
        env,
        npmPath,
        timeouts,
        signal: deadline.signal,
        session,
        log: say,
      });
      if (!session.closed) done.set(path, { ...result, rebuild: outcome });
    }
  })();

  // The deadline aborts the work, which then has settleMs to clean up. If it
  // still has not settled, the session is closed (below) so it can no longer
  // rename, remove, install or rebuild anything, nor upload.
  let grace;
  let endLate;
  const late = new Promise((resolve) => {
    endLate = resolve;
    grace = setTimeout(resolve, timeouts.totalMs + timeouts.settleMs);
  });
  // The caller's cancellation (the run was cancelled): the same as the
  // deadline arriving now, so the work stops and has settleMs to clean up.
  const onCancel = () => {
    deadline.abort(new Skip("cancelled"));
    clearTimeout(grace);
    grace = setTimeout(endLate, timeouts.settleMs);
  };
  if (cancel?.aborted) onCancel();
  else cancel?.addEventListener("abort", onCancel, { once: true });
  await Promise.race([phases, late]);
  cancel?.removeEventListener("abort", onCancel);
  clearTimeout(grace);
  clearTimeout(deadlineTimer);
  session.closed = true;
  deadline.abort(new Skip("timeout"));
  sealing.abort(new Skip("sealed"));
  for (const pid of session.children) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await seal();
  await removeOwnTemps(workspace, session.temps);

  if (!planned) {
    const reason = failure ?? "timeout";
    say("result", { reason });
    return { projects: [], reason };
  }
  const projects = planned
    .map((path) => {
      const result = done.get(path) ?? { result: "skipped", reason: failure ?? "timeout" };
      // A kept tree whose rebuild never got its turn before the deadline.
      const rebuilt =
        KEPT.has(result.result) && !result.rebuild
          ? { rebuild: facts.get(path)?.needsRebuild ? "timeout" : "skipped" }
          : {};
      return { path, ...result, ...rebuilt };
    })
    .sort((a, b) => byProjectOrder(a.path, b.path));
  for (const project of projects)
    say("result", {
      project: project.path,
      result: project.result,
      ...(project.reason ? { reason: project.reason } : {}),
      ...(project.rebuild ? { rebuild: project.rebuild } : {}),
    });
  return { projects };
}

/** Removes this module's own temp files under <workspace>/.cache, and
 *  nothing else: called once the session is closed, so a project that never
 *  settled does not leave its download or extraction folder behind. */
async function removeOwnTemps(workspace, temps) {
  const cacheDir = join(workspace, ".cache");
  if (!(await cacheDirIntact(workspace))) return;
  for (const path of temps) {
    if (!path.startsWith(cacheDir + sep) || path.slice(cacheDir.length + 1) !== basename(path)) continue;
    if (!OWN_TEMP.test(basename(path))) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}
