/**
 * Fills a board's live copy from GrapesJS (spec "The connector", ours out): every element and CSS rule written
 * as its own small map, and only what differs from the live copy is written, so people's changes to different
 * fields of one element both survive. The connector (part 3) calls this on every editor change; the parity test
 * calls it directly. Field meanings: core/documents/boards/live/model.ts.
 */
import type { Component, CssRule, Editor } from "grapesjs";
import * as Y from "yjs";
import { BOARD_ROOT, F, R, setHtml, type BoardMaps } from "../../../core/documents/boards/live/model.js";

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

/** The attribute that holds a rule's live key on its GrapesJS model (never in the board's CSS). */
export const RULE_KEY = "wardbyKey";

/**
 * Rules in collection order with their live keys. A rule's key is given once, when this page first sees the rule
 * (selector + at-rule + occurrence, so two pages adding the same rule at once give it the same key and it merges),
 * and kept on the rule: a rule with the same selector added or removed earlier later never shifts it.
 */
export function rulesInOrder(editor: Editor): [string, CssRule][] {
  const models = editor.Css.getAll().models;
  const used = new Set(models.map((r) => r.get(RULE_KEY) as unknown).filter((k) => typeof k === "string"));
  const out: [string, CssRule][] = [];
  const seen = new Map<string, number>();
  for (const r of models) {
    const base = [r.selectorsToString(), r.getAtRule(), r.get("singleAtRule") ? 1 : 0].join("@@");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    let key = r.get(RULE_KEY) as unknown;
    if (typeof key !== "string") {
      let m = n;
      while (used.has(`${base}#${m}`)) m++;
      key = `${base}#${m}`;
      used.add(key as string);
      r.set(RULE_KEY, key, { silent: true });
    }
    out.push([key as string, r]);
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

/**
 * Applies this page's own changes to a shared list: what it removed and what it added or moved since `base` (the
 * list as it last saw it), each placed after the nearest item before it in `want` that the shared list has. Anything
 * else in the shared list (someone else's change this page has not shown yet) is left as it is: making the list
 * equal to `want` would drop it. Without a base, the list is made equal to `want`.
 */
export function mergeList(a: Y.Array<string>, base: string[] | undefined, want: string[]): boolean {
  if (!base) return syncArray(a, want);
  const inBase = new Set(base);
  const inWant = new Set(want);
  // Items in both whose order changed: the longest run in the same order stays, the rest move.
  const common = want.filter((x) => inBase.has(x));
  const at = new Map(base.map((x, i) => [x, i]));
  const seq = common.map((x) => at.get(x)!);
  const prev = new Array<number>(seq.length).fill(-1);
  const tails: number[] = [];
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const stays = new Set<string>();
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) stays.add(common[k]);
  const moved = new Set(common.filter((x) => !stays.has(x)));
  const removed = new Set(base.filter((x) => !inWant.has(x)));
  let changed = false;
  const have = a.toArray();
  for (let i = have.length - 1; i >= 0; i--) {
    if (removed.has(have[i]) || moved.has(have[i])) {
      a.delete(i, 1);
      changed = true;
    }
  }
  for (let j = 0; j < want.length; j++) {
    const x = want[j];
    if (inBase.has(x) && !moved.has(x)) continue;
    if (!inBase.has(x) && a.toArray().includes(x)) continue; // someone else added it too
    let pos = 0;
    for (let k = j - 1; k >= 0; k--) {
      const i = a.toArray().indexOf(want[k]);
      if (i >= 0) {
        pos = i + 1;
        break;
      }
    }
    a.insert(pos, [x]);
    changed = true;
  }
  return changed;
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
  /**
   * What GrapesJS held when it was last in step with the live copy (snapshotBoard). Given, only what changed in
   * GrapesJS since then is written: a field the live copy has from someone else, not yet applied here, is left alone,
   * and an element or rule is deleted only if this page had it and no longer does. Without it, everything is written.
   */
  since?: Snapshot;
  /** Rules this call creates in the live copy, recorded here (another page may create the same rule at once). */
  created?: Map<string, Y.Map<unknown>>;
  /**
   * When given, new rules are created (and added to the rule order) in a transaction of their own with this origin,
   * before the properties are written: an undo then removes this page's properties, never a rule someone else has
   * since added properties to.
   */
  structureOrigin?: unknown;
}

/** GrapesJS's board, field by field, as the live copy holds it (keys: `n|id|field`, `a|id|attr`, `c|id`, `r|key|prop` ...). */
export type Snapshot = Map<string, string>;

const enc = (v: unknown): string => JSON.stringify(v ?? null);

/** Visits GrapesJS's board field by field, in the live copy's terms. */
function visit(editor: Editor, editing: ReadOptions["editing"], put: (key: string, value: unknown) => void): void {
  const root = editor.getWrapper();
  if (!root) return;
  const node = (c: Component, id: string) => {
    put(`n|${id}|${F.tag}`, c.get("tagName") ?? "div");
    put(`n|${id}|${F.type}`, c.get("type") ?? "default");
    if (c.is("textnode")) {
      put(`n|${id}|${F.content}`, c.get("content") ?? "");
      return;
    }
    put(`n|${id}|${F.void}`, !!c.get("void"));
    put(`n|${id}|${F.ownId}`, ownsId(c));
    if (id === BOARD_ROOT) put(`n|${id}|${F.gid}`, c.getId());
    const attrs = attrsOf(c);
    for (const [k, v] of attrs) put(`a|${id}|${k}`, v);
    put(
      `ak|${id}`,
      attrs.map(([k]) => k),
    );
    put(`n|${id}|${F.classes}`, classesOf(c));
    if (isTextBox(c) && id !== BOARD_ROOT) {
      put(`n|${id}|${F.html}`, editing?.id === id ? editing.el.innerHTML : c.getInnerHTML());
      put(`n|${id}|${F.names}`, JSON.stringify(namesInside(c)));
      return;
    }
    const kids = c.components().models;
    for (const k of kids) node(k, k.getId());
    put(
      `c|${id}`,
      kids.map((k) => k.getId()),
    );
  };
  node(root, BOARD_ROOT);
  const live = rulesInOrder(editor);
  for (const [key, r] of live) {
    put(`rk|${key}`, true);
    const style = styleOf(r);
    for (const [p, v] of style) put(`r|${key}|${p}`, v);
    put(
      `rp|${key}`,
      style.map(([p]) => p),
    );
  }
  put(
    "ro",
    live.map(([k]) => k),
  );
}

/** The snapshot `readBoard` compares against next time. */
export function snapshotBoard(editor: Editor, editing?: ReadOptions["editing"]): Snapshot {
  const out: Snapshot = new Map();
  visit(editor, editing, (k, v) => out.set(k, enc(v)));
  return out;
}

/** Writes what changed in GrapesJS (since `opts.since`, or everything) into the live copy. Returns the number of changes. */
export function readBoard(editor: Editor, maps: BoardMaps, opts: ReadOptions = {}): number {
  const root = editor.getWrapper();
  if (!root) return 0;
  const { nodes, rules, ruleOrder, meta } = maps;
  const now = snapshotBoard(editor, opts.editing);
  const since = opts.since;
  /** Whether this page changed `key` since the last snapshot (always, without one). */
  const mine = (key: string) => !since || since.get(key) !== now.get(key);
  /** Whether this page had `key` and no longer does (a local deletion). */
  const gone = (key: string) => (since ? since.has(key) && !now.has(key) : !now.has(key));
  let changes = 0;
  /** A list as this page last saw it (the base its own list changes are taken from). */
  const listBase = (key: string): string[] | undefined => {
    const seen = since?.get(key);
    if (seen === undefined) return undefined;
    const v = JSON.parse(seen) as unknown;
    return Array.isArray(v) ? v.map(String) : undefined;
  };
  const set = (m: Y.Map<unknown>, field: string, key: string, value: unknown) => {
    if (mine(key) && setIf(m, field, value)) changes++;
  };
  const writeNode = (c: Component, id: string) => {
    // Gone from the live copy although this page had it: someone else deleted it (not applied here yet). Writing
    // it would bring it back; leave it to the reconcile that follows.
    if (!nodes.has(id) && since?.has(`n|${id}|${F.type}`)) return;
    const n = child(nodes as unknown as Y.Map<unknown>, id, () => new Y.Map<unknown>());
    set(n, F.tag, `n|${id}|${F.tag}`, c.get("tagName") ?? "div");
    set(n, F.type, `n|${id}|${F.type}`, c.get("type") ?? "default");
    if (c.is("textnode")) {
      set(n, F.content, `n|${id}|${F.content}`, c.get("content") ?? "");
      return;
    }
    set(n, F.void, `n|${id}|${F.void}`, !!c.get("void"));
    set(n, F.ownId, `n|${id}|${F.ownId}`, ownsId(c));
    if (id === BOARD_ROOT) set(n, F.gid, `n|${id}|${F.gid}`, c.getId());
    const attrs = child(n, F.attrs, () => new Y.Map<unknown>());
    const attrKeys = child(n, F.attrKeys, () => new Y.Array<string>());
    const want = attrsOf(c);
    for (const [k, v] of want) if (mine(`a|${id}|${k}`) && setIf(attrs, k, v)) changes++;
    for (const k of [...attrs.keys()]) {
      if (!want.some(([w]) => w === k) && gone(`a|${id}|${k}`)) {
        attrs.delete(k);
        changes++;
      }
    }
    if (
      mine(`ak|${id}`) &&
      mergeList(
        attrKeys,
        listBase(`ak|${id}`),
        want.map(([k]) => k),
      )
    )
      changes++;
    set(n, F.classes, `n|${id}|${F.classes}`, classesOf(c));
    if (isTextBox(c) && id !== BOARD_ROOT) {
      // The box being typed in (or just closed) goes out from the connector as character changes (bind.ts);
      // any other box's text replaces only the run that changed.
      const key = `n|${id}|${F.html}`;
      if (opts.editing?.id !== id && mine(key) && setHtml(n, c.getInnerHTML())) changes++;
      set(n, F.names, `n|${id}|${F.names}`, JSON.stringify(namesInside(c)));
      return;
    }
    const kids = c.components().models;
    for (const k of kids) writeNode(k, k.getId());
    const ch = child(n, F.children, () => new Y.Array<string>());
    if (
      mine(`c|${id}`) &&
      mergeList(
        ch,
        listBase(`c|${id}`),
        kids.map((k) => k.getId()),
      )
    )
      changes++;
  };
  /** A new rule's map, with what never changes for its key. */
  const newRule = (key: string, r: CssRule): Y.Map<unknown> => {
    const y = new Y.Map<unknown>();
    rules.set(key, y);
    opts.created?.set(key, y);
    // The key is the live copy's own (its map key), not part of the rule's definition.
    const { style: _style, [RULE_KEY]: _key, ...def } = r.toJSON() as Record<string, unknown>;
    y.set(R.def, JSON.stringify(def));
    for (const [k, v] of Object.entries(ruleFacts(r))) y.set(k, v);
    y.set(R.style, new Y.Map());
    y.set(R.props, new Y.Array());
    return y;
  };
  if (opts.structureOrigin !== undefined) {
    const fresh = rulesInOrder(editor).filter(([key]) => !rules.has(key) && !since?.has(`rk|${key}`));
    if (fresh.length) {
      nodes.doc!.transact(() => {
        for (const [key, r] of fresh) {
          newRule(key, r);
          ruleOrder.push([key]);
          changes++;
        }
      }, opts.structureOrigin);
    }
  }
  nodes.doc!.transact(() => {
    if (opts.baseCss !== undefined && setIf(meta, "baseCss", opts.baseCss)) changes++;
    if (opts.parts && setIf(meta, "parts", JSON.stringify(opts.parts))) changes++;
    writeNode(root, BOARD_ROOT);
    // Parts a merge parked (detached) wait to be placed again: never deleted here.
    const parked = new Set<string>();
    const park = (id: string) => {
      parked.add(id);
      for (const c of (nodes.get(id)?.get(F.children) as Y.Array<string> | undefined)?.toArray() ?? []) park(c);
    };
    for (const [id, n] of nodes) if (n.get(F.detached)) park(id);
    for (const id of [...nodes.keys()]) {
      if (!parked.has(id) && gone(`n|${id}|${F.type}`)) {
        nodes.delete(id);
        changes++;
      }
    }
    const live = rulesInOrder(editor);
    for (const [key, r] of live) {
      let y = rules.get(key);
      // Deleted by someone else since this page last caught up: not brought back.
      if (!y && since?.has(`rk|${key}`)) continue;
      if (!y) {
        y = newRule(key, r);
        changes++;
      }
      const style = y.get(R.style) as Y.Map<unknown>;
      const want = styleOf(r);
      for (const [p, v] of want) if (mine(`r|${key}|${p}`) && setIf(style, p, v)) changes++;
      for (const p of [...style.keys()]) {
        if (!want.some(([w]) => w === p) && gone(`r|${key}|${p}`)) {
          style.delete(p);
          changes++;
        }
      }
      if (
        mine(`rp|${key}`) &&
        mergeList(
          y.get(R.props) as Y.Array<string>,
          listBase(`rp|${key}`),
          want.map(([p]) => p),
        )
      )
        changes++;
    }
    for (const key of [...rules.keys()]) {
      if (gone(`rk|${key}`)) {
        rules.delete(key);
        changes++;
      }
    }
    if (
      mine("ro") &&
      mergeList(
        ruleOrder,
        listBase("ro"),
        live.map(([k]) => k),
      )
    )
      changes++;
  }, opts.origin);
  return changes;
}
