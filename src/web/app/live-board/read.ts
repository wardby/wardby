/**
 * Fills a board's live copy from GrapesJS (spec "The connector", ours out): every element and CSS rule written
 * as its own small map, and only what differs from the live copy is written, so people's changes to different
 * fields of one element both survive. The connector (part 3) calls this on every editor change; the parity test
 * calls it directly. Field meanings: core/documents/boards/live/model.ts.
 */
import type { Component, CssRule, Editor } from "grapesjs";
import * as Y from "yjs";
import { BOARD_ROOT, F, R, type BoardMaps } from "../../../core/documents/boards/live/model.js";

type AttrValue = string | boolean;

/** Text boxes and the types that extend them (link, label) are leaves: their inner HTML is one field. */
export const isTextBox = (c: Component): boolean =>
  (c as unknown as { isInstanceOf?(t: string): boolean }).isInstanceOf?.("text") ?? c.is("text");

/** Whether the element's own HTML carries its id (rather than GrapesJS making one up). */
const ownsId = (c: Component) => !!(c.get("attributes") as Record<string, unknown> | undefined)?.id;

/** The attributes GrapesJS writes for `c`, in its order, without class, style and a made-up id. */
export function attrsOf(c: Component): [string, AttrValue][] {
  const own = ownsId(c);
  const out: [string, AttrValue][] = [];
  const attrs = c.getAttributes({ noClass: true, noStyle: true });
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class" || k === "style" || (k === "id" && !own) || v === undefined || v === null) continue;
    out.push([k, typeof v === "boolean" ? v : typeof v === "string" ? v : JSON.stringify(v)]);
  }
  return out;
}

export const classesOf = (c: Component): string =>
  c
    .getClasses()
    .map((x) => (typeof x === "string" ? x : (x as { name: string }).name))
    .join(" ");

/** Class and id names used inside a text box (the CSS writer keeps rules for them). */
function namesInside(c: Component): string[] {
  const out = new Set<string>();
  const walk = (k: Component) => {
    out.add(`#${k.getId()}`);
    for (const cl of k.classes.models) out.add((cl as unknown as { getFullName(): string }).getFullName());
    k.components().forEach(walk);
  };
  c.components().forEach(walk);
  return [...out].sort();
}

/** Rules in collection order, keyed by selector + at-rule + occurrence. */
export function rulesInOrder(editor: Editor): [string, CssRule][] {
  const out: [string, CssRule][] = [];
  const seen = new Map<string, number>();
  for (const r of editor.Css.getAll().models) {
    const base = [r.selectorsToString(), r.getAtRule(), r.get("singleAtRule") ? 1 : 0].join("@@");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push([`${base}#${n}`, r]);
  }
  return out;
}

export function styleOf(r: CssRule): [string, string][] {
  return Object.entries(r.getStyle()).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
}

/** What the server's writer needs about a rule, read off GrapesJS once (it never changes for a given key). */
function ruleFacts(r: CssRule): Record<string, unknown> {
  type Sel = { getFullName(): string; isId(): boolean; get(k: string): string };
  const sels = (r.getSelectors() as unknown as { models: Sel[] }).models;
  return {
    [R.sel]: r.selectorsToString(),
    [R.selNoAdd]: r.selectorsToString({ skipAdd: 1 }),
    [R.names]: JSON.stringify(sels.map((s) => s.getFullName())),
    [R.atRule]: r.getAtRule(),
    [R.single]: !!r.get("singleAtRule"),
    [R.add]: !!r.get("selectorsAdd"),
    [R.nested]: !!(r as unknown as { isNested?(): boolean }).isNested?.(),
    [R.important]: JSON.stringify(r.get("important") ?? false),
    [R.singleId]: sels.length === 1 && sels[0].isId() ? sels[0].get("name") : null,
  };
}

function child<T>(m: Y.Map<unknown>, k: string, make: () => T): T {
  const have = m.get(k) as T | undefined;
  if (have) return have;
  const made = make();
  m.set(k, made);
  return made;
}
const setIf = (m: Y.Map<unknown>, k: string, v: unknown): boolean => {
  if (m.get(k) === v) return false;
  m.set(k, v);
  return true;
};

/** Makes `a` equal `want` with the fewest inserts and deletes (keeps concurrent changes elsewhere in it). */
export function syncArray(a: Y.Array<string>, want: string[]): boolean {
  const have = a.toArray();
  if (have.length === want.length && have.every((x, i) => x === want[i])) return false;
  let start = 0;
  while (start < have.length && start < want.length && have[start] === want[start]) start++;
  let endH = have.length;
  let endW = want.length;
  while (endH > start && endW > start && have[endH - 1] === want[endW - 1]) {
    endH--;
    endW--;
  }
  if (endH > start) a.delete(start, endH - start);
  if (endW > start) a.insert(start, want.slice(start, endW));
  return true;
}

