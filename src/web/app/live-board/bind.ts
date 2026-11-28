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
import { merge3 } from "../../../core/documents/boards/live/merge3.js";
import {
  applyTextDiff,
  BOARD_ROOT,
  boardMaps,
  F,
  htmlOf,
  orderedPairs,
  R,
  setHtml,
  type BoardMaps,
} from "../../../core/documents/boards/live/model.js";
import {
  attrsOf,
  classesOf,
  isTextBox,
  readBoard,
  RULE_KEY,
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
  /** The live id of the element a canvas DOM element shows (for a comment pin), or null. */
  idOfElement(el: Element): string | null;
  /** Sends this page's unsent changes now (before the canvas is given to another board). */
  flush(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  destroy(): void;
}

/** A board's Undo history: this page's changes only (origin LOCAL). */
export const boardUndo = (maps: BoardMaps): Y.UndoManager =>
  new Y.UndoManager([maps.nodes, maps.rules, maps.ruleOrder], { trackedOrigins: new Set([LOCAL]) });

export function bindBoard(
  editor: Editor,
  maps: BoardMaps,
  opts: {
    build: boolean;
    baseCss?: string;
    parts?: ReadOptions["parts"];
    /**
     * The board's Undo history from an earlier binding (made by `boardUndo`), so Undo still reaches what this page
     * changed before the board was switched away and back. The caller owns it: `destroy` leaves it running.
     */
    undo?: Y.UndoManager;
  },
): BoardBinding {
  const { nodes, rules, ruleOrder, meta } = maps;
  const stats = { out: 0, in: 0, fullBuilds: 0, resent: 0, created: 0, remote: 0 };
  let applying = false;
  let editing: { id: string; el: HTMLElement } | null = null;
  /**
   * A box just closed: GrapesJS copies its text into its model a moment later, and until then the model holds the
   * text from before it opened. The box is held (not read, not changed) until the model has caught up.
   */
  let closing: { id: string; el: HTMLElement; until: number } | null = null;
  /**
   * The box being typed in, mirrored in a private copy of the live document taken when it opened. The copy's text
   * is exactly what this page shows (others' typing in the box arrives when it closes), so each change is applied to
   * it where the typing happened and goes out as character changes, which the shared text merges with anyone else's
   * typing in the same box: both keep every character.
   */
  let shadow: { id: string; doc: Y.Doc; text: Y.Text; last: string } | null = null;
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
  // Once destroyed, nothing queued earlier may run: the canvas may already show another board (a board switch
  // replaces it before the page drops this binding), and writing it here would put that board into this one.
  let destroyed = false;
  const sync = () => {
    if (applying || destroyed) return;
    if (closing) {
      const c = index.get(closing.id) ?? (reindex(), index.get(closing.id));
      if (!c || c.getInnerHTML() === closing.el.innerHTML || Date.now() > closing.until) closing = null;
    }
    const held = editing ?? closing;
    stats.out += readBoard(editor, maps, { since, editing: held, origin: LOCAL, created, structureOrigin: STRUCTURE });
    if (editing && shadow?.id === editing.id) pushShadow(editing.el.innerHTML);
    stats.created = created.size;
    since = snapshotBoard(editor, held);
  };
  let queued = false;
  const schedule = () => {
    if (applying || queued || destroyed) return;
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
    const html = htmlOf(n);
    if (html !== undefined) return { ...base, components: html };
    return { ...base, components: childrenIn(n).map(defOf) };
  };
  /** A rule's GrapesJS definition from the live copy, carrying its live key. */
  const ruleDef = (key: string, y: Y.Map<unknown>): Record<string, unknown> => ({
    ...(JSON.parse(str(y.get(R.def), "{}")) as Record<string, unknown>),
    [RULE_KEY]: key,
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
    // The text box being typed in is left entirely as it is until it closes (then it is caught up): changing its
    // attributes or classes now would make GrapesJS redraw it and put the caret back at its start, so the rest of
    // the typing would land in the wrong place. While open it also carries contenteditable, which the live copy
    // never has.
    if (editing?.id === id || closing?.id === id) return;
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
    const html = htmlOf(n);
    if (html !== undefined) {
      const want = html;
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
        [r] = all.add([ruleDef(order[i], y)], { at: i }) as unknown as CssRule[];
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
    if (destroyed) return;
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
    since = snapshotBoard(editor, editing ?? closing);
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
        [...new Set(ruleOrder.toArray())].filter((k) => rules.has(k)).map((k) => ruleDef(k, rules.get(k)!)),
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

  // An element this page adds (a duplicate, a paste) must have an id no other element has: GrapesJS checks a copy's
  // id against this page's ids only when it is added, and a copy of a copy can keep its original's id. Two elements
  // with one id would be one element in the live copy, and the other would vanish. A clashing one gets a fresh id.
  const onAdd = (added: Component) => {
    if (applying || destroyed) return;
    const root = editor.getWrapper();
    if (!root) return;
    const count = new Map<string, number>();
    const walk = (k: Component) => {
      count.set(k.getId(), (count.get(k.getId()) ?? 0) + 1);
      k.components().forEach(walk);
    };
    walk(root);
    const fix = (k: Component) => {
      const old = k.getId();
      if ((count.get(old) ?? 0) > 1) {
        count.set(old, (count.get(old) ?? 1) - 1);
        const fresh = `i${Math.random().toString(36).slice(2, 10)}`;
        // Renamed without GrapesJS's id update: that renames the "#old" selector, which the original element shares
        // with the copy's rules, so the original's style would move to the copy. The registry is updated here instead.
        k.setId(fresh, { idUpdate: true });
        (k as unknown as { ccid: string }).ccid = fresh;
        (editor.Components as unknown as { allById(): Record<string, Component> }).allById()[fresh] = k;
        // GrapesJS copied the original's own rules for the copy, under the same "#old" selector: they become the copy's.
        const own = editor.Css.getRules(`#${old}`);
        for (const r of own.slice(own.length / 2)) {
          r.set("selectors", [`#${fresh}`] as never);
          r.unset(RULE_KEY);
        }
      }
      k.components().forEach(fix);
    };
    fix(added);
  };
  editor.on("component:add", onAdd);

  // Typing streams out while a text box is open; its final text goes out when it closes (GrapesJS updates its own
  // model a moment later, and until then the model holds the text from before the box opened).
  const onInput = () => schedule();
  /** This board's key in the live document (its maps are found again in the private copy by it). */
  const boardKey = (): string | undefined => {
    for (const [key, b] of nodes.doc!.getMap<unknown>("boards"))
      if (b instanceof Y.Map && b.get("nodes") === nodes) return key;
    return undefined;
  };
  const startShadow = (id: string, el: HTMLElement) => {
    shadow = null;
    const n = nodes.get(id);
    const key = boardKey();
    if (!n || !key) return;
    // A box saved as a plain string becomes shared text first (not an edit anyone undoes).
    if (!(n.get(F.html) instanceof Y.Text)) nodes.doc!.transact(() => setHtml(n, htmlOf(n) ?? ""), STRUCTURE);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(nodes.doc!));
    const text = boardMaps(doc, key).nodes.get(id)?.get(F.html);
    if (!(text instanceof Y.Text)) return;
    // The baseline is the box as this page shows it, which can be a moment behind the live copy (someone's newest
    // words not drawn here yet): opening sends nothing, and each change is taken from it (pushShadow).
    shadow = { id, doc, text, last: el.innerHTML };
  };
  /** The box's text now: the person's change since the last send is applied to the copy and sent as character changes. */
  const pushShadow = (page: string) => {
    if (!shadow || destroyed || page === shadow.last) return;
    const vector = Y.encodeStateVector(shadow.doc);
    // What the person changed since the last send, applied to the box's text in the copy (which also has the newer
    // words this page had not shown when the box opened): never the whole box as this page shows it.
    const current = shadow.text.toJSON();
    applyTextDiff(shadow.text, current === shadow.last ? page : merge3(shadow.last, current, page));
    Y.applyUpdate(nodes.doc!, Y.encodeStateAsUpdate(shadow.doc, vector), LOCAL);
    shadow.last = page;
    stats.out++;
  };
  const onEnable = (view: { el: HTMLElement; model: Component }) => {
    closing = null;
    editing = { id: view.model.getId(), el: view.el };
    startShadow(editing.id, view.el);
    view.el.addEventListener("input", onInput);
  };
  const onDisable = (view: { el: HTMLElement }) => {
    view.el.removeEventListener("input", onInput);
    sync();
    if (editing) closing = { ...editing, until: Date.now() + 1500 };
    editing = null;
    shadow = null;
    schedule();
    // Whatever arrived for this box while it was open is applied once GrapesJS has caught up (ours already went out).
    const catchUp = () => {
      if (destroyed) return;
      if (closing) {
        sync();
        if (closing) return void setTimeout(catchUp, 60);
      }
      applyIn();
    };
    setTimeout(catchUp, 60);
  };
  editor.on("rte:enable", onEnable);
  editor.on("rte:disable", onDisable);

  // Undo: this page's changes only (Bo's are not undone by your Undo); undoing reaches GrapesJS like any remote change.
  const undoManager = opts.undo ?? boardUndo(maps);
  // Building the board is not something to undo; an edit after a re-bind never merges with one from before it.
  if (opts.build) undoManager.clear();
  undoManager.stopCapturing();

  return {
    stats,
    editingId: () => editing?.id ?? null,
    componentById: (id) => {
      reindex();
      return index.get(id);
    },
    idOfElement: (el) => {
      reindex();
      for (const [id, c] of index) if (c.getEl() === el) return id;
      return null;
    },
    undo: () => void undoManager.undo(),
    redo: () => void undoManager.redo(),
    canUndo: () => undoManager.canUndo(),
    canRedo: () => undoManager.canRedo(),
    flush: () => sync(),
    destroy() {
      destroyed = true;
      if (editing) editing.el.removeEventListener("input", onInput);
      nodes.unobserveDeep(onRemote);
      rules.unobserveDeep(onRemote);
      ruleOrder.unobserve(onRemote);
      meta.unobserve(onRemote);
      editor.off(events, schedule);
      editor.off("component:add", onAdd);
      editor.off("rte:enable", onEnable);
      editor.off("rte:disable", onDisable);
      if (!opts.undo) undoManager.destroy();
    },
  };
}
