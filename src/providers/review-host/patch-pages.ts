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
// docs/ and help/ are the repository's own documentation folders (root only); the rest can be anywhere.
const OTHER_DIRECTORY =
  /^(docs?|help)\/|(^|\/)(generated|__generated__|dist|vendor|fixtures|__fixtures__|__snapshots__|testdata)\//i;
const MINIFIED = /\.min\.(js|css)$/i;

/** The longest patchCursor this module issues or accepts; callers use it as the tool schema's maximum. */
export const MAX_PATCH_CURSOR_CHARS = 4000;

/** "code" (source, tests, config, migrations) is filled first; "other" is everything a review can skim. */
export function reviewGroup(path: string): "code" | "other" {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/^requirements.*\.txt$/i.test(base) || base === "CMakeLists.txt") return "code";
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

const CURSOR = /^v1\.([0-9a-f]{40})\.([0-9a-f]{40}|-)\.(\d{1,6})\.(\d{1,9})\.(-|\d{1,6}(?:,\d{1,6})*)$/;

interface CursorPosition {
  fileIndex: number;
  offset: number;
  /** Indexes (review order, ascending, all before fileIndex) of files found unavailable on earlier pages. */
  unavailable: number[];
}

function encodeCursor(headSha: string, comparedFrom: string | null, pos: CursorPosition): string {
  const u = pos.unavailable.length ? pos.unavailable.join(",") : "-";
  return `v1.${headSha}.${comparedFrom ?? "-"}.${pos.fileIndex}.${pos.offset}.${u}`;
}

function parseCursor(cursor: string, headSha: string, comparedFrom: string | null, fileCount: number): CursorPosition {
  const m = cursor.length <= MAX_PATCH_CURSOR_CHARS ? CURSOR.exec(cursor) : null;
  if (!m) throw new PatchCursorError("malformed");
  if (m[1] !== headSha || m[2] !== (comparedFrom ?? "-")) throw new PatchCursorError("stale");
  const pos: CursorPosition = {
    fileIndex: Number(m[3]),
    offset: Number(m[4]),
    unavailable: m[5] === "-" ? [] : m[5].split(",").map(Number),
  };
  if (pos.fileIndex > fileCount) throw new PatchCursorError("malformed");
  let previous = -1;
  for (const index of pos.unavailable) {
    if (index <= previous || index >= pos.fileIndex) throw new PatchCursorError("malformed");
    previous = index;
  }
  return pos;
}

/**
 * The longest prefix of `text` within `max` characters that ends at a line break. With no break
 * in range, a single longer line is cut at `max` when `hardCut`, else nothing is returned.
 */
function cutAtLine(text: string, max: number, hardCut: boolean): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max - 1);
  if (cut >= 0) return text.slice(0, cut + 1);
  return hardCut ? text.slice(0, max) : "";
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
  const start: CursorPosition = opts.cursor
    ? parseCursor(opts.cursor, opts.headSha, opts.comparedFrom, ordered.length)
    : { fileIndex: 0, offset: 0, unavailable: [] };
  const earlierUnavailable = new Set(start.unavailable);
  const unavailable = [...start.unavailable];
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
      files.push(out(changes === 0 ? "empty" : earlierUnavailable.has(index) ? "unavailable" : "earlier_page"));
      continue;
    }
    if (next) {
      files.push(out(changes === 0 ? "empty" : "later_page"));
      continue;
    }
    const patch = await load(source);
    const offset = index === start.fileIndex ? start.offset : 0;
    if (patch === undefined || patch === "") {
      if (offset > 0) throw new PatchCursorError("malformed");
      if (changes === 0) {
        files.push(out("empty"));
      } else {
        files.push(out("unavailable"));
        unavailable.push(index);
      }
      continue;
    }
    // A cursor never points at the end: the part that reaches it does not continue.
    if (offset >= patch.length && offset > 0) throw new PatchCursorError("malformed");
    const rest = patch.slice(offset);
    if (rest.length <= budget) {
      files.push(offset === 0 ? out("complete", rest) : out("partial", rest, { offset, continues: false }));
      budget -= rest.length;
      if (budget <= 0 && index + 1 < ordered.length) next = { fileIndex: index + 1, offset: 0 };
      continue;
    }
    // A single line longer than the whole budget is cut only when nothing else is on the page;
    // otherwise the file waits for the next page.
    const firstContent = !files.some((f) => f.patchStatus === "complete" || f.patchStatus === "partial");
    const part = budget > 0 ? cutAtLine(rest, budget, firstContent) : "";
    if (part.length === 0) {
      files.push(out("later_page"));
      next = { fileIndex: index, offset };
      continue;
    }
    files.push(out("partial", part, { offset, continues: true }));
    next = { fileIndex: index, offset: offset + part.length };
  }
  const truncatedFiles = files.filter((f) => f.patchTruncated).map((f) => f.filename);
  const remainingPatchFiles = files.filter(
    (f) => f.patchStatus === "later_page" || (f.patchStatus === "partial" && f.patchContinues),
  ).length;
  return {
    files,
    truncatedFiles,
    remainingPatchFiles,
    nextPatchCursor: next
      ? encodeCursor(opts.headSha, opts.comparedFrom, {
          ...next,
          unavailable: unavailable.filter((i) => i < next.fileIndex),
        })
      : null,
    patchesComplete: next === null && unavailable.length === 0,
  };
}
