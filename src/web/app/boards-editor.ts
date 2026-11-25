/**
 * The design editor: GrapesJS core with the PostCSS parser, its own panels off and its managers
 * rendered into Wardby's sidebars (spec "Designs: GrapesJS 0.23 with the PostCSS parser").
 *
 * One board is in the canvas at a time. GrapesJS 0.23.9 keeps every page's CSS in one shared rule
 * collection (each page's `styles` is added to `em.Css`), so boards loaded as pages would style each
 * other wherever they share a selector, and a board's saved CSS would carry the other boards' rules.
 * Switching boards therefore keeps the board being left as its serialised text and loads the next one
 * (components, styles and base layer) into the single page.
 *
 * Base layer (ruling D7): the board's CSS as written goes first in the canvas <head>, under the rules
 * GrapesJS imported, so whatever the editor failed to import still renders as written. Saving writes
 * that CSS back unchanged as <style data-wardby-base> and the editor's CSS as <style data-wardby-edits>.
 *
 * Safety: boards were sanitised when stored and are again on save (core/documents/boards/sanitize.ts);
 * GrapesJS's HTML parser drops scripts and on* attributes too, and the page CSP lets no script run in
 * the canvas. Nothing here loads from outside the origin (no icon CDN, no canvas scripts or styles).
 */
import grapesjs, {
  type Component,
  type ComponentProperties,
  type CssRuleJSON,
  type Editor,
  type SelectorProps,
} from "grapesjs";
import parserPostCSS from "grapesjs-parser-postcss";
import { BOARD_ID } from "../../core/documents/boards/ids.js";
import {
  boardIdFor,
  boardPath,
  newBoardFile,
  parseBoardFile,
  serializeBoardFile,
  serializeManifest,
  type BoardEntry,
  type BoardParts,
  type Manifest,
} from "./board-file.js";

export const DEVICES = [
  { id: "Desktop", name: "Desktop", width: "" },
  { id: "Tablet", name: "Tablet", width: "768px", widthMedia: "992px" },
  { id: "Phone", name: "Phone", width: "390px", widthMedia: "480px" },
];
export type DeviceId = "Desktop" | "Tablet" | "Phone";

const LOCKED = {
  draggable: false,
  droppable: false,
  editable: false,
  removable: false,
  copyable: false,
  stylable: false,
  resizable: false,
};
/** Right, bottom and corner handles only (spec "Resizing"). */
const RESIZE = {
  tl: false,
  tc: false,
  tr: false,
  cl: false,
  bl: false,
  cr: true,
  bc: true,
  br: true,
  keyWidth: "width",
  keyHeight: "min-height",
};

type LockFlags = Pick<ComponentProperties, keyof typeof LOCKED>;
/** Each locked element's own flags from before its lock, put back when the board is unlocked in place. */
const unlocked = new WeakMap<Component, LockFlags>();
// avoidStore: locking is not an edit (no editor "update", nothing to save).
const QUIET = { avoidStore: true };

function lockTree(c: Component): void {
  if (!unlocked.has(c)) {
    unlocked.set(c, Object.fromEntries(Object.keys(LOCKED).map((k) => [k, c.get(k as keyof typeof LOCKED)])));
  }
  c.set(LOCKED, QUIET);
  c.components().forEach(lockTree);
}

function unlockTree(c: Component): void {
  const flags = unlocked.get(c);
  if (flags) {
    c.set(flags, QUIET);
    unlocked.delete(c);
  }
  // GrapesJS builds an element's toolbar once; one selected while locked kept a trimmed copy (no move,
  // copy or delete), so it is built again. A toolbar change is not board content (nothing to save).
  c.unset("toolbar", { silent: true });
  c.initToolbar();
  c.components().forEach(unlockTree);
}

export interface Panels {
  layers: HTMLElement;
  styles: HTMLElement;
  selectors: HTMLElement;
  traits: HTMLElement;
}

