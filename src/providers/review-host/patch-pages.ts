/**
 * repo_pr_read's diff pages: which files get the patch budget first (code before docs, help,
 * lockfiles, generated files and fixtures), how a page is filled from a cursor, and the cursor
 * itself. Shared by every review host so paging behaves the same on GitHub and local repositories.
 */
import { PatchCursorError, type PatchStatus, type PullRequestFileView } from "./types.js";

export interface PatchSource {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previousFilename?: string;
  /** Changed lines as the host counts them; 0 means there is nothing to show. */
  changes: number;
}

export interface PatchPage {
  files: PullRequestFileView[];
  patchesComplete: boolean;
  truncatedFiles: string[];
  nextPatchCursor: string | null;
  remainingPatchFiles: number;
}

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "pubspec.lock",
]);
const OTHER_EXTENSIONS = /\.(md|mdx|rst|adoc|txt|snap|svg|png|jpe?g|gif|webp|ico|pdf|lock)$/i;
const OTHER_DIRECTORY =
  /(^|\/)(docs?|help|generated|__generated__|dist|build|vendor|fixtures|__fixtures__|__snapshots__|testdata)\//i;
const MINIFIED = /\.min\.(js|css)$/i;

/** "code" (source, tests, config, migrations) is filled first; "other" is everything a review can skim. */
export function reviewGroup(path: string): "code" | "other" {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (LOCKFILES.has(base) || OTHER_EXTENSIONS.test(base) || MINIFIED.test(base) || OTHER_DIRECTORY.test(path))
    return "other";
  return "code";
}

/** Code first; the host's order within each group (stable). */
export function reviewOrder<T extends { filename: string }>(files: T[]): T[] {
  return [
    ...files.filter((f) => reviewGroup(f.filename) === "code"),
    ...files.filter((f) => reviewGroup(f.filename) === "other"),
  ];
}

const CURSOR = /^v1\.([0-9a-f]{40})\.([0-9a-f]{40}|-)\.(\d{1,6})\.(\d{1,9})$/;

function encodeCursor(headSha: string, comparedFrom: string | null, fileIndex: number, offset: number): string {
  return `v1.${headSha}.${comparedFrom ?? "-"}.${fileIndex}.${offset}`;
}

function parseCursor(
  cursor: string,
  headSha: string,
  comparedFrom: string | null,
): { fileIndex: number; offset: number } {
  const m = CURSOR.exec(cursor);
  if (!m) throw new PatchCursorError("malformed");
  if (m[1] !== headSha || m[2] !== (comparedFrom ?? "-")) throw new PatchCursorError("stale");
  return { fileIndex: Number(m[3]), offset: Number(m[4]) };
}

/** The longest prefix of `text` within `max` characters that ends at a line break; a single longer line is cut at `max`. */
function cutAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max - 1);
  return cut >= 0 ? text.slice(0, cut + 1) : text.slice(0, max);
}

/**
 * One page of patches: every file in review order, with patch content for the files from the
 * cursor on until `budget` characters are used. `load` is called only for files on this page
 * (undefined: the host has no patch, which is unavailable when the file has changes).
 */
export async function pagePatches(
  sources: PatchSource[],
  opts: { budget: number; cursor?: string; headSha: string; comparedFrom: string | null },
  load: (file: PatchSource) => Promise<string | undefined>,
): Promise<PatchPage> {
  const ordered = reviewOrder(sources);
  const start = opts.cursor ? parseCursor(opts.cursor, opts.headSha, opts.comparedFrom) : { fileIndex: 0, offset: 0 };
  if (start.fileIndex > ordered.length) throw new PatchCursorError("malformed");
  let budget = opts.budget;
  let next: { fileIndex: number; offset: number } | null = null;
  const files: PullRequestFileView[] = [];
  for (const [index, source] of ordered.entries()) {
    const { changes, ...view } = source;
    const out = (
      patchStatus: PatchStatus,
      patch = "",
      part?: { offset: number; continues: boolean },
    ): PullRequestFileView => ({
      ...view,
      patch,
      patchStatus,
      patchTruncated: patchStatus === "later_page" || patchStatus === "unavailable" || (part?.continues ?? false),
      ...(part ? { patchOffset: part.offset, patchContinues: part.continues } : {}),
    });
    if (index < start.fileIndex) {
      files.push(out(changes === 0 ? "empty" : "earlier_page"));
      continue;
    }
    if (next) {
      files.push(out(changes === 0 ? "empty" : "later_page"));
      continue;
    }
    const patch = await load(source);
    if (patch === undefined || patch === "") {
      files.push(out(changes === 0 ? "empty" : "unavailable"));
      continue;
    }
    const offset = index === start.fileIndex ? start.offset : 0;
    const rest = patch.slice(offset);
    if (rest.length <= budget) {
      files.push(offset === 0 ? out("complete", rest) : out("partial", rest, { offset, continues: false }));
      budget -= rest.length;
      if (budget <= 0 && index + 1 < ordered.length) next = { fileIndex: index + 1, offset: 0 };
      continue;
    }
    const part = budget > 0 ? cutAtLine(rest, budget) : "";
    if (part.length === 0) {
      files.push(out("later_page"));
      next = { fileIndex: index, offset };
      continue;
    }
    files.push(out("partial", part, { offset, continues: true }));
    next = { fileIndex: index, offset: offset + part.length };
  }
  const truncatedFiles = files.filter((f) => f.patchTruncated).map((f) => f.filename);
  const remainingPatchFiles =
    files.filter((f) => f.patchStatus === "later_page").length + (next && next.offset > 0 ? 1 : 0);
  return {
    files,
    truncatedFiles,
    remainingPatchFiles,
    nextPatchCursor: next ? encodeCursor(opts.headSha, opts.comparedFrom, next.fileIndex, next.offset) : null,
    patchesComplete: next === null && !files.some((f) => f.patchStatus === "unavailable"),
  };
}
