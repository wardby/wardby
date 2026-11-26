/**
 * An agent's (or a page's fallback) version of a board merged into its live copy as changes by element (spec "Agent
 * and MCP publishes merge as diffs"):
 *
 * 1. The base version was written from the live copy; its spots (writer.ts) say which live element wrote each spot.
 *    Parsing the base body and walking it the same way maps every base element and text to its live id (version-map.ts).
 * 2. The new body is compared with the base body (an HTML parser is used only to compare): matched elements are
 *    compared (attributes, classes, text-box HTML, text); children (elements and non-blank text together) are aligned
 *    (tag + classes where the text is alike, then a fuzzy pass); order changes within a parent are moves (the longest
 *    run in the same order stays); elements removed in one place and found elsewhere are moves; found inside a new
 *    element (a wrapper) they keep their identity; a replaced element's unchanged parts are carried into the replacement.
 * 3. The changes are applied to a live copy by element id, so changes made since the base by anyone else stay wherever
 *    the new version did not touch the same thing. A text box's new HTML is merged with what it holds now word by word
 *    (merge3). New elements are created here by GrapesJS's own rules (elements.ts); CSS changes per rule and property.
 */
import { JSDOM, VirtualConsole, type DomElement, type DomNode } from "jsdom";
import postcss from "postcss";
import * as Y from "yjs";
import { nodesFromHtml, putNodes } from "./elements.js";
import { BOARD_ROOT, F, R, type BoardMaps } from "./model.js";
import { mapBase } from "./version-map.js";
import { writeBoard, type Spot } from "./writer.js";

const { window } = new JSDOM("");

export type MergeOp =
  | { kind: "attr"; id: string; name: string; value: string | null }
  | { kind: "classes"; id: string; add: string[]; remove: string[] }
  | { kind: "html"; id: string; base: string; html: string }
  | { kind: "text"; id: string; content: string }
  | { kind: "remove"; id: string; keep: string[] }
  | { kind: "move"; id: string; parent: string; after: string | null }
  | { kind: "insert"; parent: string; after: string | null; html: string }
  | { kind: "css"; key: string; set: [string, string][]; drop: string[] }
  | { kind: "css-add"; selector: string; at: string; props: [string, string][] }
  | { kind: "css-remove"; key: string }
  | { kind: "base"; css: string };

export interface BoardDiff {
  ops: MergeOp[];
  /** Base elements, and how many keep their identity (not removed). */
  baseElements: number;
  kept: number;
}

/** The attribute that marks, in new HTML, an element the merge kept by identity (resolved when applied). */
export const KEEP_ATTR = "data-wardby-keep";

const body = (html: string): DomElement => {
  const d = window.document.createElement("body");
  d.innerHTML = html;
  return d;
};
const ws = (s: string) => s.replace(/\s+/g, " ").trim();
const isText = (n: DomNode) => n.nodeType === 3;
const asEl = (n: DomNode) => n as DomElement;
const classList = (e: DomElement) => (e.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const sig = (n: DomNode) => (isText(n) ? "#text" : `${asEl(n).localName}.${classList(asEl(n)).sort().join(".")}`);
const words = (s: string) => new Set(ws(s).toLowerCase().split(" ").filter(Boolean));
/** Similar content: the same text with whitespace removed, else word overlap (Jaccard); elements of another tag never. */
function similar(a: DomNode, b: DomNode): number {
  if (isText(a) !== isText(b)) return 0;
  if (!isText(a) && asEl(a).localName !== asEl(b).localName) return 0;
  const [ta, tb] = [a.textContent ?? "", b.textContent ?? ""];
  if (ta.replace(/\s+/g, "") === tb.replace(/\s+/g, "")) return 1;
  const [wa, wb] = [words(ta), words(tb)];
  if (!wa.size && !wb.size) return sig(a) === sig(b) ? 1 : 0.6;
  let n = 0;
  for (const w of wa) if (wb.has(w)) n++;
  return n / (wa.size + wb.size - n);
}
/** Elements and text that is not only whitespace: what a container's children are compared by. */
const items = (e: DomNode) =>
  Array.from(e.childNodes).filter((n) => n.nodeType === 1 || (isText(n) && ws(n.textContent ?? "")));
/** HTML as a tool may reformat it: whitespace collapsed and void tags unified. */
const norm = (h: string) => ws(h.replace(/\s*\/>/g, ">")).replace(/>\s+</g, "><");

/** Indices (values of `xs`) on one longest strictly increasing run. */
function longestIncreasing(xs: number[]): number[] {
  const prev = new Array<number>(xs.length).fill(-1);
  const tails: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]] < xs[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.unshift(xs[k]);
  return out;
}