export interface BoardsEditor {
  editor: Editor;
  /** Resolves once GrapesJS has loaded and the first board is in the canvas. */
  ready: Promise<void>;
  currentBoard(): string;
  selectBoard(id: string): void;
  /** Files that differ from the last saved version: board text, manifest.json, or null (deleted). */
  changedFiles(): Record<string, string | null>;
  /** The files just saved become the baseline. */
  markSaved(files: Record<string, string | null>): void;
  /** Whether there are unsaved changes (changed files, or text being typed in the canvas now). */
  dirty(): boolean;
  manifest(): Manifest;
  /**
   * Replaces everything with a newer version's files, keeping the selected board where it still exists.
   * Throws ManifestUnreadableError (nothing changed) when the manifest is not JSON.
   */
  load(files: Record<string, string>): void;
  addBoard(name: string): string;
  renameBoard(id: string, name: string): void;
  moveBoard(id: string, delta: number): void;
  deleteBoard(id: string): void;
  canvasDocument(): Document | null;
  canvasWindow(): Window | null;
  /** The canvas's <style data-wardby-base>, or null before the frame has loaded. */
  baseStyle(): HTMLStyleElement | null;
  /** The GrapesJS wrapper element: the root that element anchors are built and located against (PF-H5). */
  root(): HTMLElement | null;
  /**
   * The ids in the board in the canvas as last stored (its saved file, not the editor's state): only
   * these can be an element anchor's id, since an id GrapesJS added while editing is not in the file.
   */
  storedIds(): ReadonlySet<string>;
  /** Whether the editor edits (writers); commenters and readers get a locked board. */
  readonly editable: boolean;
  /**
   * Locks or unlocks the board in place, as if mounted that way (a review lock while the page is
   * open). Locking deselects and stops the keyboard shortcuts; unlocking gives each element its own
   * flags back. Neither is an edit: no change is reported and edits made before the lock stay as
   * they are (unsaved, if they were). Resolves once text being typed when it locked is back in the
   * board (dirty() then says whether anything is unsaved).
   */
  setEditable(on: boolean): Promise<void>;
  setDevice(id: DeviceId): void;
  /** Called when the content or the boards change (not debounced). */
  onChange(cb: () => void): void;
  /** Called after a board is put in the canvas (selection, a newer version, a board operation). */
  onBoard(cb: (id: string) => void): void;
}

interface BoardState {
  parts: BoardParts;
  /** The board's text while it is not in the canvas and differs from what was stored (or is new). */
  pending: string | null;
  /** What the board serialises to when unchanged: set when first loaded, moved forward on save. */
  baseline: string | null;
}

/** Thrown by createBoardsEditor and load() when the version's manifest.json is not JSON. */
export class ManifestUnreadableError extends Error {
  constructor() {
    super("manifest_unreadable");
    this.name = "ManifestUnreadableError";
  }
}

/** The files' manifest, read leniently (the server checked it when the version was stored). */
function readManifest(text: string | undefined): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? "{}");
  } catch {
    throw new ManifestUnreadableError();
  }
  const raw = (parsed && typeof parsed === "object" ? parsed : {}) as { title?: unknown; boards?: unknown };
  const boards = Array.isArray(raw.boards) ? (raw.boards as Partial<BoardEntry>[]) : [];
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    boards: boards
      .filter((b) => typeof b.id === "string" && BOARD_ID.test(b.id))
      .map((b) => ({
        id: b.id!,
        name: typeof b.name === "string" ? b.name : b.id!,
        file: boardPath(b.id!),
        width: typeof b.width === "number" ? b.width : 1280,
      })),
  };
}

