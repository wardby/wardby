/** Spec "Kind check": measure content and warn (never refuse) when it looks like the other kind. */
import { JSDOM, VirtualConsole } from "jsdom";
import type { VersionWarning } from "./warnings.js";

const PROSE = new Set([
  "p",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "td",
  "th",
  "pre",
  "dd",
  "dt",
  "figcaption",
]);
const PROSE_SELECTOR = Array.from(PROSE).join(",");
const LAYOUT = /display\s*:\s*(?:inline-)?(?:flex|grid)|grid-template|position\s*:\s*(?:absolute|fixed|sticky)/i;
const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();

const MAX_SELECTORS = 500;

/**
 * Selectors of the style rules in `css` that have a class, id or attribute part (at-rules skipped,
 * states and pseudo-elements dropped; bare type selectors and `*` ignored), deduped and capped.
 */
function ruleSelectors(css: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
    const head = m[1].trim();
    if (head.startsWith("@")) continue;
    for (const part of head.split(",")) {
      const sel = part
        .replace(
          /::?(?:before|after|first-line|first-letter|hover|focus|focus-visible|focus-within|active|visited|selection|placeholder)\b/g,
          "",
        )
        .trim();
      if (sel && /[.#[]/.test(sel)) out.push(sel);
    }
  }
  return Array.from(new Set(out)).slice(0, MAX_SELECTORS);
}

export interface HtmlMeasure {
  elements: number;
  styledShare: number;
  proseShare: number;
  layout: boolean;
}

export function measureHtml(html: string): HtmlMeasure {
  const dom = new JSDOM(html, { virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    const els = Array.from(doc.body.querySelectorAll("*")).filter((e) => e.tagName !== "STYLE");
    const sheet = Array.from(doc.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    const selectors = ruleSelectors(sheet);
    const ruled = (e: (typeof els)[number]) =>
      selectors.some((sel) => {
        try {
          return e.matches(sel);
        } catch {
          return false;
        }
      });
    // An element is styled when it carries class/style or a rule of the page's own stylesheet matches it.
    const styled = els.filter((e) => e.hasAttribute("class") || e.hasAttribute("style") || ruled(e)).length;
    const total = norm(doc.body.textContent).length;
    let prose = 0;
    for (const e of els) {
      // Count only the outermost prose element so nested ones (li > p) are not counted twice.
      if (e.closest(PROSE_SELECTOR) === e && !(e.parentElement && e.parentElement.closest(PROSE_SELECTOR))) {
        prose += norm(e.textContent).length;
      }
    }
    const css = [sheet, ...els.map((e) => e.getAttribute("style") ?? "")].join("\n");
    return {
      elements: els.length,
      styledShare: els.length ? styled / els.length : 0,
      proseShare: total ? Math.min(1, prose / total) : 0,
      layout: LAYOUT.test(css),
    };
  } finally {
    dom.window.close();
  }
}

export function kindWarnings(
  kind: "document" | "design",
  input: { markdown?: string; boards?: string[] },
): VersionWarning[] {
  if (kind === "design") {
    const boards = input.boards ?? [];
    const prosy =
      boards.length > 0 &&
      boards.every((b) => {
        const m = measureHtml(b);
        return m.styledShare < 0.1 && m.proseShare > 0.8;
      });
    return prosy
      ? [
          {
            kind: "kind",
            message:
              "These boards read like a document (little styling, mostly paragraphs). A Markdown document may suit them better.",
          },
        ]
      : [];
  }
  const md = input.markdown ?? "";
  if (!/<[a-z][\s\S]*>/i.test(md)) return [];
  return measureHtml(`<!doctype html><html><body>${md}</body></html>`).layout
    ? [
        {
          kind: "kind",
          message:
            "This Markdown contains page layout (HTML with flex, grid or positioned elements) that the editor would drop; save it as a design?",
        },
      ]
    : [];
}
