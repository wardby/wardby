/**
 * Board sanitiser (spec "Security": a real HTML sanitiser on write). A board is parsed with
 * jsdom (the HTML spec's parser), its <style> text is collected and checked with PostCSS
 * (css-check.ts), and the body goes through DOMPurify with one allow-list (PURIFY_CONFIG),
 * shared with sanitizeFragment. The output is a normalised document: a fixed head,
 * <style data-wardby-base> (and data-wardby-edits when the board had one), and the sanitised
 * body. Scripts, event handlers and javascript: URLs are removed and counted; external
 * references are reported as problems (the caller refuses the board). Problems are our own
 * fixed text: never a URL, path, tag or attribute the caller wrote.
 */
import createDOMPurify from "dompurify";
import { JSDOM, VirtualConsole, type DomElement, type DomNode, type DomParent } from "jsdom";
import { escapeHtml } from "../../html-escape.js";
import { checkCss, type CssProblem } from "./css-check.js";
import { BoardFormatError } from "./errors.js";

export interface RemovedCounts {
  scripts: number;
  handlers: number;
  jsUrls: number;
  other: number;
}

export interface SanitizedBoard {
  /** Normalised document (fixed head, base/edits styles, sanitised body). */
  html: string;
  title: string;
  baseCss: string;
  editsCss: string | null;
  removed: RemovedCounts;
  /** E.g. "external reference in img src": never a URL. Any problem means the board is refused. */
  problems: string[];
}

export interface SanitizedFragment {
  html: string;
  /**
   * `images`: in "drop" mode, the number of attributes removed for an external reference (an
   * img src, a style attribute or SVG attribute with an external url(), the src of a removed
   * iframe ...), not a count of elements. Always 0 in "refuse" mode.
   */
  removed: RemovedCounts & { images: number };
  problems: string[];
}

export interface FragmentOptions {
  /** "refuse": an external reference is a problem (boards). "drop": it is removed and counted. */
  images: "drop" | "refuse";
}

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Containers removed with everything inside them before DOMPurify runs, so their text is never
 * kept (DOMPurify keeps the content of a removed element by default).
 */
const REMOVE_SUBTREE = [
  "noscript",
  "template",
  "math",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "audio",
  "video",
  "select",
  "textarea",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "portal",
  "foreignObject",
];

/** The one allow-list for boards and fragments (ruling PF-M7). */
const PURIFY_CONFIG: PurifyConfig = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  FORBID_TAGS: [
    "script",
    "style",
    "link",
    "meta",
    "base",
    "form",
    "input",
    "button",
    "option",
    "optgroup",
    "source",
    "track",
    "animate",
    "animatemotion",
    "animatetransform",
    "set",
    "discard",
    "title",
    ...REMOVE_SUBTREE.map((t) => t.toLowerCase()),
  ],
  FORBID_ATTR: ["srcset", "action", "formaction", "ping", "background", "poster", "target", "xmlns:xlink"],
  ALLOW_DATA_ATTR: true,
  // DOMPurify tests every attribute that is not URI-safe against this, so it must also accept
  // plain values (width="10", fill="none"); only scheme-like values are limited to https:.
  ALLOWED_URI_REGEXP: /^(?:#|https:|data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  KEEP_CONTENT: true,
};

