/**
 * Collects the Claude Code context a repository ships for itself, so a coding
 * run can hand it to the worker: the instruction files (`CLAUDE.md`,
 * `.claude/CLAUDE.md`, and the files they pull in with `@path` imports) and,
 * when repository skills are enabled, each `.claude/skills/<name>/SKILL.md`.
 *
 * Only those files are read, and every one must pass `isAllowedContextPath`
 * (an import of anything else, such as `.claude/settings.json`, `.mcp.json`,
 * `CLAUDE.local.md`, or a non-Markdown file, is skipped as `not_allowed`).
 * Repository settings, hooks, MCP configuration, agents, and commands under
 * `.claude/` are never collected.
 *
 * Repository content is untrusted, so the reader is deliberately strict:
 * - every path must stay inside the workspace (no absolute, `~`, or `..`
 *   imports, nothing under `.git/`);
 * - symlinks are refused, both the file itself and any directory on the way
 *   to it, so a link cannot pull in a file from outside the checkout;
 * - only regular, valid UTF-8 files of at most 64 KiB are read, at most 200
 *   files and 256 KiB in total; `@imports` are followed at most 5 levels deep.
 *
 * A file that breaks a rule is left out and reported in `skipped` with the
 * reason (the first 50; further ones are only counted in `skippedOverflow`,
 * as are imports beyond the first 100 of a file, which are not followed);
 * nothing a repository contains makes this function throw.
 *
 * If a repository has no `CLAUDE.md` or `.claude/CLAUDE.md` but does have an
 * `AGENTS.md`, a one-line `CLAUDE.md` that imports it is synthesized, so
 * repositories written for other coding agents still get their instructions.
 */
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { CLAUDE_CONTEXT_LIMITS, isAllowedContextPath, isSafeContextPath, type ClaudeContextFile } from "./protocol.js";

export interface ClaudeContextSkip {
  path: string;
  reason: "symlink" | "not_file" | "too_large" | "not_utf8" | "limit" | "outside_repo" | "not_allowed";
}

export interface ClaudeContext {
  files: ClaudeContextFile[];
  /** Files left out and why, at most `MAX_RECORDED_SKIPS` entries. */
  skipped: ClaudeContextSkip[];
  /**
   * How many further files were left out without an entry in `skipped`: skips
   * beyond `MAX_RECORDED_SKIPS`, plus `@imports` beyond `MAX_IMPORTS_PER_FILE`
   * in a single file, which are not followed at all, plus 1 when `.claude/skills` has more than
   * `MAX_SKILL_ENTRIES` entries. 0 when nothing overflowed.
   */
  skippedOverflow: number;
}

/** Content of the `CLAUDE.md` synthesized for a repository that only has `AGENTS.md`. */
export const AGENTS_BRIDGE = "@AGENTS.md\n";

const ROOTS = ["CLAUDE.md", ".claude/CLAUDE.md"] as const;
const SKILLS_DIR = ".claude/skills";
const MAX_IMPORT_DEPTH = 5;

/** At most this many `skipped` entries are recorded; the rest are only counted in `skippedOverflow`. */
export const MAX_RECORDED_SKIPS = 50;
/** Only the first this-many distinct `@imports` of each file are followed; the rest are counted in `skippedOverflow`. */
export const MAX_IMPORTS_PER_FILE = 100;
/**
 * At most this many `.claude/skills` entries are considered (matching the Codex worker's scan cap);
 * if there are more, the rest are neither read nor counted beyond adding one to `skippedOverflow`.
 */
