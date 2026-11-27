/**
 * Whether the editor can keep a document as written (ruling R17). Tiptap
 * parses Markdown into its schema and writes it back on save; anything the
 * schema has no place for (images, task lists, raw HTML) would be dropped or
 * rewritten by the first keystroke. Such documents open comment-only.
 */
import { markdownToPlainText } from "../../core/documents/plain-text.js";

export const LOSSY_NOTICE =
  "This document uses formatting the editor can't keep (images, checklists or HTML). Comment here; edit it in the repository or ask the agent.";

/** The source with fenced code blocks and code spans removed: syntax inside code is text. */
function outsideCode(markdown: string): string {
  const kept: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !/[^\s`~]/.test(line)) fence = null;
      continue;
    }
    if (m) {
      fence = { ch: m[1][0], len: m[1].length };
      continue;
    }
    kept.push(line.replace(/\\`/g, "").replace(/(`+)[\s\S]*?\1/g, ""));
  }
  return kept.join("\n");
}

/** Image syntax: ![alt](url) or ![alt][ref]. */
const IMAGE = /!\[[^\]]*\]\s*[([]/;
/** A task-list item: - [ ] / - [x] (any bullet or number, inside quotes too). */
const TASK_ITEM = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\](?:\s|$)/m;
/** An HTML tag or comment. Autolinks (<https://…>, <a@b.c>) are not tags. */
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--/;
/** Named entities other than the ones the editor writes back (&amp; &lt; &gt; &quot;): e.g. &copy; &nbsp;. */
const NAMED_ENTITY = /&(?!(?:amp|lt|gt|quot);)[A-Za-z][A-Za-z0-9]*;/;

/**
 * True when saving from the editor keeps the document: no images, task
 * lists or raw HTML outside code, and the plain text of what the editor
 * writes back (`serialized`, Tiptap's getMarkdown() of the parsed source)
 * equals the source's.
 */
export function isLosslessRoundTrip(source: string, serialized: string): boolean {
  const text = outsideCode(source);
  if (IMAGE.test(text) || TASK_ITEM.test(text) || HTML_TAG.test(text) || NAMED_ENTITY.test(text)) return false;
  return markdownToPlainText(serialized) === markdownToPlainText(source);
}