/** Makes map + key order equal `want`. */
function syncPairs(m: Y.Map<unknown>, keys: Y.Array<string>, want: [string, unknown][]): boolean {
  let changed = false;
  const wantKeys = want.map(([k]) => k);
  for (const [k, v] of want) changed = setIf(m, k, v) || changed;
  for (const k of [...m.keys()]) {
    if (!wantKeys.includes(k)) {
      m.delete(k);
      changed = true;
    }
  }
  return syncArray(keys, wantKeys) || changed;
}

export interface ReadOptions {
  /** A text box being typed in: its HTML comes from the page (GrapesJS updates its model when it closes). */
  editing?: { id: string; el: HTMLElement } | null;
  /** The base layer, written into the board's meta when given. */
  baseCss?: string;
  /** The board file's other parts (title, language, body attributes), written into the meta when given. */
  parts?: { lang: string; title: string; bodyAttrs: Record<string, string> };
  /** The origin the transaction carries (the connector's, so it does not apply its own changes back). */
  origin?: unknown;
}

/** Writes what differs between GrapesJS and the live copy into the live copy. Returns the number of changes. */
export function readBoard(editor: Editor, maps: BoardMaps, opts: ReadOptions = {}): number {
  const root = editor.getWrapper();
  if (!root) return 0;
  const { nodes, rules, ruleOrder, meta } = maps;
  let changes = 0;
  const writeNode = (c: Component, id: string, seen: Set<string>) => {
    seen.add(id);
    const n = child(nodes as unknown as Y.Map<unknown>, id, () => new Y.Map<unknown>());
    let d = 0;
    d += +setIf(n, F.tag, c.get("tagName") ?? "div");
    d += +setIf(n, F.type, c.get("type") ?? "default");
    if (c.is("textnode")) {
      d += +setIf(n, F.content, c.get("content") ?? "");
      changes += d;
      return;
    }
    d += +setIf(n, F.void, !!c.get("void"));
    d += +setIf(n, F.ownId, ownsId(c));
    if (id === BOARD_ROOT) d += +setIf(n, F.gid, c.getId());
    d += +syncPairs(
      child(n, F.attrs, () => new Y.Map<unknown>()),
      child(n, F.attrKeys, () => new Y.Array<string>()),
      attrsOf(c),
    );
    d += +setIf(n, F.classes, classesOf(c));
    if (isTextBox(c) && id !== BOARD_ROOT) {
      const html = opts.editing?.id === id ? opts.editing.el.innerHTML : c.getInnerHTML();
      d += +setIf(n, F.html, html);
      d += +setIf(n, F.names, JSON.stringify(namesInside(c)));
      changes += d;
      return;
    }
    const kids = c.components().models;
    for (const k of kids) writeNode(k, k.getId(), seen);
    d += +syncArray(
      child(n, F.children, () => new Y.Array<string>()),
      kids.map((k) => k.getId()),
    );
    changes += d;
  };
  nodes.doc!.transact(() => {
    if (opts.baseCss !== undefined && setIf(meta, "baseCss", opts.baseCss)) changes++;
    if (opts.parts && setIf(meta, "parts", JSON.stringify(opts.parts))) changes++;
    const seen = new Set<string>();
    writeNode(root, BOARD_ROOT, seen);
    // Parts a merge parked (detached) wait to be placed again: never deleted here.
    const parked = new Set<string>();
    const park = (id: string) => {
      parked.add(id);
      for (const c of (nodes.get(id)?.get(F.children) as Y.Array<string> | undefined)?.toArray() ?? []) park(c);
    };
    for (const [id, n] of nodes) if (n.get(F.detached)) park(id);
    for (const id of [...nodes.keys()]) {
      if (!seen.has(id) && !parked.has(id)) {
        nodes.delete(id);
        changes++;
      }
    }
    const live = rulesInOrder(editor);
    for (const [key, r] of live) {
      let y = rules.get(key);
      if (!y) {
        y = new Y.Map();
        rules.set(key, y);
        const { style: _style, ...def } = r.toJSON() as Record<string, unknown>;
        y.set(R.def, JSON.stringify(def));
        for (const [k, v] of Object.entries(ruleFacts(r))) y.set(k, v);
        y.set(R.style, new Y.Map());
        y.set(R.props, new Y.Array());
        changes++;
      }
      if (syncPairs(y.get(R.style) as Y.Map<unknown>, y.get(R.props) as Y.Array<string>, styleOf(r))) changes++;
    }
    const keys = live.map(([k]) => k);
    for (const key of [...rules.keys()]) {
      if (!keys.includes(key)) {
        rules.delete(key);
        changes++;
      }
    }
    if (syncArray(ruleOrder, keys)) changes++;
  }, opts.origin);
  return changes;
}
