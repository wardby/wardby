/**
 * A design's live editing on the page (spec "Live editing for designs"): which board this page is on, whether it
 * builds a board's live copy or reads it (the server decides: formats/boards.ts), the connector for the board in the
 * canvas, the board list kept in step with everyone's, and presence (who is on which board and what they selected).
 */
import type { Component } from "grapesjs";
import * as Y from "yjs";
import { BOARD_ROOT, boardMaps, manifestOf } from "../../../core/documents/boards/live/model.js";
import type { Manifest } from "../board-file.js";
import type { BoardsEditor } from "../boards-editor.js";
import type { LiveJoin } from "../live-join.js";
import { bindBoard, boardUndo, LOCAL, type BoardBinding } from "./bind.js";

export interface Peer {
  name: string;
  color: string;
  board: string | null;
  /** The element they have selected, or are typing in. */
  element: string | null;
  typing: boolean;
}

export interface DesignSession {
  /** The page put board `id` in the canvas: build it, wait for it or read it, then keep it in step. */
  boardShown(id: string): void;
  /** This page changed the board list (added, renamed, moved, deleted): everyone gets it. */
  pushManifest(): void;
  /** A message from the server (the board roles); live-join.ts hands them over. */
  message(msg: Record<string, unknown>): void;
  undo(): void;
  redo(): void;
  /** Whether a board has a live copy (its file then comes from the live copy, never from a version). */
  isBuilt(id: string): boolean;
  /** Other people on this design. */
  peers(): Peer[];
  /** Called when someone else's presence or the board list changes. */
  onChange(cb: () => void): void;
  /** The element a peer has selected, in this page's canvas (for drawing their outline). */
  elementOf(id: string): Component | undefined;
  /** The live id of a canvas element (a comment pin remembers it). */
  idOfElement(el: Element): string | null;
  destroy(): void;
}

/** A live-document field as text (anything else as the fallback). */
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Whether a board has a live copy yet (read only: boardMaps would create its maps). */
function built(doc: Y.Doc, board: string): boolean {
  const b = doc.getMap<unknown>("boards").get(board);
  const nodes: unknown = b instanceof Y.Map ? (b as Y.Map<unknown>).get("nodes") : undefined;
  return nodes instanceof Y.Map && (nodes as Y.Map<unknown>).has(BOARD_ROOT);
}

