/**
 * The server's board writer (spec "Versions are checkpoints"): a board's body HTML and its edits CSS, printed from
 * the live copy with no GrapesJS and no DOM, exactly as GrapesJS 0.23.9 writes them with
 * `getHtml({ component: root, cleanId: true })` and `getCss({ component: root })`:
 *
 * - An element: its attributes in order, then `class`, then a made-up id only when a rule with some style targets
 *   exactly that id (cleanId drops the others; selecting an element makes an empty rule, which does not count);
 *   an empty void element closes with `/>`. Text is escaped `& < >`, attribute values also `"`.
 * - CSS: rules in order; a rule none of whose selectors is used on the board is dropped; at-rules are grouped and
 *   the groups sorted with GrapesJS's own comparator (desktop-first unless both queries are `min-width`).
 *
 * The parity test (parity.browser.test.ts) compares this with GrapesJS's own save on every fixture board: GrapesJS
 * stays pinned, and an upgrade must pass it.
 */
import type * as Y from "yjs";
import { serializeBoardFile, type BoardParts } from "../board-file-text.js";
import { BOARD_ROOT, F, orderedPairs, R, type BoardMaps } from "./model.js";

/** One spot in the written body, in document order: which live element (or text) produced it. */
export type Spot = { id: string; kind: "el" | "leaf" | "text"; tag?: string };

export interface WrittenBoard {
  body: string;
  css: string;
  /** The version map: which live element wrote each spot (empty text writes nothing and has no spot). */
  spots: Spot[];
  /** The base layer from the live copy, or null when the live copy has none yet. */
  baseCss: string | null;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");
/** A live-copy field as text (anything else as the fallback). */
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const jsonList = (v: unknown): string[] => {
  try {
    const parsed: unknown = JSON.parse(str(v, "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** GrapesJS's `getQueryLength`: the first number in a media query (none sorts as the largest). */
const queryLength = (q: string): number => {
  const m = /(-?\d*\.?\d+)\w{0,}/.exec(q);
  return m ? parseFloat(m[1]) : Number.MAX_VALUE;
};

export function writeBoard(maps: BoardMaps): WrittenBoard {
  const { nodes, rules, ruleOrder, meta } = maps;
  const order = ruleOrder.toArray().filter((k) => rules.has(k));
  const spots: Spot[] = [];

  const idRules = new Set<string>();
  for (const k of order) {
    const y = rules.get(k)!;
    const id = y.get(R.singleId);
    if (typeof id === "string" && ((y.get(R.props) as Y.Array<string> | undefined)?.length ?? 0) > 0) idRules.add(id);
  }

  const used = new Set<string>();
  const html = (id: string): string => {
    const n = nodes.get(id);
    if (!n || n.get(F.type) === "pending") return "";
    // A comment: written as is, and no spot (the version map skips comments as the parser does not).
    if (n.get(F.type) === "comment") return `<!--${str(n.get(F.content))}-->`;
    if (n.get(F.type) === "textnode") {
      const t = str(n.get(F.content));
      if (t) spots.push({ id, kind: "text" });
      return escText(t);
    }
    const isLeaf = typeof n.get(F.html) === "string";
    const tag = str(n.get(F.tag), "div");
    spots.push({ id, kind: isLeaf ? "leaf" : "el", tag });
    used.add(`#${id}`);
    const classes = str(n.get(F.classes)).split(" ").filter(Boolean);
    for (const c of classes) used.add(`.${c}`);
    const out: string[] = [];
    for (const [k, v] of orderedPairs(
      n.get(F.attrs) as Y.Map<string | boolean>,
      n.get(F.attrKeys) as Y.Array<string>,
    )) {
      if (typeof v === "boolean") {
        if (v) out.push(k);
      } else out.push(`${k}="${escAttr(String(v))}"`);
    }
    if (classes.length) out.push(`class="${escAttr(classes.join(" "))}"`);
    if (!n.get(F.ownId) && idRules.has(id)) out.push(`id="${escAttr(id)}"`);
    let inner: string;
    if (isLeaf) {
      inner = n.get(F.html) as string;
      for (const name of jsonList(n.get(F.names))) used.add(name);
    } else {
      inner = ((n.get(F.children) as Y.Array<string> | undefined)?.toArray() ?? []).map(html).join("");
    }
    const attrs = out.length ? ` ${out.join(" ")}` : "";
    if (!inner && n.get(F.void)) return `<${tag}${attrs}/>`;
    return `<${tag}${attrs}>${inner}</${tag}>`;
  };
  const root = nodes.get(BOARD_ROOT);
  if (root?.get(F.gid)) used.add(`#${str(root.get(F.gid))}`);
  const body = ((root?.get(F.children) as Y.Array<string> | undefined)?.toArray() ?? []).map(html).join("");

  const declaration = (y: Y.Map<unknown>): string => {
    let important: boolean | string[] = false;
    try {
      important = JSON.parse(str(y.get(R.important), "false")) as boolean | string[];
    } catch {
      important = false;
    }
    const style = orderedPairs(y.get(R.style) as Y.Map<string>, y.get(R.props) as Y.Array<string>)
      .filter(([p]) => !p.startsWith("__"))
      .map(([p, v]) => {
        const imp = Array.isArray(important) ? important.includes(p) : important;
        const values = v.startsWith("[") ? jsonList(v) : [v];
        return values.map((val) => `${p}:${val}${imp ? " !important" : ""};`).join("");
      })
      .join("");
    if (!style) return "";
    return y.get(R.single) ? style : `${str(y.get(R.sel))}{${style}}`;
  };
  const kept = (y: Y.Map<unknown>) =>
    (!!y.get(R.selNoAdd) && jsonList(y.get(R.names)).some((name) => used.has(name))) ||
    !!y.get(R.add) ||
    !!y.get(R.single);

  let css = "";
  const groups = new Map<string, Y.Map<unknown>[]>();
  for (const k of order) {
    const y = rules.get(k)!;
    if (y.get(R.nested)) continue;
    const at = str(y.get(R.atRule));
    if (at) {
      groups.set(at, [...(groups.get(at) ?? []), y]);
      continue;
    }
    if (kept(y)) css += declaration(y);
  }
  // GrapesJS's sortMediaObject, comparator and all (it is not consistent for mixed queries; the same sort runs here).
  const sorted = [...groups.entries()].sort(([a], [b]) => {
    const mobileFirst = [a, b].every((q) => q.includes("min-width"));
    const left = mobileFirst ? a : b;
    const right = mobileFirst ? b : a;
    return queryLength(left) - queryLength(right);
  });
  for (const [at, list] of sorted) {
    let inside = "";
    for (const y of list) {
      if (!kept(y)) continue;
      const d = declaration(y);
      if (!d) continue;
      if (y.get(R.single)) css += `${at}{${d}}`;
      else inside += d;
    }
    if (inside) css += `${at}{${inside}}`;
  }
  const base = meta.get("baseCss");
  return { body, css, spots, baseCss: typeof base === "string" ? base : null };
}

/** A whole board file from the live copy: the parts the live copy does not hold (title, language, body attributes) come from `parts`. */
export function writeBoardFile(maps: BoardMaps, parts: BoardParts): string {
  const out = writeBoard(maps);
  return serializeBoardFile(out.baseCss === null ? parts : { ...parts, baseCss: out.baseCss }, out.css, out.body);
}
