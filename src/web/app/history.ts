/**
 * The Edits tray's pure parts: grouping versions into rows, the row text, and
 * where a version's changes sit in the document (decoration ranges). No DOM.
 */
import { getSchema, resolveExtensions } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { docText, normalizeWithMap } from "./anchors.js";
import { diffText } from "./diff.js";
import { documentExtensions } from "./extensions.js";

export {
  ago,
  describeRow,
  groupVersions,
  GROUP_WINDOW_MS,
  restoredFrom,
  type EditRow,
  type VersionItem,
} from "./version-rows.js";

// ---- where the changes are ---------------------------------------------------------

let parser: { schema: Schema; markdown: MarkdownManager } | null = null;

/** A document node for Markdown, parsed with the editor's own extensions (no editor, no DOM). */
export function parseMarkdown(md: string): PMNode {
  parser ??= {
    schema: getSchema(documentExtensions()),
    markdown: new MarkdownManager({ extensions: resolveExtensions(documentExtensions()) }),
  };
  return parser.schema.nodeFromJSON(parser.markdown.parse(md));
}

/** The plain text a document is anchored and diffed in (anchors.ts). */
export const plainOf = (doc: PMNode): string => normalizeWithMap(docText(doc).raw).text;

export interface DiffMarks {
  /** Inserted text, as document ranges (one per block). */
  inserts: { from: number; to: number }[];
  /** Deleted text and the document position it is shown at. */
  deletes: { pos: number; text: string }[];
}

/**
 * Where `doc` differs from the earlier plain text `before`: inserted ranges
 * in `doc`, and deleted text with the position to show it at. Whitespace-only
 * changes are not marked (the plain text collapses whitespace anyway).
 */
export function diffMarks(doc: PMNode, before: string): DiffMarks {
  const dt = docText(doc);
  const { text, toRaw } = normalizeWithMap(dt.raw);
  const posOf = (i: number) => dt.pos[toRaw[i]];
  /** Where text deleted before character k of the new text is shown: after the character before it in the same block, else at the start of the next block. */
  const anchorAt = (k: number): number => {
    if (text.length === 0) return Math.min(1, doc.content.size);
    if (k > 0 && text[k - 1] !== "\n") return posOf(k - 1) + 1;
    if (k < text.length) return posOf(k);
    return posOf(text.length - 1) + 1;
  };
  const out: DiffMarks = { inserts: [], deletes: [] };
  let k = 0;
  for (const op of diffText(before, text)) {
    if (op.kind === "equal") {
      k += op.text.length;
    } else if (op.kind === "insert") {
      // One range per block: "\n" is a block boundary, never highlighted itself.
      let start = k;
      for (let i = k; i <= k + op.text.length; i++) {
        if (i === k + op.text.length || text[i] === "\n") {
          if (text.slice(start, i).trim()) out.inserts.push({ from: posOf(start), to: posOf(i - 1) + 1 });
          start = i + 1;
        }
      }
      k += op.text.length;
    } else {
      const shown = op.text.trim().replace(/\s*\n\s*/g, " ¶ ");
      if (op.text.trim()) out.deletes.push({ pos: anchorAt(k), text: shown });
    }
  }
  return out;
}
