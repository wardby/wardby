/**
 * Board HTML turned into live-copy elements on the server (spec decision 5): the server creates the elements an
 * agent's version adds, with no browser and no GrapesJS, so it follows GrapesJS 0.23.9's own parser rules
 * (`ParserHtml.parseNode` / `parseNodes` and the core types' `isComponent`):
 *
 * - Types by tag: `img` image, `svg` svg (everything inside it svg-in), `table` / `thead` / `tbody` / `tfoot`,
 *   `tr` row, `td` / `th` cell, `a` link, `label`, `video` (and an `iframe` embedding YouTube or Vimeo),
 *   `iframe` on maps.google.com map, any other `iframe` iframe, else the plain type (GrapesJS's empty type).
 * - An element whose only child is text is a text box; so is an untyped element whose children are all text,
 *   comments, text boxes or the inline tags `br b i u a ul ol`, with some text among them.
 * - Blank text between elements is dropped when it holds a newline or is a first or last child (a single space
 *   is kept); adjacent text merges.
 * - Attributes keep their order; `class` becomes classes, `style` a rule on the element's id, `contenteditable`
 *   is dropped, an empty value of a real boolean attribute becomes `true`.
 * - Text boxes (and links and labels, which extend them) are leaves: their inner HTML is written the way GrapesJS writes it.
 *
 * The parity test (parity.browser.test.ts) checks all of this against GrapesJS's own parse on every fixture board.
 */
import { JSDOM, type DomElement, type DomNode } from "jsdom";
import * as Y from "yjs";
import { F, R, type BoardMaps } from "./model.js";

export interface NodeInit {
  type: string;
  tag?: string;
  void?: boolean;
  ownId?: boolean;
  classes?: string;
  attrs?: [string, string | boolean][];
  /** A text box: its inner HTML as GrapesJS writes it. */
  html?: string;
  /** A text box: class and id names inside it. */
  names?: string[];
  content?: string;
  children?: string[];
}

/** A rule GrapesJS makes from an inline `style`: on the element's id, its declarations in order. */
export interface InlineRule {
  id: string;
  props: [string, string][];
}

export interface ParsedElements {
  roots: string[];
  nodes: Map<string, NodeInit>;
  rules: InlineRule[];
}

/** Parsed like GrapesJS's ParserHtml, before ids and leaves are settled. */
interface Model {
  type?: string;
  tag?: string;
  content?: string;
  attrs: [string, string | boolean][];
  classes: string[];
  style: [string, string][];
  ownId?: string;
  isVoid?: boolean;
  children: Model[];
}

const { window } = new JSDOM("");
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const TEXT_TYPES = new Set(["text", "textnode", "comment"]);
const TEXT_TAGS = new Set(["br", "b", "i", "u", "a", "ul", "ol"]);
/** Types that are text boxes: text and the ones that extend it (link, label). */
const LEAF_TYPES = new Set(["text", "link", "label"]);

function typeByTag(el: DomElement, inSvg: boolean): string | undefined {
  if (inSvg) return "svg-in";
  const tag = el.localName;
  const src = el.getAttribute("src") ?? "";
  switch (tag) {
    case "img":
      return "image";
    case "svg":
      return "svg";
    case "table":
    case "thead":
    case "tbody":
    case "tfoot":
      return tag;
    case "tr":
      return "row";
    case "td":
    case "th":
      return "cell";
    case "a":
      return "link";
    case "label":
      return "label";
    case "video":
      return "video";
    case "iframe":
      if (/maps\.google\.com/.test(src)) return "map";
      if (/youtube\.com\/embed|youtube-nocookie\.com\/embed|player\.vimeo\.com\/video/.test(src)) return "video";
      return "iframe";
    default:
      return undefined;
  }
}

function parseStyle(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of text.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const prop = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (prop && value) out.push([prop, value]);
  }
  return out;
}