export const MAX_SKILL_ENTRIES = 2000;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const IMPORT = /(?:^|\s)@([^\s`]+)/gm;
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", ")"]);

/**
 * Removes inline code spans from one paragraph in a single linear pass. A run
 * of backticks opens a span that ends at the next run of exactly the same
 * length; a run with no closing partner is kept as literal text. Spans never
 * cross paragraphs because the caller passes one paragraph at a time.
 */
function stripInlineCode(paragraph: string): string {
  const runs: { start: number; end: number }[] = [];
  for (let i = 0; i < paragraph.length;) {
    if (paragraph[i] !== "`") {
      i++;
      continue;
    }
    const start = i;
    while (i < paragraph.length && paragraph[i] === "`") i++;
    runs.push({ start, end: i });
  }
  if (runs.length === 0) return paragraph;
  // Indexes of the runs of each length, in order, with a pointer that only
  // moves forward, so finding every closer costs linear time overall.
  const byLength = new Map<number, { indexes: number[]; next: number }>();
  runs.forEach((run, index) => {
    const length = run.end - run.start;
    const entry = byLength.get(length) ?? { indexes: [], next: 0 };
    entry.indexes.push(index);
    byLength.set(length, entry);
  });
  let output = "";
  let copied = 0;
  for (let i = 0; i < runs.length;) {
    const entry = byLength.get(runs[i].end - runs[i].start)!;
    while (entry.next < entry.indexes.length && entry.indexes[entry.next] <= i) entry.next++;
    if (entry.next >= entry.indexes.length) {
      i++;
      continue;
    }
    const closer = entry.indexes[entry.next];
    output += paragraph.slice(copied, runs[i].start);
    copied = runs[closer].end;
    i = closer + 1;
  }
  return output + paragraph.slice(copied);
}

function trimTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(token[end - 1])) end--;
  return token.slice(0, end);
}

/**
 * Returns the `@path` imports in a Markdown instruction file, in order and
 * de-duplicated. Imports inside fenced code blocks and inline code spans are
 * ignored, as is an `@` not preceded by whitespace (an e-mail address). Runs
 * in time linear in the input, whatever the repository puts in it.
 */
export function importsOf(markdown: string): string[] {
  const paragraphs: string[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) paragraphs.push(stripInlineCode(paragraph.join("\n")));
    paragraph = [];
  };
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker !== undefined) {
      endParagraph();
      fence = marker;
      continue;
    }
    if (line.trim() === "") endParagraph();
    else paragraph.push(line);
  }
  endParagraph();
  const found = new Set<string>();
  for (const text of paragraphs) {
    for (const match of text.matchAll(IMPORT)) {
      const target = trimTrailingPunctuation(match[1]);
      if (target.length > 0) found.add(target);
    }
  }
  return [...found];
}

type Inspection =
  { kind: "absent" } | { kind: "skip"; reason: ClaudeContextSkip["reason"] } | { kind: "file"; stats: Stats };
type ReadResult =
  { kind: "absent" } | { kind: "skip"; reason: ClaudeContextSkip["reason"] } | { kind: "ok"; bytes: Buffer };

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Maps a filesystem error on repository content to a skip reason (or "absent"). */
function failure(error: unknown): Inspection & ReadResult {
  if (isMissing(error)) return { kind: "absent" };
  if ((error as NodeJS.ErrnoException).code === "ELOOP") return { kind: "skip", reason: "symlink" };
  return { kind: "skip", reason: "not_file" };
}

/**
 * Checks `rel` without reading it: every directory from the workspace down
 * must be a real directory (a symlink is refused), and the file itself must be
 * a regular file no larger than the per-file limit.
 */
async function inspect(workspace: string, rel: string): Promise<Inspection> {
  const segments = rel.split("/");
  let current = workspace;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      return failure(error);
    }
    if (stats.isSymbolicLink()) return { kind: "skip", reason: "symlink" };
    if (!stats.isDirectory()) return { kind: "absent" };
  }
  let stats: Stats;
  try {
    stats = await lstat(join(workspace, rel));
  } catch (error) {
    return failure(error);
  }
  if (stats.isSymbolicLink()) return { kind: "skip", reason: "symlink" };
  if (!stats.isFile()) return { kind: "skip", reason: "not_file" };
  if (stats.size > CLAUDE_CONTEXT_LIMITS.maxFileBytes) return { kind: "skip", reason: "too_large" };
  return { kind: "file", stats };
}

