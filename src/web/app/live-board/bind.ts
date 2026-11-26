/**
 * The connector (spec "The connector"): keeps one board in GrapesJS and its live copy in step, element by element.
 *
 * - Ours out: after any editor change, in the same task (so a remote change can never land on an unsent local one),
 *   readBoard writes what changed in GrapesJS since the last snapshot; GrapesJS events it might not hear about are
 *   caught too, because the snapshot (not the event) says what changed.
 * - Theirs in: before applying anyone else's change, ours goes out (safe: only what changed here is written); then
 *   GrapesJS is reconciled to the live copy top-down by element id, never setComponents after the first build, so
 *   nothing else on the board re-renders. A text box being typed in keeps its text until it closes.
 * - Undo: Yjs undo of this page's changes only (your Undo never removes Bo's change).
 * - A builder writes the board it loaded from the file; a joiner builds its canvas from the live copy once (GrapesJS
 *   gives elements new random ids on every parse, so a joiner must not keep its own).
 */
import type { Component, CssRule, Editor } from "grapesjs";
import * as Y from "yjs";
import { BOARD_ROOT, F, orderedPairs, R, type BoardMaps } from "../../../core/documents/boards/live/model.js";
import {
  attrsOf,
  classesOf,
  isTextBox,
  readBoard,
  rulesInOrder,
  snapshotBoard,
  styleOf,
  type ReadOptions,
  type Snapshot,
} from "./read.js";

/** The connector's transaction origin: its own changes, which it never applies back to GrapesJS. */
export const LOCAL = "wardby-page";
/** Its own structural writes (a new rule's map and place in the order): never applied back, never undone. */
export const STRUCTURE = "wardby-page-structure";

type AttrValue = string | boolean;
/** A live-copy field as text (anything else as the fallback). */
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

export interface BoardBinding {
  /** Elements and rules changed each way, and full builds (1 for a joiner, 0 for a builder). */
  stats: { out: number; in: number; fullBuilds: number; resent: number; created: number; remote: number };
  /** The text box being typed in, if any. */
  editingId(): string | null;
  componentById(id: string): Component | undefined;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  destroy(): void;
}