function parseNode(node: DomNode, inSvg: boolean): Model | null {
  if (node.nodeType === 3)
    return { type: "textnode", content: node.textContent ?? "", attrs: [], classes: [], style: [], children: [] };
  if (node.nodeType === 8)
    return { type: "comment", content: node.textContent ?? "", attrs: [], classes: [], style: [], children: [] };
  if (node.nodeType !== 1) return null;
  const el = node as DomElement;
  const model: Model = {
    type: typeByTag(el, inSvg),
    tag: el.namespaceURI === "http://www.w3.org/1999/xhtml" ? el.localName : el.tagName,
    attrs: [],
    classes: [],
    style: [],
    children: [],
  };
  for (const a of Array.from(el.attributes)) {
    if (a.name === "style") model.style = parseStyle(a.value);
    else if (a.name === "class") model.classes = a.value.split(/\s+/).filter(Boolean);
    else if (a.name === "contenteditable" || a.name.startsWith("data-gjs-")) continue;
    else {
      const asBool = a.value === "" && (el as unknown as Record<string, unknown>)[a.name] === true;
      model.attrs.push([a.name, asBool ? true : a.value]);
      if (a.name === "id") model.ownId = a.value;
    }
  }
  const kids = Array.from(el.childNodes);
  if (kids.length === 1 && kids[0].nodeType === 3) {
    model.type ??= "text";
    model.children = [
      { type: "textnode", content: kids[0].textContent ?? "", attrs: [], classes: [], style: [], children: [] },
    ];
  } else if (kids.length) {
    model.children = parseNodes(el, inSvg || model.type === "svg");
  }
  if (!model.type && model.children.length) {
    let allText = true;
    let foundText = false;
    for (const c of model.children) {
      if (!TEXT_TYPES.has(c.type ?? "") && !TEXT_TAGS.has(c.tag ?? "")) {
        allText = false;
        break;
      }
      if (c.type === "textnode") foundText = true;
    }
    if (allText && foundText) model.type = "text";
  }
  // GrapesJS's plain component has the empty type.
  model.type ??= "";
  model.isVoid = !model.children.length && VOID.has(model.tag ?? "");
  return model;
}