/**
 * Reads a file that `inspect` accepted, re-checking against the open handle so
 * a swap between the check and the read is caught: O_NOFOLLOW refuses a final
 * symlink, the descriptor must be the inode that was inspected, the resolved
 * path must still sit at the same place inside the workspace (no directory on
 * the way became a symlink), and no more than the per-file limit is read even
 * if the file grew.
 */
async function readChecked(
  realWorkspace: string,
  workspace: string,
  rel: string,
  inspected: Stats,
): Promise<ReadResult> {
  const absolute = join(workspace, rel);
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return failure(error);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "skip", reason: "not_file" };
    if (stats.ino !== inspected.ino || stats.dev !== inspected.dev) return { kind: "skip", reason: "symlink" };
    if ((await realpath(absolute)) !== join(realWorkspace, rel)) return { kind: "skip", reason: "symlink" };
    const limit = CLAUDE_CONTEXT_LIMITS.maxFileBytes;
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) return { kind: "skip", reason: "too_large" };
    return { kind: "ok", bytes: buffer.subarray(0, length) };
  } catch (error) {
    return failure(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Resolves an `@import` written in `importer` to a repository-relative path,
 * or reports it as outside the repository. An import that is absolute,
 * home-relative (`~`), or climbs above the repository root is reported as
 * written, since it has no repository-relative form; one that resolves inside
 * the repository but to a refused location (such as `.git/`) is reported by
 * its normalized repository-relative path.
 */
function resolveImport(importer: string, target: string): { path: string } | { skip: string } {
  if (target.startsWith("~") || target.startsWith("/")) return { skip: target };
  const resolved = posix.normalize(posix.join(posix.dirname(importer), target.replace(/^(\.\/)+/, "")));
  if (resolved === ".." || resolved.startsWith("../")) return { skip: target };
  if (!isSafeContextPath(resolved)) return { skip: resolved };
  return { path: resolved };
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Builds the Claude Code context for the checkout at `workspace`. Files are
 * ordered roots first, then imports breadth-first, then skills by directory
 * name. A file reached more than once is read once. Once the next file would
 * exceed the file-count or total-size limit, it and every later candidate are
 * reported as `limit` without being read.
 */
export async function buildClaudeContext(workspace: string, options: { skills: boolean }): Promise<ClaudeContext> {
  const realWorkspace = await realpath(workspace);
  const files: ClaudeContextFile[] = [];
  const skipped: ClaudeContextSkip[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let limitReached = false;
  let skippedOverflow = 0;

  const skip = (path: string, reason: ClaudeContextSkip["reason"]) => {
    if (skipped.length < MAX_RECORDED_SKIPS) skipped.push({ path, reason });
    else skippedOverflow++;
  };
  const importsToFollow = (content: string): string[] => {
    const targets = importsOf(content);
    skippedOverflow += Math.max(0, targets.length - MAX_IMPORTS_PER_FILE);
    return targets.slice(0, MAX_IMPORTS_PER_FILE);
  };

  const add = (path: string, content: string): boolean => {
    const size = Buffer.byteLength(content);
    if (files.length >= CLAUDE_CONTEXT_LIMITS.maxFiles || totalBytes + size > CLAUDE_CONTEXT_LIMITS.maxTotalBytes) {
      limitReached = true;
      skip(path, "limit");
      return false;
    }
    files.push({ path, content });
    totalBytes += size;
    return true;
  };

  /** Loads one candidate; returns its content when it was added, otherwise undefined. */
  const load = async (rel: string): Promise<string | undefined> => {
    // Once the limit is reached nothing more is loaded, so later candidates are not even inspected
    // (a candidate that does not exist is then also reported as limit).
    if (limitReached) return void skip(rel, "limit");
    const inspection = await inspect(workspace, rel);
    if (inspection.kind === "absent") return undefined;
    if (inspection.kind === "skip") return void skip(rel, inspection.reason);
    if (
      files.length >= CLAUDE_CONTEXT_LIMITS.maxFiles ||
      totalBytes + inspection.stats.size > CLAUDE_CONTEXT_LIMITS.maxTotalBytes
    ) {
      limitReached = true;
      return void skip(rel, "limit");
    }
    const read = await readChecked(realWorkspace, workspace, rel, inspection.stats);
    if (read.kind === "absent") return undefined;
    if (read.kind === "skip") return void skip(rel, read.reason);
    let content: string;
    try {
      content = decoder.decode(read.bytes);
    } catch {
      return void skip(rel, "not_utf8");
    }
    return add(rel, content) ? content : undefined;
  };

  // Roots, or the AGENTS.md bridge when neither root path exists at all. A
  // root that exists but is refused (a symlink, too large, ...) is reported
  // and does not fall back to AGENTS.md.
  const queue: { path: string; depth: number }[] = [];
  let rootExists = false;
  for (const root of ROOTS) {
    seen.add(root);
    if ((await inspect(workspace, root)).kind !== "absent") rootExists = true;
    queue.push({ path: root, depth: 0 });
  }
  if (!rootExists && (await inspect(workspace, "AGENTS.md")).kind !== "absent") {
    queue.length = 0;
    seen.add("AGENTS.md");
    const agents = await load("AGENTS.md");
    if (agents !== undefined) {
      // The bridge goes first, as the file that imports AGENTS.md.
      files.unshift({ path: "CLAUDE.md", content: AGENTS_BRIDGE });
      totalBytes += Buffer.byteLength(AGENTS_BRIDGE);
      for (const target of importsToFollow(agents)) enqueue("AGENTS.md", target, 2);
    }
  }

  function enqueue(importer: string, target: string, depth: number): void {
    const resolved = resolveImport(importer, target);
    const path = "path" in resolved ? resolved.path : resolved.skip;
    if (seen.has(path)) return;
    seen.add(path);
    if ("skip" in resolved) skip(resolved.skip, "outside_repo");
    // Settings, hooks, MCP configuration, agents, commands, and anything not Markdown are never
    // read, whatever an instruction file imports.
    else if (!isAllowedContextPath(path)) skip(path, "not_allowed");
    else queue.push({ path, depth });
  }

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const content = await load(next.path);
    if (content === undefined || next.depth >= MAX_IMPORT_DEPTH) continue;
    for (const target of importsToFollow(content)) enqueue(next.path, target, next.depth + 1);
  }

  if (options.skills) {
    const listing = await skillNames(workspace, skip);
    if (listing.truncated) skippedOverflow++;
    for (const name of listing.names) {
      const rel = `${SKILLS_DIR}/${name}/SKILL.md`;
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (!isSafeContextPath(rel)) skip(rel, "outside_repo");
      else if (!isAllowedContextPath(rel)) skip(rel, "not_allowed");
      else await load(rel);
    }
  }

  return { files, skipped, skippedOverflow };
}

/**
 * Lists the entries of `.claude/skills`, sorted by name: at most
 * `MAX_SKILL_ENTRIES` of them, in directory order, with `truncated` set when
 * more exist. A missing skills directory yields none; a symlinked one is
 * reported and yields none.
 */
async function skillNames(
  workspace: string,
  skip: (path: string, reason: ClaudeContextSkip["reason"]) => void,
): Promise<{ names: string[]; truncated: boolean }> {
  const none = { names: [], truncated: false };
  for (const directory of [".claude", SKILLS_DIR]) {
    let stats: Stats;
    try {
      stats = await lstat(join(workspace, directory));
    } catch {
      return none;
    }
    if (stats.isSymbolicLink()) {
      skip(directory, "symlink");
      return none;
    }
    if (!stats.isDirectory()) return none;
  }
  const names: string[] = [];
  let truncated = false;
  try {
    const dir = await opendir(join(workspace, SKILLS_DIR));
    try {
      for (let entry = await dir.read(); entry !== null; entry = await dir.read()) {
        if (names.length >= MAX_SKILL_ENTRIES) {
          truncated = true;
          break;
        }
        names.push(entry.name);
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
  } catch {
    return none;
  }
  return { names: names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), truncated };
}