/** Rules of a stylesheet keyed as the live copy keys them (selector, at-rule, occurrence; whitespace dropped). */
function cssRules(css: string): { key: string; selector: string; at: string; props: [string, string][] }[] {
  const out: { key: string; selector: string; at: string; props: [string, string][] }[] = [];
  const seen = new Map<string, number>();
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    return out;
  }
  root.walkRules((r) => {
    const parent = r.parent?.type === "atrule" ? (r.parent as postcss.AtRule) : null;
    const at = parent ? `@${parent.name} ${parent.params}` : "";
    const base = `${r.selector.replace(/\s+/g, "")}@@${at.replace(/\s+/g, "")}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const props: [string, string][] = [];
    r.walkDecls((d) => void props.push([d.prop, d.value + (d.important ? " !important" : "")]));
    out.push({ key: `${base}#${n}`, selector: r.selector, at, props });
  });
  return out;
}

/**
 * The live copy's rules by the key a stylesheet's rules get here (selector, at-rule, occurrence; whitespace
 * dropped), from each rule's selector and at-rule in the live order: rule keys in the live copy are stable ids and
 * say nothing about the rule.
 */
export function ruleOccurrences(maps: BoardMaps): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  for (const key of new Set(maps.ruleOrder.toArray())) {
    const y = maps.rules.get(key);
    if (!y) continue;
    const base = `${text(y.get(R.sel)).replace(/\s+/g, "")}@@${text(y.get(R.atRule)).replace(/\s+/g, "")}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(`${base}#${n}`, key);
  }
  return out;
}