export function bindBoard(
  editor: Editor,
  maps: BoardMaps,
  opts: { build: boolean; baseCss?: string; parts?: ReadOptions["parts"] },
): BoardBinding {
  const { nodes, rules, ruleOrder, meta } = maps;
  const stats = { out: 0, in: 0, fullBuilds: 0, resent: 0, created: 0, remote: 0 };
  let applying = false;
  let editing: { id: string; el: HTMLElement } | null = null;
  let since: Snapshot = new Map();
  const index = new Map<string, Component>();

  const reindex = () => {
    index.clear();
    const root = editor.getWrapper();
    if (!root) return;
    const walk = (c: Component) => {
      index.set(c.getId(), c);
      if (!isTextBox(c)) c.components().forEach(walk);
    };
    root.components().forEach(walk);
  };

  const baseStyle = () =>
    editor.Canvas.getDocument()?.querySelector<HTMLStyleElement>("style[data-wardby-base]") ?? null;

  // ---------- ours out ----------
  /**
   * Rules this page created. Two pages giving one element its first style at once each create its rule, and Yjs keeps
   * one of the two: the page whose rule lost sends its properties again, into the rule that stands.
   */
  const created = new Map<string, Y.Map<unknown>>();
  const resendLostRules = () => {
    for (const [key, mine] of created) {
      const standing = rules.get(key);
      if (standing === mine) continue;
      created.delete(key);
      if (!standing) continue;
      stats.resent++;
      for (const k of [...since.keys()]) if (k.startsWith(`r|${key}|`) || k === `rp|${key}`) since.delete(k);
    }
  };
  const sync = () => {
    if (applying) return;
    stats.out += readBoard(editor, maps, { since, editing, origin: LOCAL, created, structureOrigin: STRUCTURE });
    stats.created = created.size;
    since = snapshotBoard(editor, editing);
  };
  let queued = false;
  const schedule = () => {
    if (applying || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sync();
    });
  };

  // ---------- theirs in ----------
  const attrsIn = (n: Y.Map<unknown>) =>
    Object.fromEntries(orderedPairs(n.get(F.attrs) as Y.Map<AttrValue>, n.get(F.attrKeys) as Y.Array<string>));
  const childrenIn = (n: Y.Map<unknown> | undefined) =>
    ((n?.get(F.children) as Y.Array<string> | undefined)?.toArray() ?? []).filter((k) => nodes.has(k));
  const defOf = (id: string): Record<string, unknown> => {
    const n = nodes.get(id);
    if (!n) return { type: "textnode", content: "" };
    if (n.get(F.type) === "textnode") return { type: "textnode", content: n.get(F.content) ?? "" };
    const classes = str(n.get(F.classes)).split(" ").filter(Boolean);
    // A made-up id goes in as the element's id only, never as an attribute (it would be saved in the HTML).
    const base: Record<string, unknown> = {
      type: n.get(F.type),
      tagName: n.get(F.tag),
      attributes: attrsIn(n),
      classes,
    };
    if (!n.get(F.ownId)) base.id = id;
    if (typeof n.get(F.html) === "string") return { ...base, components: n.get(F.html) };
    return { ...base, components: childrenIn(n).map(defOf) };
  };
  const ruleDef = (y: Y.Map<unknown>): Record<string, unknown> => ({
    ...(JSON.parse(str(y.get(R.def), "{}")) as Record<string, unknown>),
    style: Object.fromEntries(orderedPairs(y.get(R.style) as Y.Map<string>, y.get(R.props) as Y.Array<string>)),
  });

  const reconcile = (c: Component, id: string) => {
    const n = nodes.get(id);
    if (!n) return;
    if (c.is("textnode")) {
      const want = str(n.get(F.content));
      if (c.get("content") !== want) {
        c.set("content", want);
        (c.view as { render?(): void } | undefined)?.render?.();
        stats.in++;
      }
      return;
    }
    if (id !== BOARD_ROOT) {
      const want = attrsIn(n);
      const have = Object.fromEntries(attrsOf(c));
      if (JSON.stringify(want) !== JSON.stringify(have)) {
        const drop = Object.keys(have).filter((k) => !(k in want));
        if (drop.length) c.removeAttributes(drop);
        c.addAttributes(want);
        stats.in++;
      }
      const cls = str(n.get(F.classes));
      if (classesOf(c) !== cls) {
        c.setClass(cls.split(" ").filter(Boolean));
        stats.in++;
      }
    }
    if (typeof n.get(F.html) === "string") {
      // Plan A: the person typing in this box keeps it until they finish; their version then goes out.
      if (editing?.id === id) return;
      const want = n.get(F.html) as string;
      if (c.getInnerHTML() !== want) {
        c.components(want);
        stats.in++;
      }
      return;
    }
    const want = childrenIn(n);
    const coll = c.components();
    for (let i = 0; i < want.length; i++) {
      if (coll.at(i)?.getId() === want[i]) continue;
      const existing = index.get(want[i]);
      if (existing) {
        existing.remove({ temporary: true });
        coll.add(existing, { at: i });
      } else {
        coll.add(defOf(want[i]), { at: i });
        reindex();
      }
      stats.in++;
    }
    while (coll.length > want.length) {
      coll.at(want.length)?.remove();
      stats.in++;
    }
    coll.forEach((k: Component) => reconcile(k, k.getId()));
  };

  const reconcileRules = () => {
    const all = editor.Css.getAll();
    const live = new Map(rulesInOrder(editor));
    for (const [key, r] of live) {
      if (!rules.has(key)) {
        all.remove(r);
        stats.in++;
      }
    }
    // Two pages may add the same rule at once: its key then appears twice in the order; the first counts.
    const order = [...new Set(ruleOrder.toArray())].filter((k) => rules.has(k));
    for (let i = 0; i < order.length; i++) {
      const y = rules.get(order[i])!;
      let r = live.get(order[i]);
      if (!r) {
        [r] = all.add([ruleDef(y)], { at: i }) as unknown as CssRule[];
        stats.in++;
      } else if (all.indexOf(r) !== i) {
        all.remove(r, { silent: true });
        all.add(r, { at: i, silent: true });
        stats.in++;
      }
      const want = orderedPairs(y.get(R.style) as Y.Map<string>, y.get(R.props) as Y.Array<string>);
      if (JSON.stringify(styleOf(r)) !== JSON.stringify(want)) {
        r.setStyle(Object.fromEntries(want));
        stats.in++;
      }
    }
  };

  const applyBase = () => {
    const st = baseStyle();
    const want = meta.get("baseCss");
    if (st && typeof want === "string" && st.textContent !== want) st.textContent = want;
  };

  const applyIn = () => {
    const root = editor.getWrapper();
    if (!root) return;
    applying = true;
    const um = editor.UndoManager;
    um.stop();
    try {
      reindex();
      reconcile(root, BOARD_ROOT);
      reconcileRules();
      applyBase();
    } finally {
      um.start();
      applying = false;
    }
    since = snapshotBoard(editor, editing);
  };

  /** A joiner builds its canvas from the live copy once. */
  const buildFromLiveCopy = () => {
    applying = true;
    const um = editor.UndoManager;
    um.stop();
    try {
      editor.setComponents(childrenIn(nodes.get(BOARD_ROOT)).map(defOf));
      editor.Css.getAll().reset();
      editor.Css.getAll().add(
        [...new Set(ruleOrder.toArray())].filter((k) => rules.has(k)).map((k) => ruleDef(rules.get(k)!)),
      );
      applyBase();
      stats.fullBuilds++;
    } finally {
      um.start();
      um.clear();
      applying = false;
    }
    reindex();
  };

  if (opts.build) {
    stats.out += readBoard(editor, maps, { baseCss: opts.baseCss, parts: opts.parts, origin: LOCAL });
    since = snapshotBoard(editor);
  } else {
    buildFromLiveCopy();
    since = snapshotBoard(editor);
  }

  const onRemote = (_e: unknown, tr: Y.Transaction) => {
    if (tr.origin === LOCAL || tr.origin === STRUCTURE) return;
    stats.remote++;
    // Ours first (only what changed here since the last snapshot, plus anything a lost rule race dropped), then theirs.
    resendLostRules();
    if (!applying) sync();
    applyIn();
  };
  nodes.observeDeep(onRemote);
  rules.observeDeep(onRemote);
  ruleOrder.observe(onRemote);
  meta.observe(onRemote);

  // The specific events too: some changes (classes) reach the generic "update" only a task later.
  const events =
    "update component:update component:add component:remove component:styleUpdate rule:update styleable:change " +
    "component:update:classes component:update:attributes component:update:components component:update:content";
  editor.on(events, schedule);

  // Typing streams out while a text box is open; its final text goes out when it closes (GrapesJS updates its own
  // model a moment later, and until then the model holds the text from before the box opened).
  const onInput = () => schedule();
  const onEnable = (view: { el: HTMLElement; model: Component }) => {
    editing = { id: view.model.getId(), el: view.el };
    view.el.addEventListener("input", onInput);
  };
  const onDisable = (view: { el: HTMLElement }) => {
    view.el.removeEventListener("input", onInput);
    sync();
    editing = null;
    schedule();
    // Whatever arrived for this box while it was open is applied now (ours already went out).
    setTimeout(applyIn, 60);
  };
  editor.on("rte:enable", onEnable);
  editor.on("rte:disable", onDisable);

  // Undo: this page's changes only (Bo's are not undone by your Undo); undoing reaches GrapesJS like any remote change.
  const undoManager = new Y.UndoManager([nodes, rules, ruleOrder], { trackedOrigins: new Set([LOCAL]) });

  return {
    stats,
    editingId: () => editing?.id ?? null,
    componentById: (id) => {
      reindex();
      return index.get(id);
    },
    undo: () => void undoManager.undo(),
    redo: () => void undoManager.redo(),
    canUndo: () => undoManager.canUndo(),
    canRedo: () => undoManager.canRedo(),
    destroy() {
      nodes.unobserveDeep(onRemote);
      rules.unobserveDeep(onRemote);
      ruleOrder.unobserve(onRemote);
      meta.unobserve(onRemote);
      editor.off(events, schedule);
      editor.off("rte:enable", onEnable);
      editor.off("rte:disable", onDisable);
      undoManager.destroy();
    },
  };
}
