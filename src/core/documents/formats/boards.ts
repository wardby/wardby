import { JSDOM, VirtualConsole, type DomElement, type DomNode } from "jsdom";
import { redactExactSecretValues, withEscapedForms } from "../../secret-spans.js";
import {
  BOARD_MAX_BYTES,
  BoardFormatError,
  BRAND_MAX_BYTES,
  BRAND_PATH,
  DESIGN_VERSION_MAX_BYTES,
  MANIFEST_PATH,
  normalizeDesign,
  parseManifest,
  serializeManifest,
  type Manifest,
} from "../boards/format.js";
import { sanitizeBoard } from "../boards/sanitize.js";
import type { VersionContent } from "../content.js";
import {
  locateElement,
  MAX_ANCHOR_WORDS,
  parseElementAnchor,
  type ElementAnchor,
  type ElementLike,
} from "../element-anchors.js";
import { kindWarnings } from "../kind-check.js";
import type { DocumentFormat } from "./types.js";

const filesOf = (c: VersionContent): Record<string, string> => {
  if (c.format !== "boards-v1") throw new Error("document_format_mismatch");
  return c.files;
};

/** Rounds of "redact, then sanitise what redaction changed" before a board is refused. */
const MAX_REDACT_ROUNDS = 4;

const NBSP = "\u00a0";
/** How the serialisers on this path write a character: jsdom text, jsdom attributes (old and new rules), escapeHtml. */
const HTML_ESCAPES: ReadonlyArray<Readonly<Record<string, string>>> = [
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", [NBSP]: "&nbsp;" },
  { "&": "&amp;", '"': "&quot;", [NBSP]: "&nbsp;" },
  { "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;", [NBSP]: "&nbsp;" },
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" },
];