function parseNodes(parent: DomNode, inSvg: boolean): Model[] {
  const out: Model[] = [];
  const kids = Array.from(parent.childNodes);
  kids.forEach((node, i) => {
    const model = parseNode(node, inSvg);
    if (!model) return;
    if (model.type === "textnode") {
      const prev = out[out.length - 1];
      if (prev?.type === "textnode") {
        prev.content = (prev.content ?? "") + (model.content ?? "");
        return;
      }
      const content = node.textContent ?? "";
      const firstOrLast = i === 0 || i === kids.length - 1;
      if (content !== " " && !content.trim() && (firstOrLast || content.includes("\n"))) return;
    }
    out.push(model);
  });
  return out;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

export function nodesFromHtml(
  html: string,
  newId: () => string,
  /**
   * The elements go inside an `<svg>` (a merge inserting into one): they are parsed inside an `<svg>`, so they are
   * SVG elements typed svg-in, as GrapesJS gives them. Parsed on their own, a `<path>` would be an unknown HTML
   * element, which a canvas creates in the HTML namespace and never draws.
   */
  opts: { inSvg?: boolean } = {},
): ParsedElements {
  const outer = window.document.createElement("body");
  outer.innerHTML = opts.inSvg ? `<svg>${html}</svg>` : html;
  const body = opts.inSvg ? (outer.children[0] ?? outer) : outer;
  const nodes = new Map<string, NodeInit>();
  const rules: InlineRule[] = [];

  /** An element's id: its own (from the HTML), else a new one when it needs one. */
  const idOf = (m: Model) => m.ownId ?? newId();

  /** GrapesJS's toHTML for what sits inside a text box (ids only where a rule needs them). */
  const print = (m: Model, names: Set<string>): string => {
    if (m.type === "textnode") return escText(m.content ?? "");
    if (m.type === "comment") return `<!--${m.content ?? ""}-->`;
    for (const c of m.classes) names.add(`.${c}`);
    const out: string[] = [];
    for (const [k, v] of m.attrs) {
      if (typeof v === "boolean") {
        if (v) out.push(k);
      } else out.push(`${k}="${escAttr(v)}"`);
    }
    if (m.classes.length) out.push(`class="${escAttr(m.classes.join(" "))}"`);
    if (m.style.length && !m.ownId) {
      const id = newId();
      rules.push({ id, props: m.style });
      names.add(`#${id}`);
      out.push(`id="${escAttr(id)}"`);
    } else if (m.style.length && m.ownId) {
      rules.push({ id: m.ownId, props: m.style });
      names.add(`#${m.ownId}`);
    }
    const inner = m.children.map((c) => print(c, names)).join("");
    const attrs = out.length ? ` ${out.join(" ")}` : "";
    if (!inner && m.isVoid) return `<${m.tag}${attrs}/>`;
    return `<${m.tag}${attrs}>${inner}</${m.tag}>`;
  };

  const put = (m: Model): string => {
    if (m.type === "textnode" || m.type === "comment") {
      const id = newId();
      nodes.set(id, { type: m.type, content: m.content ?? "" });
      return id;
    }
    const id = idOf(m);
    if (m.style.length) rules.push({ id, props: m.style });
    const init: NodeInit = {
      type: m.type ?? "",
      tag: m.tag,
      void: !!m.isVoid,
      ownId: m.ownId !== undefined,
      classes: m.classes.join(" "),
      attrs: m.attrs,
    };
    if (LEAF_TYPES.has(init.type)) {
      const names = new Set<string>();
      init.html = m.children.map((c) => print(c, names)).join("");
      init.names = [...names].sort();
    } else {
      init.children = m.children.map(put);
    }
    nodes.set(id, init);
    return id;
  };

  const roots = parseNodes(body, !!opts.inSvg).map(put);
  return { roots, nodes, rules };
}

/** Writes parsed elements into a board's live copy (and their inline-style rules, appended in order). */
export function putNodes(maps: BoardMaps, parsed: ParsedElements): void {
  for (const [id, init] of parsed.nodes) {
    const n = new Y.Map<unknown>();
    maps.nodes.set(id, n);
    n.set(F.type, init.type);
    if (init.type === "textnode" || init.type === "comment") {
      n.set(F.content, init.content ?? "");
      continue;
    }
    n.set(F.tag, init.tag ?? "div");
    n.set(F.void, !!init.void);
    n.set(F.ownId, !!init.ownId);
    n.set(F.classes, init.classes ?? "");
    const attrs = new Y.Map<unknown>();
    const keys = new Y.Array<string>();
    n.set(F.attrs, attrs);
    n.set(F.attrKeys, keys);
    for (const [k, v] of init.attrs ?? []) {
      attrs.set(k, v);
      keys.push([k]);
    }
    if (init.html !== undefined) {
      n.set(F.html, new Y.Text(init.html));
      n.set(F.names, JSON.stringify(init.names ?? []));
    } else {
      const ch = new Y.Array<string>();
      ch.push(init.children ?? []);
      n.set(F.children, ch);
    }
  }
  for (const r of parsed.rules) {
    const key = `#${r.id}@@@@0#0`;
    const y = new Y.Map<unknown>();
    maps.rules.set(key, y);
    y.set(R.def, JSON.stringify({ selectors: [`#${r.id}`] }));
    y.set(R.sel, `#${r.id}`);
    y.set(R.selNoAdd, `#${r.id}`);
    y.set(R.names, JSON.stringify([`#${r.id}`]));
    y.set(R.atRule, "");
    y.set(R.single, false);
    y.set(R.add, false);
    y.set(R.nested, false);
    y.set(R.important, "false");
    y.set(R.singleId, r.id);
    const style = new Y.Map<string>();
    const props = new Y.Array<string>();
    y.set(R.style, style);
    y.set(R.props, props);
    for (const [k, v] of r.props) {
      style.set(k, v);
      props.push([k]);
    }
    maps.ruleOrder.push([key]);
  }
}
