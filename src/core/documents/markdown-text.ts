/**
 * Plain characters stay plain in saved Markdown. @tiptap/markdown writes every `&`, `<` and `>` in text as
 * `&amp;`, `&lt;` and `&gt;`, so one save from the editor turns "Design & Wireframes" into
 * "Design &amp; Wireframes" for every later reader (agents, exports, the repository). keepPlainText swaps in
 * an encoder that escapes a character only where the Markdown would otherwise mean something else: `&` that
 * would start an entity, `<` that would start a tag, comment or autolink, and `>` at the start of a line
 * (a block quote). Code is untouched, as before. Used by every manager that serializes: the page's editor
 * and the server's live documents, so both write the same Markdown.
 */
import type { MarkdownManager } from "@tiptap/markdown";

const ENTITY_AMP = /&(?=[A-Za-z][A-Za-z0-9]*;|#[0-9]+;|#[xX][0-9A-Fa-f]+;)/g;
const TAG_LT = /<(?=[A-Za-z/!?])/g;
const LINE_START_GT = /(^|\n)([ \t]*)>/g;

/** The text of a non-code text node, escaped only where Markdown would read it differently. */
export function encodePlainText(text: string): string {
  return text.replace(ENTITY_AMP, "&amp;").replace(TAG_LT, "&lt;").replace(LINE_START_GT, "$1$2&gt;");
}

interface TextEncoding {
  codeTypes: Set<string>;
  escapeMarkdownSyntax(text: string): string;
  encodeTextForMarkdown(text: string, node: { marks?: unknown[] }, parentNode?: { type?: string } | null): string;
}

/** Replaces the manager's text encoder (a private method of @tiptap/markdown 3.33; markdown-text.test.ts pins it). */
export function keepPlainText(manager: MarkdownManager): MarkdownManager {
  const m = manager as unknown as TextEncoding;
  m.encodeTextForMarkdown = (text, node, parentNode) => {
    const inCode =
      (parentNode?.type != null && m.codeTypes.has(parentNode.type)) ||
      (node.marks ?? []).some((mark) =>
        m.codeTypes.has(typeof mark === "string" ? mark : (mark as { type: string }).type),
      );
    return inCode ? text : m.escapeMarkdownSyntax(encodePlainText(text));
  };
  return manager;
}
