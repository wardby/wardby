/**
 * The live copy of a design (spec "The live copy"): per board, its elements and CSS rules as small Yjs maps, so
 * people's different changes to one element both survive. Server-safe: no DOM, no GrapesJS. The field names are
 * constants because the page (the connector), the server (the writer, merges) and tests all read the same maps.
 *
 * Per board, under the top-level map `boards`:
 * - `nodes`: one entry per element, keyed by its GrapesJS id; `root` is the board's body.
 * - `rules` + `ruleOrder`: one entry per CSS rule, each property its own field, plus the rule order.
 * - `meta`: the board's base-layer CSS (the CSS as written, under the editor's rules).
 * The board list lives in the top-level array `manifest`.
 */
import * as Y from "yjs";

export const BOARD_ROOT = "root";

/** Fields of an element entry. */
export const F = {
  tag: "tag",
  type: "type",
  void: "void",
  /** Whether the element's HTML carries its id (an anchor target, say) rather than GrapesJS making one up. */
  ownId: "ownId",
  /** The root only: the wrapper's GrapesJS id (CSS may target it). */
  gid: "gid",
  classes: "classes",
  attrs: "attrs",
  /** The attributes' order, as GrapesJS writes them. */
  attrKeys: "attrKeys",
  /** A text box: its inner HTML as GrapesJS writes it (one box merges as a whole). */
  html: "html",
  /** A text box: the class and id names used inside it (JSON array), for the CSS writer. */
  names: "names",
  /** A text node: its text. */
  content: "content",
  /** A container: its children's ids, in order. */
  children: "children",
  /** Parked by a merge until it is placed again (never deleted meanwhile). */
  detached: "detached",
} as const;

/** Fields of a CSS rule entry: what GrapesJS needs to rebuild the rule, and what the server's writer needs. */
export const R = {
  /** The rule's GrapesJS JSON without its style (to rebuild it in the editor). */
  def: "def",
  sel: "sel",
  selNoAdd: "selNoAdd",
  /** The full names of its selectors (JSON array, e.g. [".card", "#i3kd"]). */
  names: "names",
  atRule: "atRule",
  single: "single",
  add: "add",
  nested: "nested",
  /** JSON: true, false or the list of important properties. */
  important: "important",
  /** The id when the rule targets exactly one id selector, else null. */
  singleId: "singleId",
  style: "style",
  /** The properties' order (it matters in CSS: `padding` then `padding-top`). */
  props: "props",
} as const;

export interface BoardMaps {
  nodes: Y.Map<Y.Map<unknown>>;
  rules: Y.Map<Y.Map<unknown>>;
  ruleOrder: Y.Array<string>;
  meta: Y.Map<unknown>;
}

function child<T>(m: Y.Map<unknown>, key: string, make: () => T): T {
  const have = m.get(key) as T | undefined;
  if (have) return have;
  const made = make();
  m.set(key, made);
  return made;
}

/** A board's maps, created on first use. */
export function boardMaps(doc: Y.Doc, boardId: string): BoardMaps {
  const board = child(doc.getMap<unknown>("boards"), boardId, () => new Y.Map<unknown>());
  return {
    nodes: child(board, "nodes", () => new Y.Map<Y.Map<unknown>>()),
    rules: child(board, "rules", () => new Y.Map<Y.Map<unknown>>()),
    ruleOrder: child(board, "ruleOrder", () => new Y.Array<string>()),
    meta: child(board, "meta", () => new Y.Map<unknown>()),
  };
}

/** The design's board list: entries `{ id, name, file, width }`, in order. */
export const manifestOf = (doc: Y.Doc): Y.Array<Y.Map<unknown>> => doc.getArray<Y.Map<unknown>>("manifest");

/** A map's entries in the order `keys` gives, skipping keys missing from either side. */
export function orderedPairs<V>(m: Y.Map<V> | undefined, keys: Y.Array<string> | undefined): [string, V][] {
  if (!m) return [];
  const order = keys?.toArray() ?? [...m.keys()];
  return order.filter((k) => m.has(k)).map((k) => [k, m.get(k) as V]);
}