const NO_HOIST_ANCESTORS = ["svg", ...REMOVE_SUBTREE.filter((t) => t !== "foreignObject")].join(", ");
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i;
const SCRIPT_URL = /^(?:javascript|vbscript):/i;
/** What browsers ignore at the start of and inside a URL scheme. */
// eslint-disable-next-line no-control-regex -- the C0 controls are what a browser strips
const URL_WHITESPACE = /[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/g;
const LINK_TAGS = new Set(["a", "area"]);
const REFERENCE_ATTRS = new Set(["src", "href", "xlink:href", "data", "poster"]);
/** Element names a problem may use; any other element is "element". */
const NAMED_KINDS = new Set([
  "img",
  "image",
  "use",
  "feimage",
  "pattern",
  "lineargradient",
  "radialgradient",
  "textpath",
  "filter",
  "mpath",
  "iframe",
  "frame",
  "object",
  "embed",
  "audio",
  "video",
  "portal",
]);

/** The DOMPurify members used here, typed without the DOM lib (see src/types/jsdom.d.ts). */
interface PurifyConfig {
  USE_PROFILES: { html: boolean; svg: boolean; svgFilters: boolean };
  FORBID_TAGS: string[];
  FORBID_ATTR: string[];
  ALLOW_DATA_ATTR: boolean;
  ALLOWED_URI_REGEXP: RegExp;
  KEEP_CONTENT: boolean;
}
interface AttributeHookEvent {
  readonly attrName: string;
  readonly attrValue: string;
  keepAttr: boolean;
}
interface Purifier {
  sanitize(dirty: string, cfg: PurifyConfig): string;
  addHook(name: "uponSanitizeAttribute", hook: (node: DomElement, data: AttributeHookEvent) => void): void;
  readonly removed: ReadonlyArray<{ element?: DomNode }>;
}

/**
 * Every jsdom instance here gets a silent virtual console. jsdom's default console prints its own
 * errors to stderr, and those quote the input (an @import URL it could not parse, for one); board
 * text must never reach a log.
 */
const parse = (html: string) => new JSDOM(html, { virtualConsole: new VirtualConsole() });

/** Thrown when a defence-in-depth check finds what the sanitiser should already have removed. */
const finalCheckFailed = () => new BoardFormatError(["the board failed the final safety check"]);

const { window } = parse("");
const purify = (createDOMPurify as unknown as (root: unknown) => Purifier)(window);

interface State {
  removed: RemovedCounts & { images: number };
  problems: Set<string>;
  images: "drop" | "refuse";
}
let state: State | undefined;

const kindOf = (el: DomElement) => {
  const tag = el.localName.toLowerCase();
  return NAMED_KINDS.has(tag) ? tag : "element";
};
const isLocalRef = (value: string) => value === "" || value.startsWith("#") || DATA_IMAGE.test(value);

/** An external reference: a problem in refuse mode, a counted removal in drop mode. */
function externalReference(s: State, problem: string): void {
  if (s.images === "refuse") s.problems.add(problem);
  else s.removed.images += 1;
}

function cssProblemText(p: CssProblem, where: "a style sheet" | "a style attribute" | "an SVG attribute"): string {
  if (p === "import") return `@import in ${where}`;
  if (p === "expression") return `script-like CSS in ${where}`;
  if (p === "style_close") return `style text that closes the element in ${where}`;
  if (p === "malformed") return `a broken CSS string or url() in ${where}`;
  return `external url() in ${where}`;
}

function onAttribute(node: DomElement, data: AttributeHookEvent): void {
  const s = state;
  if (!s) return;
  const name = data.attrName.toLowerCase();
  const value = data.attrValue.trim();
  if (name.startsWith("on")) {
    s.removed.handlers += 1;
    data.keepAttr = false;
    return;
  }
  if (SCRIPT_URL.test(value.replace(URL_WHITESPACE, ""))) {
    s.removed.jsUrls += 1;
    data.keepAttr = false;
    return;
  }
  if (name === "style") {
    const problems = checkCss(value, { declarations: true });
    if (problems.length === 0) return;
    if (s.images === "refuse") for (const p of problems) s.problems.add(cssProblemText(p, "a style attribute"));
    else s.removed.images += 1;
    data.keepAttr = false;
    return;
  }
  const tag = node.localName.toLowerCase();
  if ((name === "href" || name === "xlink:href") && LINK_TAGS.has(tag)) {
    // Links may go to another board (#board:<id>), a fragment or an https:// page; others are dropped.
    if (!/^(?:#|https:\/\/)/i.test(value)) data.keepAttr = false;
    return;
  }
  if (REFERENCE_ATTRS.has(name)) {
    if (isLocalRef(value)) return;
    // Absolute, protocol-relative and relative references all load something from outside the board.
    externalReference(s, `external reference in ${kindOf(node)} ${name}`);
    data.keepAttr = false;
    return;
  }
  if (node.namespaceURI === SVG_NS && !/^(?:aria-|data-)/.test(name) && /url\s*\(|image-set|\\/i.test(value)) {
    // SVG presentation attributes (fill, filter, mask, clip-path, marker-*) take url() references.
    const problems = checkCss(`p:${value}`, { declarations: true });
    if (problems.length === 0) return;
    if (s.images === "refuse") for (const p of problems) s.problems.add(cssProblemText(p, "an SVG attribute"));
    else s.removed.images += 1;
    data.keepAttr = false;
  }
}

purify.addHook("uponSanitizeAttribute", onAttribute);

/** Element and attribute checks that never trust DOMPurify alone (defence in depth). */
function assertClean(root: DomParent): void {
  if (root.querySelector("script, base, link, iframe, frame, object, embed, form, noscript, template, math")) {
    throw finalCheckFailed();
  }
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.localName.toLowerCase() === "foreignobject") throw finalCheckFailed();
    for (const a of Array.from(el.attributes)) {
      if (a.name.toLowerCase().startsWith("on")) throw finalCheckFailed();
      if (SCRIPT_URL.test(a.value.replace(URL_WHITESPACE, ""))) throw finalCheckFailed();
    }
  }
}

/**
 * Sanitises the children of `container` (already parsed, scripts and styles still in it) and
 * returns the clean HTML. Shared by boards and fragments.
 */
function cleanContainer(container: DomElement, s: State): string {
  for (const script of Array.from(container.querySelectorAll("script"))) {
    s.removed.scripts += 1;
    script.remove();
  }
  for (const style of Array.from(container.querySelectorAll("style"))) {
    s.removed.other += 1;
    style.remove();
  }
  for (const el of Array.from(container.querySelectorAll("*"))) {
    if (!REMOVE_SUBTREE.includes(el.localName)) continue;
    if (!el.isConnected || !container.contains(el)) continue;
    // A frame or embed pointing elsewhere is an external reference as well as a removed element.
    for (const attr of REFERENCE_ATTRS) {
      const v = el.getAttribute(attr)?.trim();
      if (v && !isLocalRef(v) && !SCRIPT_URL.test(v.replace(URL_WHITESPACE, ""))) {
        externalReference(s, `external reference in ${kindOf(el)} ${attr}`);
      }
    }
    s.removed.other += 1;
    el.remove();
  }
  state = s;
  let clean: string;
  try {
    clean = purify.sanitize(container.innerHTML, PURIFY_CONFIG);
    for (const r of purify.removed) {
      if (r.element?.nodeType === 1) {
        if ((r.element as DomElement).localName === "script") s.removed.scripts += 1;
        else s.removed.other += 1;
      }
    }
  } finally {
    state = undefined;
  }
  const check = parse(`<!doctype html><body>${clean}`);
  try {
    assertClean(check.window.document);
    if (check.window.document.querySelector("style")) throw finalCheckFailed();
  } finally {
    check.window.close();
  }
  return clean;
}

const newState = (images: "drop" | "refuse"): State => ({
  removed: { scripts: 0, handlers: 0, jsUrls: 0, other: 0, images: 0 },
  problems: new Set(),
  images,
});

/**
 * Sanitises an HTML fragment with the board allow-list: no scripts, handlers, javascript: URLs,
 * style elements or embedded content. External references are refused or dropped per `images`.
 */
export function sanitizeFragment(html: string, opts: FragmentOptions): SanitizedFragment {
  const s = newState(opts.images);
  const dom = parse("<!doctype html><html><head></head><body></body></html>");
  try {
    const body = dom.window.document.body;
    body.innerHTML = html;
    const clean = cleanContainer(body, s);
    return { html: clean, removed: s.removed, problems: [...s.problems] };
  } finally {
    dom.window.close();
  }
}

export function sanitizeBoard(input: string): SanitizedBoard {
  const s = newState("refuse");
  const dom = parse(input);
  try {
    const doc = dom.window.document;

    for (const script of Array.from(doc.querySelectorAll("script"))) {
      s.removed.scripts += 1;
      script.remove();
    }
    for (const link of Array.from(doc.querySelectorAll("link"))) {
      if (link.hasAttribute("href")) {
        s.problems.add(
          /(^|\s)stylesheet(\s|$)/i.test(link.getAttribute("rel") ?? "")
            ? "external stylesheet link"
            : "external reference in link href",
        );
      } else s.removed.other += 1;
      link.remove();
    }

    // <style> text in document order, only from HTML-namespace style elements with no svg or
    // math ancestor (ruling PF-M3), nor one inside a container whose content is dropped
    // (noscript, template, iframe, ...); any other style element is removed and counted.
    let base = "";
    let edits: string | null = null;
    let sheetProblems = false;
    for (const style of Array.from(doc.querySelectorAll("style"))) {
      const hoist = style.namespaceURI === HTML_NS && !style.parentElement?.closest(NO_HOIST_ANCESTORS);
      const css = style.textContent ?? "";
      const isEdits = style.hasAttribute("data-wardby-edits");
      style.remove();
      if (!hoist) {
        s.removed.other += 1;
        continue;
      }
      const problems = checkCss(css);
      for (const p of problems) s.problems.add(cssProblemText(p, "a style sheet"));
      if (problems.length) {
        sheetProblems = true;
        continue;
      }
      if (isEdits) edits = (edits ?? "") + css;
      else base += (base ? "\n" : "") + css;
    }

    // Each element was checked alone above; the browser reads the joined text as one sheet, so
    // check base and edits again exactly as they are emitted (a comment opened in one element
    // and closed in the next would otherwise hide a url()).
    const joinedProblems = (sheet: string) => {
      const problems = checkCss(sheet);
      for (const p of problems) s.problems.add(cssProblemText(p, "a style sheet"));
      return problems.length > 0;
    };
    if (joinedProblems(base)) sheetProblems = true;
    if (edits !== null && joinedProblems(edits)) sheetProblems = true;
    if (sheetProblems) {
      // The board is refused; none of its CSS is carried in the result either.
      base = "";
      if (edits !== null) edits = "";
    }

    // The head is rebuilt; anything in it other than the title and plain meta tags is counted.
    for (const el of Array.from(doc.head.children)) {
      const tag = el.localName;
      if (tag === "title" || (tag === "meta" && !el.hasAttribute("http-equiv"))) continue;
      s.removed.other += 1;
    }

    const body = doc.body;
    for (const a of Array.from(body.attributes)) if (a.name.toLowerCase().startsWith("on")) s.removed.handlers += 1;
    // The body keeps class, id and a clean style; a style with problems is refused and not kept.
    const bodyStyle = body.getAttribute("style");
    const bodyStyleProblems = bodyStyle ? checkCss(bodyStyle, { declarations: true }) : [];
    for (const p of bodyStyleProblems) s.problems.add(cssProblemText(p, "a style attribute"));
    const bodyAttrs = ["class", "id", ...(bodyStyleProblems.length ? [] : ["style"])]
      .filter((a) => body.hasAttribute(a))
      .map((a) => ` ${a}="${escapeHtml(body.getAttribute(a)!)}"`)
      .join("");

    const clean = cleanContainer(body, s);

    const title = (doc.title || "").trim().slice(0, 200);
    const lang = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(doc.documentElement.lang)
      ? doc.documentElement.lang
      : "en";
    const html =
      `<!doctype html>\n<html lang="${lang}">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n` +
      `<style data-wardby-base>${base}</style>\n` +
      (edits !== null ? `<style data-wardby-edits>${edits}</style>\n` : "") +
      `</head>\n<body${bodyAttrs}>${clean}</body>\n</html>\n`;

    const check = parse(html);
    try {
      const d = check.window.document;
      assertClean(d);
      if (d.querySelectorAll("style").length !== (edits === null ? 1 : 2) || d.body.querySelector("style")) {
        throw finalCheckFailed();
      }
    } finally {
      check.window.close();
    }

    const { scripts, handlers, jsUrls, other } = s.removed;
    const removed = { scripts, handlers, jsUrls, other };
    return { html, title, baseCss: base, editsCss: edits, removed, problems: [...s.problems] };
  } finally {
    dom.window.close();
  }
}
