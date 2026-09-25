import type { InlineComment } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The lines a host accepts inline comments on for one file's unified patch:
 * added and context lines on the RIGHT (new) side, removed and context lines
 * on the LEFT (old) side. Hosts reject comments anywhere else, which is the
 * usual way review bots break; callers move those comments into the summary.
 */
export function commentableLines(patch: string): { right: Set<number>; left: Set<number> } {
  const right = new Set<number>();
  const left = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      right.add(newLine++);
    } else if (raw.startsWith("-")) {
      left.add(oldLine++);
    } else {
      right.add(newLine++);
      left.add(oldLine++);
    }
  }
  return { right, left };
}

/** Splits comments into those the host will accept inline and those that must go in the summary. */
export function partitionComments(
  comments: readonly InlineComment[],
  patches: ReadonlyMap<string, string | undefined>,
): { inline: InlineComment[]; outside: InlineComment[] } {
  const cache = new Map<string, { right: Set<number>; left: Set<number> }>();
  const inline: InlineComment[] = [];
  const outside: InlineComment[] = [];
  for (const comment of comments) {
    const patch = patches.get(comment.path);
    if (!patch) {
      outside.push(comment);
      continue;
    }
    let lines = cache.get(comment.path);
    if (!lines) {
      lines = commentableLines(patch);
      cache.set(comment.path, lines);
    }
    const allowed = comment.side === "LEFT" ? lines.left : lines.right;
    (allowed.has(comment.line) ? inline : outside).push(comment);
  }
  return { inline, outside };
}
