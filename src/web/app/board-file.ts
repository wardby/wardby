/**
 * A stored board file (board format v1, ruling D7) split into the parts the design editor needs, and
 * written back in the same layout sanitize.ts produces: the board's original CSS stays in
 * <style data-wardby-base> unchanged, and the editor's CSS goes in <style data-wardby-edits>. The
 * server sanitises and normalises every saved board again; this file never decides what is safe.
 *
 * Parsing uses DOMParser on a "text/html" string: the result is an inert document (no script runs,
 * nothing loads), and only text and attribute values are read from it.
 */
import { BODY_ATTRS, LANG, serializeBoardFile, type BoardParts } from "../../core/documents/boards/board-file-text.js";
import { escapeHtml } from "../../core/html-escape.js";

// Writing a file from its parts is shared with the server's live writer.
export { serializeBoardFile, type BoardParts } from "../../core/documents/boards/board-file-text.js";

export function parseBoardFile(html: string): BoardParts {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const styles = Array.from(doc.querySelectorAll("style"));
  const marked = styles.filter((s) => s.hasAttribute("data-wardby-base"));
  const edits = styles.filter((s) => s.hasAttribute("data-wardby-edits"));
  const base = marked.length ? marked : styles.filter((s) => !s.hasAttribute("data-wardby-edits"));
  // The styles are read, then removed so none counts as body content.
  const baseCss = base.map((s) => s.textContent ?? "").join("\n");
  const editsCss = edits.length ? edits.map((s) => s.textContent ?? "").join("") : null;
  for (const s of styles) s.remove();
  // GrapesJS reads data-gjs-* attributes as component properties (type, name, editable, script, ...),
  // and puts some of them, such as the name, in its own panels as markup. A board never sets them.
  for (const el of [doc.body, ...Array.from(doc.body.querySelectorAll("*"))]) {
    for (const a of Array.from(el.attributes)) if (/^data-gjs-/i.test(a.name)) el.removeAttribute(a.name);
  }
  const bodyAttrs: Record<string, string> = {};
  for (const a of BODY_ATTRS) {
    const v = doc.body.getAttribute(a);
    if (v !== null) bodyAttrs[a] = v;
  }
  const lang = doc.documentElement.getAttribute("lang") ?? "";
  return {
    lang: LANG.test(lang) ? lang : "en",
    title: (doc.title || "").trim(),
    baseCss,
    editsCss,
    // The newlines after </body> and </html> parse back into the body: trailing whitespace is dropped.
    bodyHtml: doc.body.innerHTML.replace(/\s+$/, ""),
    bodyAttrs,
  };
}

/** A design's manifest.json (board format v1; the server's format.ts is the authority). */
export interface BoardEntry {
  id: string;
  name: string;
  file: string;
  width: number;
}
export interface Manifest {
  title: string;
  boards: BoardEntry[];
}

export const boardPath = (id: string): string => `boards/${id}.html`;

/** manifest.json as the server normalises it. */
export const serializeManifest = (manifest: Manifest): string =>
  `${JSON.stringify(
    {
      title: manifest.title,
      boards: manifest.boards.map((b) => ({ id: b.id, name: b.name, file: b.file, width: b.width })),
    },
    null,
    2,
  )}\n`;

/** A board id from a name: lowercase `[a-z0-9-]`, made unique against `taken` with -2, -3, … */
export function boardIdFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34)
      .replace(/-+$/, "") || "board";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * A new board: the first board's CSS and <header> (so the shared navigation carries over), then a
 * heading with the board's name. With no first board, an empty page with the heading.
 */
export function newBoardFile(first: BoardParts | null, name: string): string {
  let header = "";
  if (first) {
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${first.bodyHtml}`, "text/html");
    header = doc.body.querySelector(":scope > header")?.outerHTML ?? "";
  }
  const parts: BoardParts = {
    lang: first?.lang ?? "en",
    title: name,
    baseCss: first?.baseCss ?? "",
    editsCss: null,
    bodyHtml: "",
    bodyAttrs: first ? { ...first.bodyAttrs } : {},
  };
  return serializeBoardFile(parts, first?.editsCss ?? "", `${header}<main><h1>${escapeHtml(name)}</h1></main>`);
}
