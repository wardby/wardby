/**
 * Designs in the live server (spec "Live editing for designs"): the live document holds the board list and, per
 * board, its live copy (core/documents/boards/live/model.ts). The server never parses a board: the first browser to
 * open a board builds its live copy with GrapesJS and stores the file's parts with it; the server writes board files
 * from live copies (core/documents/boards/live/writer.ts) for checkpoints, compared in the sanitizer's normal form,
 * and a board nobody has opened keeps its stored text.
 *
 * Builder choice (per board): a page that opens a board sends `{ type: "open-board", board }`; the first page to
 * open a board that has no live copy yet is told to build it (`{ type: "board", board, role: "build" }`), the others
 * to wait (`role: "wait"`) and then read it from the live copy; if the builder leaves before building, the next
 * waiting page is told to build. A board that already has a live copy answers `role: "join"`.
 */
import * as Y from "yjs";
import { checkCss } from "../../../core/documents/boards/css-check.js";
import {
  BOARD_MAX_BYTES,
  normalizeDesign,
  parseManifest,
  serializeManifest,
  type Manifest,
} from "../../../core/documents/boards/format.js";
import { sanitizeFragment } from "../../../core/documents/boards/sanitize.js";
import {
  BOARD_ROOT,
  boardMaps,
  manifestOf,
  orderedPairs,
  R,
  type BoardMaps,
} from "../../../core/documents/boards/live/model.js";
import { applyBoardMerge, boardOps, type MergeOp } from "../../../core/documents/boards/live/merge.js";
import { writeBoard, writeBoardFile, writeElement } from "../../../core/documents/boards/live/writer.js";
import { loadVersionFiles } from "../../../core/documents/files.js";
import type { WebDeps } from "../../context.js";
import { SERVER_ORIGIN, type LiveFormat, type LiveVersion } from "./types.js";

export const DESIGN_META = "design";
const MANIFEST = "manifest.json";

/** Stable text of a file set (key order fixed), what checkpoints compare. */
const filesText = (files: Record<string, string>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/** A live-document field as text (anything else as the fallback). */
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
function setLiveManifest(doc: Y.Doc, m: Manifest): void {
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

/** Whether a board has a live copy yet (its builder has written it). */
export function isBuilt(doc: Y.Doc, boardId: string): boolean {
  // Read only: boardMaps would create the board's maps, and on the server that is an edit everyone receives.
  const board = doc.getMap<unknown>("boards").get(boardId);
  const nodes: unknown = board instanceof Y.Map ? (board as Y.Map<unknown>).get("nodes") : undefined;
  return nodes instanceof Y.Map && nodes.has(BOARD_ROOT);
}

/** Every string a design's live document shows: text, attributes, CSS values, board names (for secret checks). */
export function liveStrings(doc: Y.Doc): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (v instanceof Y.Map) for (const x of (v as Y.Map<unknown>).values()) walk(x);
    else if (v instanceof Y.Array) for (const x of (v as Y.Array<unknown>).toArray()) walk(x);
  };
  walk(doc.getMap("boards"));
  walk(manifestOf(doc));
  walk(doc.getMap(DESIGN_META));
  return out;
}

/** What one edit touched, per board: everything (a new board), or these elements and rules, and the base layer. */
interface Touched {
  all: boolean;
  nodes: Set<string>;
  rules: Set<string>;
  meta: boolean;
}

/** Applies an edit to `scratch` and returns what it touched in the boards (the board list is small: always checked). */
export function watchEdit(scratch: Y.Doc, apply: () => void): Map<string, Touched> {
  const touched = new Map<string, Touched>();
  const mark = (board: string): Touched => {
    let t = touched.get(board);
    if (!t) touched.set(board, (t = { all: false, nodes: new Set(), rules: new Set(), meta: false }));
    return t;
  };
  const boards = scratch.getMap<unknown>("boards");
  const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    for (const e of events) {
      const path = e.path.map(String);
      const keys = [...e.changes.keys.keys()];
      if (path.length === 0) {
        for (const k of keys) mark(k).all = true;
        continue;
      }
      const t = mark(path[0]);
      if (path.length === 1) {
        t.all = true;
        continue;
      }
      const into = path[1] === "nodes" ? t.nodes : path[1] === "rules" ? t.rules : null;
      if (into) {
        if (path.length >= 3) into.add(path[2]);
        else for (const k of keys) into.add(k);
      } else if (path[1] === "meta") t.meta = true;
    }
  };
  boards.observeDeep(handler);
  try {
    apply();
  } finally {
    boards.unobserveDeep(handler);
  }
  return touched;
}

