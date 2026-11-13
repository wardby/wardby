/**
 * The per-file three-way merge of an agent's edit that conflicts with a newer version (agent-loop.ts).
 * Pure: no database, no repository. The inputs are stored (normalised) texts: `base` is the version
 * the threads were sent with, `theirs` the current version, `ours` the agent's prepared edit. A missing
 * file means deleted. What a "file" is per kind comes from the format adapter (agent-formats.ts): a
 * design's manifest and boards, or a Markdown document's one text.
 */
import type { VersionContent } from "./content.js";

export type FileMap = Readonly<Record<string, string>>;

export type MergeResult = { kind: "merged"; files: Record<string, string> } | { kind: "conflict"; paths: string[] };

/** What the format adapter supplies: a version's content as files, and back. */
export interface MergeFormat {
  asFiles(content: VersionContent): Record<string, string>;
  fromFiles(files: Record<string, string>): VersionContent;
}

/**
 * File by file over the union of paths: ours equals base, take theirs; theirs equals base, take
 * ours; ours equals theirs, take it; otherwise the path conflicts. The result is merged only when no
 * path conflicts; conflicting paths are listed sorted.
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
      conflicts.push(p);
      continue;
    }
    if (take !== undefined) files[p] = take;
  }
  return conflicts.length ? { kind: "conflict", paths: conflicts } : { kind: "merged", files };
}

/** mergeFiles over whole versions, through the kind's adapter. */
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