export function createBoardsEditor(opts: {
  container: HTMLElement;
  panels: Panels;
  files: Record<string, string>;
  editable: boolean;
}): BoardsEditor {
  // Read first: an unreadable manifest throws before GrapesJS is mounted.
  let manifest = readManifest(opts.files["manifest.json"]);
  const editor = grapesjs.init({
    container: opts.container,
    height: "100%",
    width: "auto",
    storageManager: false,
    // GrapesJS sends usage data to app.grapesjs.com by default: never (the CSP would block it anyway).
    telemetry: false,
    // No external icon stylesheet (CSP, and nothing from a CDN at runtime).
    cssIcons: "",
    // No editor CSS inside the canvas: boards render as written (fidelity).
    protectedCss: "",
    canvas: { frameStyle: "", scripts: [], styles: [] },
    parser: { optionsHtml: { allowScripts: false, allowUnsafeAttr: false, allowUnsafeAttrValue: false } },
    plugins: [parserPostCSS],
    panels: { defaults: [] },
    layerManager: { appendTo: opts.panels.layers },
    styleManager: { appendTo: opts.panels.styles },
    selectorManager: { appendTo: opts.panels.selectors, componentFirst: true },
    traitManager: { appendTo: opts.panels.traits },
    deviceManager: { devices: DEVICES },
    blockManager: { blocks: [] },
    assetManager: { assets: [], upload: false },
    // The page saves through the API; never prompt on unload from inside GrapesJS.
    noticeOnUnload: false,
  });

  let savedManifest = serializeManifest(manifest);
  /** Board paths that exist in the last saved version (a deleted one is sent as null). */
  let savedPaths = new Set<string>();
  let boards = new Map<string, BoardState>();
  let current = "";
  const changeListeners: (() => void)[] = [];
  const boardListeners: ((id: string) => void)[] = [];
  let loading = false;
  let editable = opts.editable;

  const changed = () => {
    if (!loading) for (const cb of changeListeners) cb();
  };

  /** Throws ManifestUnreadableError, before changing anything, when the manifest is not JSON. */
  const reset = (files: Record<string, string>) => {
    manifest = readManifest(files["manifest.json"]);
    savedManifest = serializeManifest(manifest);
    boards = new Map();
    savedPaths = new Set();
    for (const b of manifest.boards) {
      const text = files[b.file];
      if (typeof text !== "string") continue;
      boards.set(b.id, { parts: parseBoardFile(text), pending: null, baseline: null });
      savedPaths.add(b.file);
    }
    manifest.boards = manifest.boards.filter((b) => boards.has(b.id));
  };
  reset(opts.files);

  // GrapesJS 0.23.9 lists its selector manager in both of its module lists, so init makes two; each
  // renders a class picker into selectorManager.appendTo, and both stay live. Only editor.Selectors is
  // the editor's own. For the other one, destroy() removes its picker and its model's listeners (and
  // cancels its pending update); its own handler on the editor's component toggled / classes events is
  // removed here by reference. Left: its anonymous relay of `change:state` to `selector:state`, which
  // has no reference to remove by; it only fires that event a second time, which the live manager's
  // debounced update absorbs.
  const liveSelectors = editor.Selectors;
  const em = editor.getModel();
  type StaleSelectors = { name?: string; destroy?(): void; __updateSelectedByComponents?: () => void };
  for (const m of em.modules as StaleSelectors[]) {
    if (m === (liveSelectors as unknown) || m.name !== "SelectorManager") continue;
    m.destroy?.();
    if (m.__updateSelectedByComponents)
      em.off("component:toggled component:update:classes", m.__updateSelectedByComponents);
  }

  const wrapper = () => editor.getWrapper();

  /** Ids per stored board text (the parts object changes when a board is saved or reloaded). */
  const idsOf = new WeakMap<BoardParts, ReadonlySet<string>>();
  const storedIds = (parts: BoardParts): ReadonlySet<string> => {
    let ids = idsOf.get(parts);
    if (!ids) {
      const doc = new DOMParser().parseFromString(`<body>${parts.bodyHtml}</body>`, "text/html");
      const found = new Set(Array.from(doc.body.querySelectorAll("[id]"), (el) => el.id));
      if (parts.bodyAttrs.id) found.add(parts.bodyAttrs.id);
      ids = found;
      idsOf.set(parts, ids);
    }
    return ids;
  };

  /** The board in the canvas, serialised as a board file. */
  const serializeLive = (): string => {
    const state = boards.get(current);
    const root = wrapper();
    if (!state || !root) return "";
    const css = editor.getCss({ component: root }) ?? "";
    // cleanId: no ids GrapesJS made up only for selecting or styling (it keeps ids a rule or the board uses).
    const body = editor.getHtml({ component: root, cleanId: true }).replace(/^<body[^>]*>|<\/body>$/g, "");
    return serializeBoardFile(state.parts, css, body);
  };

  const injectBase = () => {
    const doc = editor.Canvas.getDocument();
    const state = boards.get(current);
    if (!doc?.head || !state) return;
    let st = doc.head.querySelector<HTMLStyleElement>("style[data-wardby-base]");
    if (!st) {
      st = doc.createElement("style");
      st.setAttribute("data-wardby-base", "");
      doc.head.insertBefore(st, doc.head.firstChild);
    }
    st.textContent = state.parts.baseCss;
  };

  /** The fields of a parsed CSS rule `setBoardStyle` reads (GrapesJS's own type resolves them to `any`). */
  type ParsedRule = {
    selectors?: (string | SelectorProps)[];
    selectorsAdd?: string;
    state?: string;
    mediaText?: string;
    atRuleType?: string;
    style?: Record<string, string | string[]>;
  };
  /**
   * Imports the base CSS, then merges the edits layer over it. The edits layer is the editor's whole
   * CSS from the last save, so it repeats every base rule GrapesJS imported, in the same order.
   * Importing the two as one stylesheet would keep both copies, and the next save would write the
   * base rules twice. `Css.addRules` is no fix either: it resolves every rule to ONE rule per key
   * (selectors, state, media, at-rule type, `selectorsAdd`), the one it has cached or else the first,
   * so for a selector the base styles twice, both edits rules land on the same rule and the other
   * rule's edits are lost.
   *
   * So the edits are matched by occurrence: the nth edits rule with a key replaces the style of the
   * nth base rule with that key, the same way for at-rules with no selector (@font-face, @page). An
   * edits rule with no base rule left to match was added in the editor, and is appended as a new rule.
   */
  const setBoardStyle = (baseCss: string, editsCss: string | null) => {
    editor.setStyle(baseCss);
    if (!editsCss) return;
    const css = editor.Css;
    const unclaimed = [...css.getAll().models];
    const added: CssRuleJSON[] = [];
    for (const def of editor.Parser.parseCss(editsCss) as ParsedRule[]) {
      if (!def.selectors) continue;
      const sels = def.selectors.map((n) => editor.Selectors.add(n));
      const props = { selectorsAdd: def.selectorsAdd, atRuleType: def.atRuleType };
      const at = unclaimed.findIndex((r) => r.compare(sels, def.state, def.mediaText, props));
      if (at < 0) {
        added.push(def as CssRuleJSON);
        continue;
      }
      const [rule] = unclaimed.splice(at, 1);
      rule?.setStyle(def.style ?? {});
    }
    // Raw adds: `Css.addRules` would fold these into a matching rule again.
    if (added.length) css.getAll().add(added);
  };

  /** Puts board `id` in the canvas: from its pending text if it has one, otherwise as stored. */
  const loadBoard = (id: string) => {
    const state = boards.get(id);
    if (!state) return;
    const parts = state.pending !== null ? parseBoardFile(state.pending) : state.parts;
    loading = true;
    const um = editor.UndoManager;
    um.stop();
    try {
      current = id;
      // The stylesheet first: parsing the body turns each inline style="" into a rule for that element,
      // and setStyle replaces every rule, so styling after the components dropped those (and a save
      // then wrote the elements without them).
      setBoardStyle(state.parts.baseCss, parts.editsCss);
      editor.setComponents(parts.bodyHtml);
      const root = wrapper();
      if (root) {
        root.setAttributes({ ...parts.bodyAttrs });
        if (!editable) lockTree(root);
      }
      injectBase();
      // Loaded as last saved: that is the baseline. It is taken on every such load, since GrapesJS
      // gives a styled element without an id a new random id each time it parses the board.
      if (state.pending === null && savedPaths.has(boardPath(id))) {
        state.baseline = serializeLive();
      }
      state.pending = null;
    } finally {
      um.start();
      um.clear();
      loading = false;
    }
    for (const cb of boardListeners) cb(id);
  };

  /** Keeps the board being left as text, so its edits survive the switch. */
  const stash = () => {
    const state = boards.get(current);
    if (!state) return;
    const text = serializeLive();
    state.pending = text === state.baseline ? null : text;
  };

  const textOf = (id: string): string | null => {
    const state = boards.get(id);
    if (!state) return null;
    return id === current ? serializeLive() : state.pending;
  };

  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  editor.on("load", () => {
    const first = manifest.boards[0]?.id;
    if (first) loadBoard(first);
    markReady();
  });
  editor.on("canvas:frame:load", () => injectBase());
  editor.on("update", () => changed());
  editor.on("component:selected", (c: Component) => {
    if (editable && !c.get("resizable")) c.set("resizable", RESIZE);
  });
  editor.on("component:add", (c: Component) => {
    if (!editable) lockTree(c);
  });
  // A locked board has no shortcuts (undo, paste, delete, ...); unlocking adds GrapesJS's defaults back.
  const keymapDefaults = editor.Keymaps.getConfig().defaults ?? {};
  if (!editable) editor.Keymaps.removeAll();

  const api: BoardsEditor = {
    editor,
    ready,
    currentBoard: () => current,
    selectBoard(id) {
      if (id === current || !boards.has(id)) return;
      stash();
      loadBoard(id);
    },
    changedFiles() {
      const out: Record<string, string | null> = {};
      for (const b of manifest.boards) {
        const text = textOf(b.id);
        if (text === null) continue;
        const baseline = boards.get(b.id)?.baseline ?? null;
        if (text !== baseline) out[b.file] = text;
      }
      const listed = new Set(manifest.boards.map((b) => b.file));
      for (const p of savedPaths) if (!listed.has(p)) out[p] = null;
      const m = serializeManifest(manifest);
      if (m !== savedManifest) out["manifest.json"] = m;
      return out;
    },
    markSaved(files) {
      for (const [path, text] of Object.entries(files)) {
        if (path === "manifest.json") {
          if (text !== null) savedManifest = text;
          continue;
        }
        if (text === null) {
          savedPaths.delete(path);
          continue;
        }
        savedPaths.add(path);
        const b = manifest.boards.find((x) => x.file === path);
        const state = b && boards.get(b.id);
        if (!state) continue;
        state.baseline = text;
        // The saved text is what the board now loads from (its base layer is unchanged).
        state.parts = parseBoardFile(text);
        if (state.pending === text) state.pending = null;
      }
    },
    dirty() {
      return !!editor.getEditing() || Object.keys(api.changedFiles()).length > 0;
    },
    manifest: () => ({ title: manifest.title, boards: manifest.boards.map((b) => ({ ...b })) }),
    load(files) {
      const keep = current;
      reset(files);
      const next = boards.has(keep) ? keep : (manifest.boards[0]?.id ?? "");
      current = "";
      loadBoard(next);
    },
    addBoard(name) {
      const trimmed = name.trim().slice(0, 80);
      const id = boardIdFor(
        trimmed,
        manifest.boards.map((b) => b.id),
      );
      const first = manifest.boards[0];
      const firstState = first ? boards.get(first.id) : undefined;
      const firstParts = first && first.id === current ? parseBoardFile(serializeLive()) : firstState?.parts;
      const text = newBoardFile(firstParts ?? null, trimmed);
      manifest.boards.push({ id, name: trimmed || id, file: boardPath(id), width: first?.width ?? 1280 });
      boards.set(id, { parts: parseBoardFile(text), pending: text, baseline: null });
      stash();
      loadBoard(id);
      changed();
      return id;
    },
    renameBoard(id, name) {
      const b = manifest.boards.find((x) => x.id === id);
      const trimmed = name.trim().slice(0, 80);
      if (!b || !trimmed) return;
      b.name = trimmed;
      changed();
    },
    moveBoard(id, delta) {
      const i = manifest.boards.findIndex((x) => x.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= manifest.boards.length) return;
      const [b] = manifest.boards.splice(i, 1);
      manifest.boards.splice(j, 0, b);
      changed();
    },
    deleteBoard(id) {
      if (manifest.boards.length <= 1) return;
      const i = manifest.boards.findIndex((x) => x.id === id);
      if (i < 0) return;
      manifest.boards.splice(i, 1);
      boards.delete(id);
      if (current === id) {
        current = "";
        loadBoard(manifest.boards[Math.min(i, manifest.boards.length - 1)].id);
      }
      changed();
    },
    canvasDocument: () => editor.Canvas.getDocument(),
    canvasWindow: () => editor.Canvas.getWindow() ?? null,
    baseStyle: () => editor.Canvas.getDocument()?.querySelector<HTMLStyleElement>("style[data-wardby-base]") ?? null,
    root: () => wrapper()?.getEl() ?? null,
    storedIds() {
      const state = boards.get(current);
      return state ? storedIds(state.parts) : new Set<string>();
    },
    get editable() {
      return editable;
    },
    setEditable(on) {
      if (on === editable) return Promise.resolve();
      editable = on;
      // Nothing stays selected or being typed in: a selected element's toolbar and text editing end
      // (what was typed is kept in the board, as an edit made before the lock).
      let typingEnded: Promise<void> = Promise.resolve();
      if (!on) {
        const typing = editor.getEditing()?.getView() as { disableEditing?: () => Promise<void> } | undefined;
        typingEnded = Promise.resolve(typing?.disableEditing?.()).catch(() => undefined);
      }
      // Unlocking deselects too: an element selected while locked shows its rebuilt toolbar once selected again.
      editor.select();
      if (on) {
        for (const [id, k] of Object.entries(keymapDefaults)) editor.Keymaps.add(id, k.keys, k.handler, k.opts);
      } else {
        editor.Keymaps.removeAll();
      }
      const root = wrapper();
      if (!root) return typingEnded;
      const um = editor.UndoManager;
      um.stop();
      try {
        if (on) unlockTree(root);
        else lockTree(root);
      } finally {
        um.start();
      }
      return typingEnded;
    },
    setDevice: (id) => void editor.setDevice(id),
    onChange: (cb) => void changeListeners.push(cb),
    onBoard: (cb) => void boardListeners.push(cb),
  };
  return api;
}