export function diffBoard(input: {
  baseBody: string;
  spots: Spot[];
  newBody: string;
  /** Live ids whose HTML carries the id (their id attribute is compared like any other). */
  ownIds: Set<string>;
  baseCss: string;
  newBaseCss: string;
  editsCss: string;
  newEditsCss: string;
}): BoardDiff {
  const base = body(input.baseBody);
  const next = body(input.newBody);
  const ids = mapBase(base, input.spots);
  const leaf = new Set(input.spots.filter((s) => s.kind === "leaf").map((s) => s.id));
  const ops: MergeOp[] = [];
  const matched = new Map<DomNode, DomNode>();
  const removed: DomElement[] = [];
  type Ins = { node: DomNode; parent: string; agentParent: DomNode; j: number; after: () => string | null };
  const inserted: Ins[] = [];
  const moves = new Set<DomNode>();

  const compare = (b: DomNode, a: DomNode) => {
    matched.set(b, a);
    const id = ids.get(b)!;
    if (isText(b)) {
      if (ws(b.textContent ?? "") !== ws(a.textContent ?? ""))
        ops.push({ kind: "text", id, content: a.textContent ?? "" });
      return;
    }
    const [be, ae] = [asEl(b), asEl(a)];
    const skip = (n: string) => n === "class" || n === KEEP_ATTR || (n === "id" && !input.ownIds.has(id));
    const ba = new Map(
      Array.from(be.attributes)
        .filter((x) => !skip(x.name))
        .map((x) => [x.name, x.value]),
    );
    const aa = new Map(
      Array.from(ae.attributes)
        .filter((x) => !skip(x.name))
        .map((x) => [x.name, x.value]),
    );
    for (const [k, v] of aa) if (ba.get(k) !== v) ops.push({ kind: "attr", id, name: k, value: v });
    for (const k of ba.keys()) if (!aa.has(k)) ops.push({ kind: "attr", id, name: k, value: null });
    const bc = classList(be);
    const ac = classList(ae);
    const add = ac.filter((c) => !bc.includes(c));
    const remove = bc.filter((c) => !ac.includes(c));
    if (add.length || remove.length) ops.push({ kind: "classes", id, add, remove });
    if (leaf.has(id)) {
      if (norm(be.innerHTML) !== norm(ae.innerHTML))
        ops.push({ kind: "html", id, base: be.innerHTML, html: ae.innerHTML.trim() });
      return;
    }
    align(be, ae, id);
  };

  /** The nearest earlier sibling of new child j that maps to a live node (resolved once moves are known). */
  const anchor = (A: DomNode[], j: number) => () => {
    for (let k = j - 1; k >= 0; k--) {
      for (const [bn, an] of matched) if (an === A[k]) return ids.get(bn) ?? null;
    }
    return null;
  };

  const align = (b: DomNode, a: DomNode, parentId: string) => {
    const B = items(b);
    const A = items(a);
    // LCS on kind (tag + classes, or text) where the content is also alike (else card 1 would pair with card 3).
    const eq = (i: number, j: number) => sig(B[i]) === sig(A[j]) && similar(B[i], A[j]) >= 0.6;
    const dp = Array.from({ length: B.length + 1 }, () => new Array<number>(A.length + 1).fill(0));
    for (let i = B.length - 1; i >= 0; i--)
      for (let j = A.length - 1; j >= 0; j--)
        dp[i][j] = eq(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const pairs: [number, number][] = [];
    for (let i = 0, j = 0; i < B.length && j < A.length;) {
      if (eq(i, j)) pairs.push([i++, j++]);
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    const bUsed = new Set(pairs.map(([i]) => i));
    const aUsed = new Set(pairs.map(([, j]) => j));
    // Fuzzy pass: the same tag (or both text) and alike content, for elements whose classes changed.
    for (let i = 0; i < B.length; i++) {
      if (bUsed.has(i)) continue;
      let best = -1;
      let score = 0.6;
      for (let j = 0; j < A.length; j++) {
        if (aUsed.has(j)) continue;
        const sc = similar(B[i], A[j]);
        if (sc > score) [best, score] = [j, sc];
      }
      if (best >= 0) {
        pairs.push([i, best]);
        bUsed.add(i);
        aUsed.add(best);
      }
    }
    for (const [i, j] of pairs) compare(B[i], A[j]);
    // Matched children whose order changed: the longest run in the same order stays, the rest move.
    const keep = new Set(longestIncreasing([...pairs].sort((x, y) => x[0] - y[0]).map(([, j]) => j)));
    for (const [i, j] of [...pairs].sort((x, y) => x[1] - y[1])) {
      if (!keep.has(j)) ops.push({ kind: "move", id: ids.get(B[i])!, parent: parentId, after: anchor(A, j)() });
    }
    for (let i = 0; i < B.length; i++) {
      if (bUsed.has(i)) continue;
      if (isText(B[i])) ops.push({ kind: "remove", id: ids.get(B[i])!, keep: [] });
      else removed.push(asEl(B[i]));
    }
    for (let j = 0; j < A.length; j++) {
      if (!aUsed.has(j)) inserted.push({ node: A[j], parent: parentId, agentParent: a, j, after: anchor(A, j) });
    }
  };

  align(base, next, BOARD_ROOT);

  /** Descendants of a replaced element found again inside new elements: kept by identity. */
  const keepInside = (r: DomElement): string[] => {
    const kept: string[] = [];
    const walk = (e: DomElement) => {
      for (const d of Array.from(e.children)) {
        let found: DomElement | null = null;
        for (const ins of inserted) {
          if (isText(ins.node) || moves.has(ins.node)) continue;
          for (const cand of Array.from(asEl(ins.node).querySelectorAll("*"))) {
            if (moves.has(cand) || cand.closest(`[${KEEP_ATTR}]`) || cand.localName !== d.localName) continue;
            if (norm(cand.outerHTML) === norm(d.outerHTML) || (sig(cand) === sig(d) && similar(d, cand) >= 0.8)) {
              found = cand;
              break;
            }
          }
          if (found) break;
        }
        const did = ids.get(d);
        if (found && did) {
          moves.add(found);
          found.setAttribute(KEEP_ATTR, did);
          kept.push(did);
          compare(d, found);
        } else walk(d);
      }
    };
    if (!leaf.has(ids.get(r)!)) walk(r);
    return kept;
  };

  // Moves across the board: removed in one place, found (nearly the same) in another; inside a new element (a
  // wrapper) a kept placeholder.
  for (const r of removed) {
    let best: { el: DomElement; top?: Ins } | null = null;
    let score = 0.8;
    for (const ins of inserted) {
      if (isText(ins.node)) continue;
      const top = asEl(ins.node);
      for (const cand of [top, ...Array.from(top.querySelectorAll("*"))]) {
        if (cand.localName !== r.localName || moves.has(cand) || cand.closest(`[${KEEP_ATTR}]`)) continue;
        const sc = norm(cand.outerHTML) === norm(r.outerHTML) ? 1 : sig(cand) === sig(r) ? similar(r, cand) : 0;
        if (sc >= score) [best, score] = [{ el: cand, top: cand === top ? ins : undefined }, sc];
      }
    }
    if (!best) {
      ops.push({ kind: "remove", id: ids.get(r)!, keep: keepInside(r) });
      continue;
    }
    moves.add(best.el);
    if (best.top) ops.push({ kind: "move", id: ids.get(r)!, parent: best.top.parent, after: best.top.after() });
    else best.el.setAttribute(KEEP_ATTR, ids.get(r)!);
    compare(r, best.el);
  }
  // New siblings next to each other go in as one block, in order, after the nearest sibling that exists.
  const fresh = inserted.filter((x) => !moves.has(x.node));
  for (let k = 0; k < fresh.length;) {
    const first = fresh[k];
    let html = "";
    let m = k;
    while (m < fresh.length && fresh[m].agentParent === first.agentParent && fresh[m].j === first.j + (m - k)) {
      const n = fresh[m].node;
      html += isText(n)
        ? (n.textContent ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        : asEl(n).outerHTML;
      m++;
    }
    ops.push({ kind: "insert", parent: first.parent, after: first.after(), html });
    k = m;
  }

  // CSS, per layer: rules by selector + at-rule + occurrence, property by property.
  const cssDiff = (before: string, after: string) => {
    const b = new Map(cssRules(before).map((r) => [r.key, r]));
    for (const r of cssRules(after)) {
      const old = b.get(r.key);
      if (!old) {
        ops.push({ kind: "css-add", selector: r.selector, at: r.at, props: r.props });
        continue;
      }
      const om = new Map(old.props);
      const set = r.props.filter(([k, v]) => om.get(k) !== v);
      const drop = old.props.map(([k]) => k).filter((k) => !r.props.some(([x]) => x === k));
      if (set.length || drop.length) ops.push({ kind: "css", key: r.key, set, drop });
      b.delete(r.key);
    }
    for (const k of b.keys()) ops.push({ kind: "css-remove", key: k });
  };
  // The edits layer is rules in the live copy (by rule and property); the base layer is one stylesheet, replaced.
  cssDiff(input.editsCss, input.newEditsCss);
  if (ws(input.baseCss) !== ws(input.newBaseCss)) ops.push({ kind: "base", css: input.newBaseCss });

  const baseEls = [...ids.entries()].filter(([n]) => n.nodeType === 1).length;
  const gone = ops.filter((o) => o.kind === "remove").length;
  return { ops, baseElements: baseEls, kept: baseEls - gone };
}

/** A new rule's live entry from CSS (the server has no GrapesJS): the shape GrapesJS gives the same rule. */
function putRule(maps: BoardMaps, selector: string, at: string, props: [string, string][]): void {
  const simple = /^([.#][A-Za-z_][\w-]*)+$/.test(selector.trim());
  const sels = simple ? (selector.trim().match(/[.#][A-Za-z_][\w-]*/g) ?? []) : [];
  const media = /^@media\s+(.*)$/.exec(at);
  const def: Record<string, unknown> = simple ? { selectors: sels } : { selectors: [], selectorsAdd: selector.trim() };
  if (media) Object.assign(def, { mediaText: media[1], atRuleType: "media" });
  const atRule = media ? `@media ${media[1]}` : at;
  const sel = selector.trim();
  const base = `${sel}@@${atRule}@@0`;
  let n = 0;
  for (const k of maps.rules.keys()) if (k.startsWith(`${base}#`)) n++;
  const key = `${base}#${n}`;
  const y = new Y.Map<unknown>();
  maps.rules.set(key, y);
  y.set(R.def, JSON.stringify(def));
  y.set(R.sel, sel);
  y.set(R.selNoAdd, simple ? sel : "");
  y.set(R.names, JSON.stringify(sels));
  y.set(R.atRule, atRule);
  y.set(R.single, false);
  y.set(R.add, !simple);
  y.set(R.nested, false);
  y.set(R.important, "false");
  y.set(R.singleId, sels.length === 1 && sels[0].startsWith("#") ? sels[0].slice(1) : null);
  const style = new Y.Map<string>();
  const order = new Y.Array<string>();
  y.set(R.style, style);
  y.set(R.props, order);
  for (const [k, v] of props) {
    style.set(k, v);
    order.push([k]);
  }
  maps.ruleOrder.push([key]);
}

/**
 * Applies a board's changes to a live copy, in the caller's transaction. New elements are created with `newId`
 * (GrapesJS-style ids: `i` + random); elements the new version kept by identity (KEEP_ATTR) take their placeholder's
 * place, so they keep their id and everything people did to them.
 */
export function applyBoardMerge(maps: BoardMaps, ops: MergeOp[], newId: () => string): void {
  const { nodes, rules, ruleOrder, meta } = maps;
  const parentOf = (id: string): [Y.Array<string>, number] | null => {
    for (const [, n] of nodes) {
      const ch = n.get(F.children) as Y.Array<string> | undefined;
      const i = ch?.toArray().indexOf(id) ?? -1;
      if (ch && i >= 0) return [ch, i];
    }
    return null;
  };
  const detach = (id: string) => {
    const at = parentOf(id);
    if (at) at[0].delete(at[1], 1);
  };
  const dropTree = (id: string, keep: Set<string>) => {
    if (keep.has(id)) return;
    const n = nodes.get(id);
    for (const c of (n?.get(F.children) as Y.Array<string> | undefined)?.toArray() ?? []) dropTree(c, keep);
    nodes.delete(id);
  };
  const place = (parent: string, after: string | null, ids: string[]) => {
    const ch = nodes.get(parent)?.get(F.children) as Y.Array<string> | undefined;
    if (!ch) return;
    const i = after ? ch.toArray().indexOf(after) : -1;
    // An anchor someone removed meanwhile: the end of the parent.
    ch.insert(after && i < 0 ? ch.length : i + 1, ids);
  };
  // Rules by their place in the stylesheet as it was before these changes (removals and additions shift it).
  const byPlace = ruleOccurrences(maps);
  const ruleKey = (k: string) => byPlace.get(k);
  const kept = new Set<string>();

  for (const op of ops) {
    if (op.kind === "attr") {
      const n = nodes.get(op.id);
      const attrs = n?.get(F.attrs) as Y.Map<unknown> | undefined;
      const keys = n?.get(F.attrKeys) as Y.Array<string> | undefined;
      if (!attrs || !keys) continue;
      if (op.value === null) {
        attrs.delete(op.name);
        const i = keys.toArray().indexOf(op.name);
        if (i >= 0) keys.delete(i, 1);
      } else {
        if (!attrs.has(op.name)) keys.push([op.name]);
        attrs.set(op.name, op.value);
      }
    } else if (op.kind === "classes") {
      const n = nodes.get(op.id);
      if (!n) continue;
      const now = (typeof n.get(F.classes) === "string" ? (n.get(F.classes) as string) : "").split(" ").filter(Boolean);
      n.set(
        F.classes,
        [...now.filter((c) => !op.remove.includes(c)), ...op.add.filter((c) => !now.includes(c))].join(" "),
      );
    } else if (op.kind === "html") {
      const n = nodes.get(op.id);
      // Word by word: the new version's change applied to the box as it is now.
      if (n)
        n.set(F.html, merge3(op.base, typeof n.get(F.html) === "string" ? (n.get(F.html) as string) : "", op.html));
    } else if (op.kind === "text") {
      nodes.get(op.id)?.set(F.content, op.content);
    } else if (op.kind === "remove") {
      // Kept parts are taken out first and placed again by the insert that carries their placeholder.
      for (const k of op.keep) {
        detach(k);
        kept.add(k);
      }
      detach(op.id);
      dropTree(op.id, new Set(op.keep));
    } else if (op.kind === "move") {
      if (!nodes.has(op.id)) continue;
      detach(op.id);
      place(op.parent, op.after, [op.id]);
    } else if (op.kind === "insert") {
      const parsed = nodesFromHtml(op.html, newId);
      // Placeholders of kept elements: the existing element takes the placeholder's place.
      const swap = new Map<string, string>();
      for (const [pid, init] of parsed.nodes) {
        const keep = init.attrs?.find(([k]) => k === KEEP_ATTR)?.[1];
        if (typeof keep === "string" && nodes.has(keep)) swap.set(pid, keep);
      }
      const drop = (pid: string) => {
        const init = parsed.nodes.get(pid);
        for (const c of init?.children ?? []) drop(c);
        parsed.nodes.delete(pid);
      };
      for (const [pid, keep] of swap) {
        for (const init of parsed.nodes.values()) {
          if (init.children) init.children = init.children.map((c) => (c === pid ? keep : c));
        }
        parsed.roots = parsed.roots.map((r) => (r === pid ? keep : r));
        drop(pid);
        if (!kept.has(keep)) detach(keep);
        kept.delete(keep);
      }
      putNodes(maps, parsed);
      place(op.parent, op.after, parsed.roots);
    } else if (op.kind === "css") {
      const key = ruleKey(op.key);
      const y = key ? rules.get(key) : undefined;
      if (!y) continue;
      const style = y.get(R.style) as Y.Map<string>;
      const props = y.get(R.props) as Y.Array<string>;
      for (const [k, v] of op.set) {
        if (!style.has(k)) props.push([k]);
        style.set(k, v);
      }
      for (const k of op.drop) {
        style.delete(k);
        const i = props.toArray().indexOf(k);
        if (i >= 0) props.delete(i, 1);
      }
    } else if (op.kind === "css-remove") {
      const key = ruleKey(op.key);
      if (!key) continue;
      rules.delete(key);
      const order = ruleOrder.toArray();
      for (let i = order.length - 1; i >= 0; i--) if (order[i] === key) ruleOrder.delete(i, 1);
    } else if (op.kind === "css-add") {
      putRule(maps, op.selector, op.at, op.props);
    } else if (op.kind === "base") {
      meta.set("baseCss", op.css);
    }
  }
  // A kept element whose placeholder never came (it was not in the new version after all) goes.
  for (const k of kept) dropTree(k, new Set());
}

/** Word-level three-way merge: both sides' changes to `base`; where they overlap, `theirs` (the new version) wins. */
export function merge3(base: string, mine: string, theirs: string): string {
  if (mine === base) return theirs;
  if (theirs === base || theirs === mine) return mine;
  const tok = (x: string) => x.match(/<[^>]+>|[^<\s]+|\s+/g) ?? [];
  const [b, m, t] = [tok(base), tok(mine), tok(theirs)];
  type Hunk = { a0: number; a1: number; with: string[]; from: "m" | "t" };
  const hunks = (x: string[], from: "m" | "t"): Hunk[] => {
    const dp = Array.from({ length: b.length + 1 }, () => new Array<number>(x.length + 1).fill(0));
    for (let i = b.length - 1; i >= 0; i--)
      for (let j = x.length - 1; j >= 0; j--)
        dp[i][j] = b[i] === x[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out: Hunk[] = [];
    let i = 0;
    let j = 0;
    while (i < b.length || j < x.length) {
      if (i < b.length && j < x.length && b[i] === x[j]) {
        i++;
        j++;
        continue;
      }
      const h: Hunk = { a0: i, a1: i, with: [], from };
      while ((i < b.length || j < x.length) && !(i < b.length && j < x.length && b[i] === x[j])) {
        if (j < x.length && (i >= b.length || dp[i][j + 1] >= dp[i + 1][j])) h.with.push(x[j++]);
        else i++;
      }
      h.a1 = i;
      out.push(h);
    }
    return out;
  };
  const ht = hunks(t, "t");
  const overlaps = (x: Hunk, y: Hunk) =>
    (x.a0 < y.a1 && y.a0 < x.a1) ||
    x.a0 === y.a0 ||
    (x.a0 === x.a1 && x.a0 > y.a0 && x.a0 < y.a1) ||
    (y.a0 === y.a1 && y.a0 > x.a0 && y.a0 < x.a1);
  const hm = hunks(m, "m").filter((h) => !ht.some((x) => overlaps(h, x)));
  const all = [...ht, ...hm].sort((x, y) => x.a0 - y.a0 || (x.from === "m" ? -1 : 1));
  let out = "";
  let pos = 0;
  for (const h of all) {
    out += b.slice(pos, h.a0).join("") + h.with.join("");
    pos = Math.max(pos, h.a1);
  }
  return out + b.slice(pos).join("");
}

/** A board file's parts for merging (read only, on the server). */
export function fileParts(text: string): { bodyHtml: string; baseCss: string; editsCss: string } {
  const dom = new JSDOM(text, { virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    const styles = Array.from(doc.querySelectorAll("style"));
    const base = styles.filter((st) => st.hasAttribute("data-wardby-base"));
    const edits = styles.filter((st) => st.hasAttribute("data-wardby-edits"));
    const baseCss = (base.length ? base : styles.filter((st) => !st.hasAttribute("data-wardby-edits")))
      .map((st) => st.textContent ?? "")
      .join("\n");
    const editsCss = edits.map((st) => st.textContent ?? "").join("");
    for (const st of styles) st.remove();
    return { bodyHtml: doc.body.innerHTML.replace(/\s+$/, ""), baseCss, editsCss };
  } finally {
    dom.window.close();
  }
}

/**
 * A board's changes from its base file to its new file, by live element id. The stored base file is exactly what
 * the agent read (in the sanitizer's form): when its elements line up with the live copy's version map, the
 * comparison is with it, so the sanitizer's own changes are never taken for the agent's. Otherwise the live copy's
 * own writing is the base.
 */
export function boardOps(maps: BoardMaps, beforeFile: string | undefined, nextFile: string): MergeOp[] {
  const written = writeBoard(maps);
  const now = fileParts(nextFile);
  const ownIds = new Set([...maps.nodes.entries()].filter(([, n]) => n.get(F.ownId)).map(([id]) => id));
  const from = (b: { bodyHtml: string; baseCss: string; editsCss: string }) =>
    diffBoard({
      baseBody: b.bodyHtml,
      spots: written.spots,
      newBody: now.bodyHtml,
      ownIds,
      baseCss: b.baseCss,
      newBaseCss: now.baseCss,
      editsCss: b.editsCss,
      newEditsCss: now.editsCss,
    }).ops;
  if (typeof beforeFile === "string") {
    try {
      return from(fileParts(beforeFile));
    } catch {
      /* the stored file does not line up with the version map: the live copy's writing */
    }
  }
  return from({ bodyHtml: written.body, baseCss: written.baseCss ?? "", editsCss: written.css });
}
