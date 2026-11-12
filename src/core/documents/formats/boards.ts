import { JSDOM, VirtualConsole } from "jsdom";
import { redactExactSecretValues } from "../../secret-spans.js";
import { BoardFormatError, MANIFEST_PATH, normalizeDesign, parseManifest, type Manifest } from "../boards/format.js";
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
const MAX_REDACT_ROUNDS = 3;

/**
 * The secret post-pass (ruling PF-H4). Sanitising decodes entities and escapes, so a value the
 * pre-pass could not see (`&#45;`, `-`) can appear in the normalised output: every output
 * file is redacted again. Cutting text out of serialised HTML can make new markup (an attribute
 * value turning into an attribute), so a board that redaction changed is sanitised again, and
 * the two repeat until the board is stable; one that never settles is refused.
 */
function redactNormalized(
  files: Record<string, string>,
  manifest: Manifest,
  secretValues: readonly string[],
): Record<string, string> {
  if (secretValues.length === 0) return files;
  const out: Record<string, string> = {};
  const boardOf = new Map(manifest.boards.map((b) => [b.file, b.id]));
  for (const [path, text] of Object.entries(files)) {
    const board = boardOf.get(path);
    let current = text;
    let redacted = redactExactSecretValues(current, secretValues);
    if (board === undefined) {
      out[path] = redacted;
      continue;
    }
    for (let round = 0; redacted !== current; round += 1) {
      if (round >= MAX_REDACT_ROUNDS) throw new BoardFormatError([`board ${board}: could not be stored safely`]);
      const s = sanitizeBoard(redacted);
      if (s.problems.length) throw new BoardFormatError(s.problems.map((p) => `board ${board}: ${p}`));
      current = s.html;
      redacted = redactExactSecretValues(current, secretValues);
    }
    out[path] = current;
  }
  if (out[MANIFEST_PATH] !== files[MANIFEST_PATH]) {
    // Redaction must not change which boards there are: ids and files have to stay as checked.
    const after = parseManifest(out[MANIFEST_PATH]);
    const same =
      after.boards.length === manifest.boards.length &&
      after.boards.every((b, i) => b.id === manifest.boards[i].id && b.file === manifest.boards[i].file);
    if (!same) throw new BoardFormatError(["manifest.json: board ids must not hold secret values"]);
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