/** Every string under a live-copy map (text, attributes, CSS values). */
function stringsIn(v: unknown, out: string[]): string[] {
  if (typeof v === "string") out.push(v);
  else if (v instanceof Y.Map) for (const x of (v as Y.Map<unknown>).values()) stringsIn(x, out);
  else if (v instanceof Y.Array) for (const x of (v as Y.Array<unknown>).toArray()) stringsIn(x, out);
  return out;
}

/** One rule as CSS text (for the CSS check). */
function ruleCss(maps: BoardMaps, key: string): string {
  const y = maps.rules.get(key);
  if (!y) return "";
  const decl = orderedPairs(y.get(R.style) as Y.Map<string>, y.get(R.props) as Y.Array<string>)
    .map(([p, v]) => `${p}:${v};`)
    .join("");
  const at = typeof y.get(R.atRule) === "string" ? (y.get(R.atRule) as string) : "";
  const sel = typeof y.get(R.sel) === "string" ? (y.get(R.sel) as string) : "";
  if (y.get(R.single)) return `${at}{${decl}}`;
  return at ? `${at}{${sel}{${decl}}}` : `${sel}{${decl}}`;
}

/**
 * Why an edit is refused, checking only what it touched with the board format's own rules: the elements through
 * the board sanitizer's allow-list (no scripts, event handlers, javascript: URLs or external references), the rules
 * and the base layer through the CSS check, the board's size, and secret values in the touched text.
 */
export function checkEdit(scratch: Y.Doc, touched: Map<string, Touched>, secretValues: string[]): string | null {
  const strings = liveStringsOutsideBoards(scratch);
  for (const [board, t] of touched) {
    if (!(scratch.getMap<unknown>("boards").get(board) instanceof Y.Map)) continue;
    const maps = boardMaps(scratch, board);
    const ids = t.all ? [...maps.nodes.keys()] : [...t.nodes].filter((id) => maps.nodes.has(id));
    const keys = t.all ? [...maps.rules.keys()] : [...t.rules].filter((k) => maps.rules.has(k));
    for (const id of ids) stringsIn(maps.nodes.get(id), strings);
    for (const k of keys) stringsIn(maps.rules.get(k), strings);
    if (t.all || t.meta) stringsIn(maps.meta, strings);

    const html = ids.map((id) => writeElement(maps, id)).join("");
    if (html) {
      const clean = sanitizeFragment(html, { images: "refuse" });
      const r = clean.removed;
      if (clean.problems.length || r.scripts || r.handlers || r.jsUrls) return "board_format";
    }
    const css = keys.map((k) => ruleCss(maps, k)).join("");
    if (css && checkCss(css).length) return "board_format";
    const base = maps.meta.get("baseCss");
    if ((t.all || t.meta) && typeof base === "string" && checkCss(base).length) return "board_format";
    if (ids.length || keys.length) {
      const out = writeBoard(maps);
      if (Buffer.byteLength(out.body) + Buffer.byteLength(out.css) > BOARD_MAX_BYTES) return "board_too_large";
    }
  }
  if (secretValues.length) {
    const all = strings.join("\n");
    if (secretValues.some((v) => v.length > 0 && all.includes(v))) return "secret_value";
  }
  return null;
}

/** The board list and the design's title (always small, always checked). */
function liveStringsOutsideBoards(doc: Y.Doc): string[] {
  const out: string[] = [];
  stringsIn(manifestOf(doc), out);
  stringsIn(doc.getMap(DESIGN_META), out);
  return out;
}

/**
 * Who builds each board, in the live document itself (a server-only map browsers may not change), so every replica
 * agrees: in Redis mode several replicas serve one design. A claim is `replica|socketId|time`; a replica tells its
 * page to build only when its claim is the one standing after the others had time to arrive (Yjs settles concurrent
 * writes the same way everywhere). A claim older than CLAIM_MS on a board still not built is abandoned (a replica
 * that died mid-build).
 */
export const BUILDERS = "wardby-builders";
const CLAIM_MS = 30_000;

interface Page {
  socketId: string;
  readOnly: boolean;
  send: (payload: string) => void;
}