export function startDesignSession(o: {
  join: LiveJoin;
  boards: BoardsEditor;
  editable: () => boolean;
  /**
   * Before building a board: bring the page's copy of boards nobody has built up to the newest version (an agent
   * may have changed one since this page loaded), so the live copy starts from it.
   */
  beforeBuild?: () => Promise<void>;
}): DesignSession {
  const { ydoc, provider } = o.join;
  const { boards } = o;
  const editor = boards.editor;
  let binding: BoardBinding | null = null;
  let shown: string | null = null;
  let waiting: (() => void) | null = null;
  const listeners: (() => void)[] = [];
  const notify = () => listeners.forEach((cb) => cb());

  /**
   * Whether this page locked the canvas while a board had no live copy yet: what is typed before the connector is
   * attached never goes out (and the canvas is rebuilt from the live copy when it arrives), so nothing is editable
   * until then.
   */
  let lockedForWait = false;
  const lockWhileWaiting = () => {
    if (lockedForWait || !o.editable()) return;
    lockedForWait = true;
    void boards.setEditable(false);
  };
  const unlockAfterWait = () => {
    if (!lockedForWait) return;
    lockedForWait = false;
    if (o.editable()) void boards.setEditable(true);
  };

  /**
   * Each board's Undo history, kept across bindings: switching to another board and back (or the server re-sending
   * a board) makes a new binding, and Undo must still reach what this page changed before.
   */
  const histories = new Map<string, { nodes: unknown; undo: Y.UndoManager }>();
  const historyOf = (id: string, maps: ReturnType<typeof boardMaps>) => {
    const kept = histories.get(id);
    // Two pages creating a board at once can leave its maps replaced: a history of the old ones undoes nothing.
    if (kept && kept.nodes === maps.nodes) return kept.undo;
    kept?.undo.destroy();
    const undo = boardUndo(maps);
    histories.set(id, { nodes: maps.nodes, undo });
    return undo;
  };

  const bind = (id: string, build: boolean) => {
    if (shown !== id) return;
    binding?.destroy();
    unlockAfterWait();
    const parts = boards.parts(id);
    const maps = boardMaps(ydoc, id);
    binding = bindBoard(editor, maps, {
      build,
      baseCss: parts?.baseCss,
      parts: parts ? { lang: parts.lang, title: parts.title, bodyAttrs: parts.bodyAttrs } : undefined,
      undo: historyOf(id, maps),
    });
  };

  /** Reads board `id` once someone has built it (the server told this page to wait). */
  const whenBuilt = (id: string) => {
    if (built(ydoc, id)) return bind(id, false);
    const boardsMap = ydoc.getMap<unknown>("boards");
    const check = () => {
      if (!built(ydoc, id)) return;
      boardsMap.unobserveDeep(check);
      waiting = null;
      bind(id, false);
    };
    waiting?.();
    waiting = () => boardsMap.unobserveDeep(check);
    boardsMap.observeDeep(check);
  };

  // A board switch: what this page changed on the board leaving goes out while that board is still in the canvas,
  // and its binding stops before the canvas changes (the next board binds once it is shown).
  boards.beforeBoard(() => {
    waiting?.();
    waiting = null;
    binding?.flush();
    binding?.destroy();
    binding = null;
  });

  // ---- the board list ----
  const liveManifest = (): Manifest => {
    const list = manifestOf(ydoc)
      .toArray()
      .map((m) => ({
        id: str(m.get("id")),
        name: str(m.get("name")),
        file: str(m.get("file")),
        width: Number(m.get("width") ?? 1280),
      }))
      .filter((b) => b.id && b.file);
    return { title: boards.manifest().title, boards: list };
  };
  const sameList = (a: Manifest, b: Manifest) => JSON.stringify(a.boards) === JSON.stringify(b.boards);
  const onManifest = (_e: unknown, tr: Y.Transaction) => {
    if (tr.origin === LOCAL) return;
    const next = liveManifest();
    if (next.boards.length && !sameList(next, boards.manifest())) boards.applyManifest(next);
    notify();
  };
  manifestOf(ydoc).observeDeep(onManifest);

  // ---- presence ----
  const setPresence = () => {
    const sel = editor.getSelected();
    const typing = binding?.editingId() ?? null;
    provider.setAwarenessField("board", shown);
    provider.setAwarenessField("element", typing ?? sel?.getId() ?? null);
    provider.setAwarenessField("typing", !!typing);
  };
  editor.on("component:toggled", setPresence);
  editor.on("rte:enable", () => setTimeout(setPresence, 0));
  editor.on("rte:disable", () => setTimeout(setPresence, 0));
  const onAwareness = () => notify();
  provider.awareness?.on("change", onAwareness);

  return {
    boardShown(id) {
      if (shown === id && binding) return;
      shown = id;
      waiting?.();
      waiting = null;
      binding?.destroy();
      binding = null;
      setPresence();
      if (built(ydoc, id)) return bind(id, false);
      // Not built yet: the server picks one page to build it (a read-only page never does); until this page is
      // told whether it builds or reads, the board is not editable here.
      lockWhileWaiting();
      provider.sendStateless(JSON.stringify({ type: "open-board", board: id }));
    },

    message(msg) {
      if (msg.type !== "board" || typeof msg.board !== "string" || msg.board !== shown) return;
      const board = msg.board;
      if (msg.role !== "build" || !o.editable()) return whenBuilt(board);
      void (o.beforeBuild ? o.beforeBuild().catch(() => undefined) : Promise.resolve()).then(() => bind(board, true));
    },

    pushManifest() {
      const next = boards.manifest();
      if (sameList(next, liveManifest())) return;
      ydoc.transact(() => {
        const arr = manifestOf(ydoc);
        arr.delete(0, arr.length);
        arr.push(
          next.boards.map((b) => {
            const m = new Y.Map<unknown>();
            for (const [k, v] of Object.entries(b)) m.set(k, v);
            return m;
          }),
        );
      }, LOCAL);
    },

    isBuilt: (id) => built(ydoc, id),
    undo: () => binding?.undo(),
    redo: () => binding?.redo(),

    peers() {
      const out: Peer[] = [];
      const states = provider.awareness?.getStates() ?? new Map<number, Record<string, unknown>>();
      for (const [id, st] of states) {
        if (id === ydoc.clientID) continue;
        const user = st.user as { name?: unknown; color?: unknown } | undefined;
        if (!user || typeof user.name !== "string") continue;
        out.push({
          name: user.name,
          color: typeof user.color === "string" && /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : "#888888",
          board: typeof st.board === "string" ? st.board : null,
          element: typeof st.element === "string" ? st.element : null,
          typing: st.typing === true,
        });
      }
      return out;
    },

    onChange: (cb) => void listeners.push(cb),
    elementOf: (id) => binding?.componentById(id),
    idOfElement: (el) => binding?.idOfElement(el) ?? null,

    destroy() {
      waiting?.();
      binding?.destroy();
      for (const h of histories.values()) h.undo.destroy();
      histories.clear();
      manifestOf(ydoc).unobserveDeep(onManifest);
      provider.awareness?.off("change", onAwareness);
    },
  };
}