/** Each value plus the forms an HTML serialiser writes it in. A backstop: the decoded pass is the check. */
export function withHtmlEscapedForms(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    out.add(value);
    for (const map of HTML_ESCAPES) out.add(value.replace(/[&<>"'\u00a0]/g, (c) => map[c] ?? c));
  }
  return [...out];
}

const ELEMENT_NODE = 1;
/** Text, CDATA, processing instruction and comment nodes: their data is what a reader sees. */
const DATA_NODES = new Set([3, 4, 7, 8]);

/**
 * Redacts the board as a browser decodes it: every text, comment and attribute value (template
 * contents too), with entities and escapes already resolved by the parser. Returns the
 * re-serialised board, or `html` itself when nothing held a value.
 */
function redactDecoded(html: string, secretValues: readonly string[]): string {
  const dom = boardDom(html);
  try {
    let changed = false;
    const r = (text: string) => {
      const out = redactExactSecretValues(text, secretValues);
      if (out !== text) changed = true;
      return out;
    };
    // Iterative: a deeply nested board must not exhaust the stack.
    const stack: DomNode[] = [dom.window.document];
    while (stack.length) {
      const node = stack.pop()!;
      if (DATA_NODES.has(node.nodeType)) {
        const data = node.textContent ?? "";
        const out = r(data);
        if (out !== data) node.textContent = out;
        continue;
      }
      if (node.nodeType === ELEMENT_NODE) {
        const el = node as DomElement;
        for (const attr of Array.from(el.attributes)) {
          const out = r(attr.value);
          if (out !== attr.value) attr.value = out;
        }
        if (el.localName === "template" && el.content) stack.push(el.content as DomNode);
      }
      stack.push(...Array.from(node.childNodes));
    }
    return changed ? dom.serialize() : html;
  } finally {
    dom.window.close();
  }
}

/**
 * One board's secret post-pass. A value can reach the normalised board in a form the raw pre-pass
 * could not see: written as entities (`&amp;`, `&#45;`), or serialised by the sanitiser (`&quot;`,
 * `&lt;`, `&nbsp;`). So the board is redacted as text (the value and its escaped forms, which also
 * catches a value that spans markup) and then as decoded DOM (every text node and attribute value).
 * Either can change markup or leave a new escaped form, so a changed board is sanitised again and the
 * passes repeat until nothing changes; a board that never settles is refused.
 */
function redactBoard(board: string, html: string, secretValues: readonly string[]): string {
  const textForms = withHtmlEscapedForms(secretValues);
  let current = html;
  for (let round = 0; ; round += 1) {
    let next = redactExactSecretValues(current, textForms);
    if (next === current) next = redactDecoded(current, secretValues);
    if (next === current) return current;
    if (round >= MAX_REDACT_ROUNDS) throw new BoardFormatError([`board ${board}: could not be stored safely`]);
    const s = sanitizeBoard(next);
    if (s.problems.length) throw new BoardFormatError(s.problems.map((p) => `board ${board}: ${p}`));
    current = s.html;
  }
}

/**
 * The manifest's post-pass: its strings are redacted decoded (after JSON.parse, so `\"`, `\\` and
 * `\uXXXX` are resolved), then the re-serialised text is redacted with the JSON-escaped forms, then
 * it is parsed and checked again. Board ids and files must come through unchanged (they name files
 * and anchor threads): a manifest whose ids hold a value is refused.
 */
function redactManifest(manifest: Manifest, secretValues: readonly string[]): string {
  const r = (s: string) => redactExactSecretValues(s, secretValues);
  const refuse = () => new BoardFormatError(["manifest.json: board ids must not hold secret values"]);
  if (manifest.boards.some((b) => r(b.id) !== b.id || r(b.file) !== b.file)) throw refuse();
  const decoded: Manifest = {
    title: r(manifest.title),
    boards: manifest.boards.map((b) => ({ ...b, name: r(b.name) })),
  };
  const text = redactExactSecretValues(serializeManifest(decoded), withEscapedForms(secretValues));
  // Throws BoardFormatError when redaction broke the JSON or pushed a title or name past its limit.
  const after = parseManifest(text);
  const same =
    after.boards.length === manifest.boards.length &&
    after.boards.every((b, i) => b.id === manifest.boards[i].id && b.file === manifest.boards[i].file);
  if (!same) throw refuse();
  if (r(after.title) !== after.title || after.boards.some((b) => r(b.name) !== b.name)) {
    throw new BoardFormatError(["manifest.json: could not be stored safely"]);
  }
  return serializeManifest(after);
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * The secret post-pass (ruling PF-H4) over every normalised file: boards (redactBoard), the manifest
 * (redactManifest) and brand.md, which is stored as written and may be rendered as Markdown, so its
 * JSON- and HTML-escaped forms are redacted too. `[REDACTED]` can be longer than the value it
 * replaces, so the size limits are checked again afterwards.
 */
function redactNormalized(
  files: Record<string, string>,
  manifest: Manifest,
  secretValues: readonly string[],
): Record<string, string> {
  if (secretValues.length === 0) return files;
  const boardOf = new Map(manifest.boards.map((b) => [b.file, b.id]));
  const textForms = withHtmlEscapedForms(withEscapedForms(secretValues));
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    const board = boardOf.get(path);
    if (board !== undefined) {
      out[path] = redactBoard(board, text, secretValues);
      if (bytes(out[path]) > BOARD_MAX_BYTES) throw new Error("board_too_large");
    } else if (path === MANIFEST_PATH) {
      out[path] = redactManifest(manifest, secretValues);
    } else {
      out[path] = redactExactSecretValues(text, textForms);
      if (path === BRAND_PATH && bytes(out[path]) > BRAND_MAX_BYTES) {
        throw new BoardFormatError(["brand.md is over 64 KB"]);
      }
    }
  }
  if (Object.values(out).reduce((n, t) => n + bytes(t), 0) > DESIGN_VERSION_MAX_BYTES) {
    throw new Error("document_too_large");
  }
  return out;
}

function boardDom(html: string): JSDOM {
  return new JSDOM(html, { virtualConsole: new VirtualConsole() });
}
const bodyOf = (dom: JSDOM): ElementLike => dom.window.document.body;

export const boardsFormat: DocumentFormat = {
  kind: "design",
  format: "boards-v1",
  prepare(content, secretValues) {
    // Pre-pass on the raw text, so the sanitiser never sees a value in clear.
    const redacted = Object.fromEntries(
      Object.entries(filesOf(content)).map(([path, text]) => [path, redactExactSecretValues(text, secretValues)]),
    );
    const out = normalizeDesign(redacted);
    const files = redactNormalized(out.files, out.manifest, secretValues);
    const boards = out.manifest.boards.map((b) => files[b.file]);
    return {
      content: { format: "boards-v1", files },
      warnings: [...out.warnings, ...kindWarnings("design", { boards })],
    };
  },
  outdated(content, threads) {
    const files = filesOf(content);
    const manifest = parseManifest(files[MANIFEST_PATH]);
    const doms = new Map<string, JSDOM>();
    try {
      return threads
        .filter((t) => {
          let a: ElementAnchor;
          try {
            a = parseElementAnchor(t.anchor);
          } catch {
            return true;
          }
          const entry = manifest.boards.find((b) => b.id === a.board);
          if (!entry || !Object.hasOwn(files, entry.file)) return true;
          let dom = doms.get(a.board);
          if (!dom) {
            dom = boardDom(files[entry.file]);
            doms.set(a.board, dom);
          }
          return locateElement(bodyOf(dom), a) === null;
        })
        .map((t) => t.id);
    } finally {
      for (const d of doms.values()) d.window.close();
    }
  },
  parseAnchor: (value) => parseElementAnchor(value),
  anchorFits(content, anchor) {
    const a = anchor as ElementAnchor;
    return parseManifest(filesOf(content)[MANIFEST_PATH]).boards.some((b) => b.id === a.board);
  },
  redactAnchor(anchor, secretValues) {
    const a = parseElementAnchor(anchor);
    const r = (s: string) => redactExactSecretValues(s, secretValues);
    const { elementId, ...rest } = a;
    // An id that held a value is dropped (the path still finds the element); a board, path or tag that
    // holds one no longer matches its pattern, so the anchor is refused.
    const keepId = elementId !== undefined && r(elementId) === elementId;
    return parseElementAnchor({
      ...rest,
      ...(keepId ? { elementId } : {}),
      board: r(a.board),
      path: r(a.path),
      tag: r(a.tag),
      words: r(a.words).slice(0, MAX_ANCHOR_WORDS),
    });
  },
  anchorLabel(anchor) {
    const a = anchor as ElementAnchor;
    return `board ${JSON.stringify(a.board)}, the <${a.tag}> element${a.words ? ` starting ${JSON.stringify(a.words)}` : ""} (${a.path})`;
  },
};
