/**
 * The three-way merge of an agent's edit that conflicts with a newer version (agent-loop.ts): file by
 * file, and line by line inside a file both sides changed. Pure: no database, no repository. The inputs are stored (normalised) texts: `base` is the version
 * the threads were sent with, `theirs` the current version, `ours` the agent's prepared edit. A missing
 * file means deleted. What a "file" is per kind comes from the format adapter (agent-formats.ts): a
 * design's manifest and boards, or a Markdown document's one text.
 */
import type { VersionContent } from "./content.js";
import { myers, splitLines } from "./text-diff.js";

export type FileMap = Readonly<Record<string, string>>;

export type MergeResult = { kind: "merged"; files: Record<string, string> } | { kind: "conflict"; paths: string[] };

/** What the format adapter supplies: a version's content as files, and back. */
export interface MergeFormat {
  asFiles(content: VersionContent): Record<string, string>;
  fromFiles(files: Record<string, string>): VersionContent;
}

/** One side's change to the base: base lines [start, end) replaced by `lines`. */
type Hunk = { start: number; end: number; lines: string[] };

/** The hunks of an edit script from base to one side, in base order. */
function hunks(steps: readonly ("=" | "-" | "+")[], side: readonly string[]): Hunk[] {
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  for (const step of steps) {
    if (step === "=") {
      if (open) out.push(open);
      open = null;
      i++;
      j++;
      continue;
    }
    open ??= { start: i, end: i, lines: [] };
    if (step === "-") open.end = ++i;
    else open.lines.push(side[j++]);
  }
  if (open) out.push(open);
  return out;
}

const sameHunk = (a: Hunk, b: Hunk) =>
  a.start === b.start &&
  a.end === b.end &&
  a.lines.length === b.lines.length &&
  a.lines.every((l, k) => l === b.lines[k]);

/**
 * The line-level three-way merge of one file (diff3): base to ours and base to theirs are diffed over
 * lines (each with its newline, so a file without a final newline round-trips), and each side's
 * changes are hunks of base line ranges. Hunks that neither overlap nor touch (adjacent counts as
 * touching, as in git) are both applied; identical hunks once. Any other overlapping or touching
 * pair, or a diff past the Myers cap, makes the whole file a conflict: null, never conflict markers.
 */
export function mergeLines(base: string, theirs: string, ours: string): string | null {
  const ids = new Map<string, number>();
  const intern = (lines: string[]) =>
    lines.map((l) => {
      let id = ids.get(l);
      if (id === undefined) ids.set(l, (id = ids.size));
      return id;
    });
  const b = splitLines(base);
  const t = splitLines(theirs);
  const o = splitLines(ours);
  const bIds = intern(b);
  const tSteps = myers(bIds, intern(t));
  const oSteps = myers(bIds, intern(o));
  if (!tSteps || !oSteps) return null;
  const th = hunks(tSteps, t);
  const oh = hunks(oSteps, o);
  const out: string[] = [];
  let pos = 0;
  let i = 0;
  let k = 0;
  while (i < oh.length || k < th.length) {
    const a = oh[i];
    const c = th[k];
    let take: Hunk;
    if (a && c && a.start <= c.end && c.start <= a.end) {
      // Overlapping or touching: only the same change on both sides merges.
      if (!sameHunk(a, c)) return null;
      take = a;
      i++;
      k++;
    } else if (a && (!c || a.end < c.start)) {
      take = a;
      i++;
    } else {
      take = c;
      k++;
    }
    for (let x = pos; x < take.start; x++) out.push(b[x]);
    out.push(...take.lines);
    pos = take.end;
  }
  for (let x = pos; x < b.length; x++) out.push(b[x]);
  return out.join("");
}

/**
 * File by file over the union of paths: ours equals base, take theirs; theirs equals base, take
 * ours; ours equals theirs, take it; a file both sides changed is merged line by line (mergeLines)
 * when the changes do not overlap; otherwise the path conflicts (a file added on both sides
 * differently, or deleted on one and changed on the other, has nothing to merge lines against). The
 * result is merged only when no path conflicts; conflicting paths are listed sorted.
 */
export function mergeFiles(base: FileMap, theirs: FileMap, ours: FileMap): MergeResult {
  const get = (m: FileMap, p: string) => (Object.hasOwn(m, p) ? m[p] : undefined);
  const paths = [...new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(ours)])].sort();
  const files: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const p of paths) {
    const b = get(base, p);
    const t = get(theirs, p);
    const o = get(ours, p);
    let take: string | undefined;
    if (o === b) take = t;
    else if (t === b || o === t) take = o;
    else {
      const lines = b !== undefined && t !== undefined && o !== undefined ? mergeLines(b, t, o) : null;
      if (lines === null) {
        conflicts.push(p);
        continue;
      }
      take = lines;
    }
    if (take !== undefined) files[p] = take;
  }
  return conflicts.length ? { kind: "conflict", paths: conflicts } : { kind: "merged", files };
}

/**
 * mergeFiles over whole versions, through the kind's adapter. The caller still runs the result
 * through the format's prepare before publishing it, and treats a refusal as a conflict.
 */
export function mergeContent(
  fmt: MergeFormat,
  base: VersionContent,
  theirs: VersionContent,
  ours: VersionContent,
): { kind: "merged"; content: VersionContent } | { kind: "conflict"; paths: string[] } {
  const r = mergeFiles(fmt.asFiles(base), fmt.asFiles(theirs), fmt.asFiles(ours));
  return r.kind === "merged" ? { kind: "merged", content: fmt.fromFiles(r.files) } : r;
}

/** The files `ours` changed or added relative to `base` (as ours has them), and the ones it deleted; sorted. */
export function editedFiles(base: FileMap, ours: FileMap): { changed: Record<string, string>; deleted: string[] } {
  const changed: Record<string, string> = {};
  for (const p of Object.keys(ours).sort()) {
    if (!Object.hasOwn(base, p) || base[p] !== ours[p]) changed[p] = ours[p];
  }
  const deleted = Object.keys(base)
    .filter((p) => !Object.hasOwn(ours, p))
    .sort();
  return { changed, deleted };
}