export function boardsFormat(
  db: WebDeps["db"],
  opts: { replica: string; settleMs: number },
): LiveFormat & {
  message(
    documentId: string,
    doc: Y.Doc,
    from: { socketId: string; readOnly: boolean; send: (p: string) => void },
    payload: string,
  ): void;
  left(documentId: string, doc: Y.Doc, socketId: string): void;
} {
  const filesOf = async (documentId: string, v: LiveVersion): Promise<Record<string, string>> => {
    const row = await db.documentVersion.findUnique({
      where: { documentId_number: { documentId, number: v.number } },
      select: { id: true },
    });
    return row ? loadVersionFiles(db, row.id) : {};
  };
  /** Pages on this replica waiting for a board to be built, per document and board. */
  const waiting = new Map<string, Map<string, Page[]>>();
  const waitersOf = (documentId: string, board: string): Page[] => {
    let byBoard = waiting.get(documentId);
    if (!byBoard) waiting.set(documentId, (byBoard = new Map<string, Page[]>()));
    let list = byBoard.get(board);
    if (!list) byBoard.set(board, (list = []));
    return list;
  };
  const watched = new WeakSet<Y.Doc>();
  const tell = (send: (p: string) => void, board: string, role: "build" | "wait" | "join") =>
    send(JSON.stringify({ type: "board", board, role }));

  return {
    async seed(documentId, v) {
      if (v.format !== "boards-v1") return null;
      const files = await filesOf(documentId, v);
      const text = files[MANIFEST];
      if (typeof text !== "string") return null;
      const manifest = parseManifest(text);
      const doc = new Y.Doc();
      doc.transact(() => {
        doc.getMap(DESIGN_META).set("title", manifest.title);
        for (const b of manifest.boards) {
          const m = new Y.Map<unknown>();
          for (const [k, val] of Object.entries(b)) m.set(k, val);
          manifestOf(doc).push([m]);
        }
      });
      return doc;
    },

    async versionText(documentId, v) {
      return filesText(await filesOf(documentId, v));
    },

    snapshot(doc, since) {
      let before: Record<string, string>;
      try {
        before = JSON.parse(since) as Record<string, string>;
      } catch {
        before = {};
      }
      const manifest = liveManifest(doc);
      const files: Record<string, string> = {};
      // Files that are not boards (brand.md) carry over as they are.
      const boardFiles = new Set(Object.keys(before).filter((p) => p.startsWith("boards/")));
      for (const [p, text] of Object.entries(before)) if (p !== MANIFEST && !boardFiles.has(p)) files[p] = text;
      const listed: Manifest["boards"] = [];
      for (const b of manifest.boards) {
        if (isBuilt(doc, b.id)) files[b.file] = writeBoardFile(boardMaps(doc, b.id));
        else if (typeof before[b.file] === "string") files[b.file] = before[b.file];
        else continue; // a board nobody has built yet has no file: it is not saved until it has one.
        listed.push(b);
      }
      files[MANIFEST] = serializeManifest({ title: manifest.title, boards: listed });
      // Stored versions are in the board sanitizer's form (publishVersion normalises every file): compare in that
      // form too, or every checkpoint would see a difference (<br/> against <br>) and save again with no edit.
      const normal = normalizeDesign(files).files;
      const text = filesText(normal);
      return text === since ? null : { content: { files: normal }, text };
    },

    /**
     * A version published while people edit (an agent, MCP, a page's fallback save) is merged into the live copies
     * board by board, as changes by element from the version it was based on (core/documents/boards/live/merge.ts).
     * The changes are worked out once and applied twice: to a copy of the live document as it is now, so they land
     * after everyone's edits (a text box someone changed meanwhile merges word by word, never by whoever wrote last),
     * and to the base state, which then writes the new version (the next merge's base). A board nobody has opened
     * takes the new file as it is; the board list takes the new version's changes, keeping boards added meanwhile.
     */
    async merge(documentId, base, v, live) {
      if (v.format !== "boards-v1") return "reset";
      const next = await filesOf(documentId, v);
      const before = await filesOf(documentId, { ...v, number: v.baseNumber ?? v.number - 1 });
      if (typeof next[MANIFEST] !== "string") return "reset";
      const nextManifest = parseManifest(next[MANIFEST]);
      const beforeManifest = typeof before[MANIFEST] === "string" ? parseManifest(before[MANIFEST]) : null;
      const scratch = new Y.Doc();
      Y.applyUpdate(scratch, base);
      const now = new Y.Doc();
      Y.applyUpdate(now, Y.encodeStateAsUpdate(live));
      const vector = Y.encodeStateVector(now);
      // New elements get the same ids in both copies: made once, then replayed.
      const taken = new Set<string>();
      const made: string[] = [];
      const newId = () => {
        for (;;) {
          const id = `i${Math.random().toString(36).slice(2, 8)}`;
          if (taken.has(id)) continue;
          taken.add(id);
          made.push(id);
          return id;
        }
      };
      const replay = () => {
        let i = 0;
        return () => made[i++] ?? newId();
      };
      try {
        const plans: { board: string; ops: MergeOp[] }[] = [];
        for (const b of nextManifest.boards) {
          if (typeof next[b.file] !== "string" || before[b.file] === next[b.file]) continue;
          // The board's live copy at the base, or (built since by someone who opened it) now.
          const atBase = isBuilt(scratch, b.id);
          if (!atBase && !isBuilt(now, b.id)) continue;
          const maps = boardMaps(atBase ? scratch : now, b.id);
          for (const doc of [scratch, now]) {
            if (isBuilt(doc, b.id)) for (const id of boardMaps(doc, b.id).nodes.keys()) taken.add(id);
          }
          plans.push({ board: b.id, ops: boardOps(maps, before[b.file], next[b.file]) });
        }
        const apply = (doc: Y.Doc, ids: () => string) =>
          doc.transact(() => {
            if (beforeManifest === null || before[MANIFEST] !== next[MANIFEST]) {
              setLiveManifest(doc, mergeManifest(beforeManifest, nextManifest, liveManifest(doc)));
            }
            for (const p of plans) if (isBuilt(doc, p.board)) applyBoardMerge(boardMaps(doc, p.board), p.ops, ids);
          }, SERVER_ORIGIN);
        apply(now, newId);
        apply(scratch, replay());
      } catch {
        return "reset";
      }
      return {
        update: Y.encodeStateAsUpdate(now, vector),
        versionState: Y.encodeStateAsUpdate(scratch),
        text: filesText(next),
      };
    },

    refuse(scratch, apply, secretValues) {
      // Who builds which board is the server's: a page that changes it is refused.
      const claims = JSON.stringify(scratch.getMap(BUILDERS).toJSON());
      const touched = watchEdit(scratch, apply);
      if (JSON.stringify(scratch.getMap(BUILDERS).toJSON()) !== claims) return "server_data";
      return checkEdit(scratch, touched, secretValues);
    },

    async refreshAnchors() {
      // Pins follow live element ids (part 4).
    },

    message(documentId, doc, from, payload) {
      let msg: { type?: unknown; board?: unknown };
      try {
        msg = JSON.parse(payload) as typeof msg;
      } catch {
        return;
      }
      if (msg.type !== "open-board" || typeof msg.board !== "string") return;
      watch(documentId, doc);
      open(documentId, doc, msg.board, from);
    },

    left(documentId, doc, socketId) {
      const byBoard = waiting.get(documentId);
      if (byBoard)
        for (const [board, list] of byBoard)
          byBoard.set(
            board,
            list.filter((p) => p.socketId !== socketId),
          );
      const claims = doc.getMap<string>(BUILDERS);
      const mine = `${opts.replica}|${socketId}|`;
      const gone = [...claims.entries()].filter(([board, c]) => c.startsWith(mine) && !isBuilt(doc, board));
      // The builder left before building: its claim goes, and waiting pages (on any replica) ask again.
      if (gone.length) doc.transact(() => gone.forEach(([board]) => claims.delete(board)), SERVER_ORIGIN);
    },
  };

  /** A page opens a board: join it, or claim building it, or wait for whoever does. */
  function open(documentId: string, doc: Y.Doc, board: string, page: Page): void {
    if (isBuilt(doc, board)) return tell(page.send, board, "join");
    const list = waitersOf(documentId, board);
    const wait = () => {
      if (!list.some((p) => p.socketId === page.socketId)) list.push(page);
      tell(page.send, board, "wait");
    };
    // A read-only page never builds (its edits are not taken): it waits for someone who can.
    if (page.readOnly) return wait();
    const claims = doc.getMap<string>(BUILDERS);
    const standing = claims.get(board);
    const mine = `${opts.replica}|${page.socketId}|`;
    if (standing && !standing.startsWith(mine) && Date.now() - Number(standing.split("|")[2] ?? 0) < CLAIM_MS)
      return wait();
    const claim = `${mine}${Date.now()}`;
    doc.transact(() => claims.set(board, claim), SERVER_ORIGIN);
    const decide = () => {
      if (isBuilt(doc, board)) return tell(page.send, board, "join");
      if (claims.get(board) === claim) return tell(page.send, board, "build");
      wait();
    };
    if (opts.settleMs > 0) setTimeout(decide, opts.settleMs);
    else decide();
  }

  /** When a claim goes (its builder left, on any replica), this replica's waiting pages ask again. */
  function watch(documentId: string, doc: Y.Doc): void {
    if (watched.has(doc)) return;
    watched.add(doc);
    doc.getMap<string>(BUILDERS).observe((e) => {
      for (const [board, change] of e.changes.keys) {
        if (change.action !== "delete" || isBuilt(doc, board)) continue;
        const list = waitersOf(documentId, board);
        const next = list.find((p) => !p.readOnly);
        if (!next) continue;
        list.splice(list.indexOf(next), 1);
        open(documentId, doc, board, next);
      }
    });
  }
}
