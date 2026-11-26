/**
 * A design's live document as a whole (spec "Live editing for designs"): its board list, which boards have a live
 * copy, a version's changes merged into it, and the file set it saves. The live server (web/live/formats/boards.ts)
 * and publishes based on an older version (merge-latest.ts) share these, so both merge the same way.
 */
import * as Y from "yjs";
import { parseManifest, serializeManifest, type Manifest } from "../format.js";
import { applyBoardMerge, boardOps, type MergeOp } from "./merge.js";
import { BOARD_ROOT, boardMaps, manifestOf } from "./model.js";
import { writeBoardFile } from "./writer.js";

export const DESIGN_META = "design";
const MANIFEST = "manifest.json";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** The board list as stored in the live document. */
export function liveManifest(doc: Y.Doc): Manifest {
  const boards = manifestOf(doc)
    .toArray()
    .map((m) => ({
      id: str(m.get("id")),
      name: str(m.get("name")),
      file: str(m.get("file")),
      width: Number(m.get("width") ?? 1280),
    }))
    .filter((b) => b.id && b.file);
  const title = doc.getMap(DESIGN_META).get("title");
  return { title: typeof title === "string" ? title : "", boards };
}

/** Puts a board list into the live document (its title too); boards no longer listed lose their live copies. */
export function setLiveManifest(doc: Y.Doc, m: Manifest): void {
  const arr = manifestOf(doc);
  arr.delete(0, arr.length);
  arr.push(
    m.boards.map((b) => {
      const entry = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(b)) entry.set(k, v);
      return entry;
    }),
  );
  doc.getMap(DESIGN_META).set("title", m.title);
  const listed = new Set(m.boards.map((b) => b.id));
  const boards = doc.getMap<unknown>("boards");
  for (const id of [...boards.keys()]) if (!listed.has(id)) boards.delete(id);
}

/** Whether a board has a live copy yet (its builder has written it). */
export function isBuilt(doc: Y.Doc, boardId: string): boolean {
  // Read only: boardMaps would create the board's maps, and on the server that is an edit everyone receives.
  const board = doc.getMap<unknown>("boards").get(boardId);
  const nodes: unknown = board instanceof Y.Map ? (board as Y.Map<unknown>).get("nodes") : undefined;
  return nodes instanceof Y.Map && nodes.has(BOARD_ROOT);
}

/**
 * The board list after a version: its changes from its base list (boards added, removed, renamed, resized,
 * reordered) applied to the list as it is now, so a board someone added meanwhile stays (after the new version's).
 */
export function mergeManifest(before: Manifest | null, next: Manifest, now: Manifest): Manifest {
  if (!before) return next;
  const was = new Map(before.boards.map((b) => [b.id, b]));
  const inNext = new Set(next.boards.map((b) => b.id));
  const nowById = new Map(now.boards.map((b) => [b.id, b]));
  const boards: Manifest["boards"] = [];
  for (const b of next.boards) {
    const old = was.get(b.id);
    const cur = nowById.get(b.id);
    if (!old) boards.push({ ...b });
    else if (!cur)
      continue; // someone deleted it meanwhile
    else
      boards.push({
        ...cur,
        name: b.name !== old.name ? b.name : cur.name,
        width: b.width !== old.width ? b.width : cur.width,
      });
  }
  // Boards added meanwhile (not in the base list), kept at the end.
  for (const b of now.boards) if (!was.has(b.id) && !inNext.has(b.id)) boards.push({ ...b });
  return { title: next.title !== before.title ? next.title : now.title, boards };
}

/** A version's changes from its base, worked out once, to apply to one or more live documents. */
export interface DesignMerge {
  /** Applies the changes to `doc` (in its own transaction, with `origin`); new elements take ids from `newId`. */
  apply(doc: Y.Doc, newId: () => string, origin: unknown): void;
}

/**
 * The changes from `before` (the base version's files, written from `base`, the base version's live state) to
 * `next`, by live element id. `now` is the live document the changes will land in: a board nobody had built at the
 * base but someone built since is compared through its live copy there. Throws version_map_mismatch when neither
 * the stored base file nor the live copy's writing lines up with the version map.
 */
export function planDesignMerge(
  base: Y.Doc,
  now: Y.Doc,
  before: Record<string, string>,
  next: Record<string, string>,
): DesignMerge {
  const nextManifest = parseManifest(next[MANIFEST] ?? "");
  const beforeManifest = typeof before[MANIFEST] === "string" ? parseManifest(before[MANIFEST]) : null;
  const plans: { board: string; ops: MergeOp[] }[] = [];
  for (const b of nextManifest.boards) {
    if (typeof next[b.file] !== "string" || before[b.file] === next[b.file]) continue;
    const atBase = isBuilt(base, b.id);
    if (!atBase && !isBuilt(now, b.id)) continue;
    plans.push({
      board: b.id,
      ops: boardOps(boardMaps(atBase ? base : now, b.id), before[b.file], next[b.file], atBase),
    });
  }
  const listChanged = beforeManifest === null || before[MANIFEST] !== next[MANIFEST];
  return {
    apply(doc, newId, origin) {
      doc.transact(() => {
        if (listChanged) setLiveManifest(doc, mergeManifest(beforeManifest, nextManifest, liveManifest(doc)));
        for (const p of plans) if (isBuilt(doc, p.board)) applyBoardMerge(boardMaps(doc, p.board), p.ops, newId);
      }, origin);
    },
  };
}

/** Element ids (GrapesJS-style) that are new in every given document. */
export function newElementIds(...docs: Y.Doc[]): () => string {
  const taken = new Set<string>();
  for (const doc of docs)
    for (const board of doc.getMap<unknown>("boards").keys())
      if (isBuilt(doc, board)) for (const id of boardMaps(doc, board).nodes.keys()) taken.add(id);
  return () => {
    for (;;) {
      const id = `i${Math.random().toString(36).slice(2, 8)}`;
      if (taken.has(id)) continue;
      taken.add(id);
      return id;
    }
  };
}

/**
 * The file set a live document saves: built boards from their live copies, the others from `files` (a board
 * nobody has built and that has no file is left out until it has one), files that are not boards (brand.md) from
 * `files`, and the board list with the boards that have files. Not yet in the board sanitizer's form.
 */
export function designFiles(doc: Y.Doc, files: Record<string, string>): Record<string, string> {
  const manifest = liveManifest(doc);
  const out: Record<string, string> = {};
  const boardFiles = new Set(Object.keys(files).filter((p) => p.startsWith("boards/")));
  for (const [p, text] of Object.entries(files)) if (p !== MANIFEST && !boardFiles.has(p)) out[p] = text;
  const listed: Manifest["boards"] = [];
  for (const b of manifest.boards) {
    if (isBuilt(doc, b.id)) out[b.file] = writeBoardFile(boardMaps(doc, b.id));
    else if (typeof files[b.file] === "string") out[b.file] = files[b.file];
    else continue;
    listed.push(b);
  }
  out[MANIFEST] = serializeManifest({ title: manifest.title, boards: listed });
  return out;
}
