import { redactExactSecretValues } from "../../secret-spans.js";
import { locateAnchor, parseTextAnchor, type TextAnchor } from "../anchors.js";
import { kindWarnings } from "../kind-check.js";
import { MAX_CONTEXT_CHARS, MAX_MARKDOWN_BYTES, MAX_QUOTE_CHARS } from "../limits.js";
import { markdownToPlainText } from "../plain-text.js";
import type { DocumentFormat } from "./types.js";

export const markdownFormat: DocumentFormat = {
  kind: "document",
  format: "markdown",
  prepare(content, secretValues) {
    if (content.format !== "markdown") throw new Error("document_format_mismatch");
    if (Buffer.byteLength(content.markdown, "utf8") > MAX_MARKDOWN_BYTES) throw new Error("document_too_large");
    const markdown = redactExactSecretValues(content.markdown, secretValues);
    return { content: { format: "markdown", markdown }, warnings: kindWarnings("document", { markdown }) };
  },
  outdated(content, threads) {
    if (content.format !== "markdown") throw new Error("document_format_mismatch");
    const plain = markdownToPlainText(content.markdown);
    return threads
      .filter((t) => {
        try {
          return locateAnchor(plain, parseTextAnchor(t.anchor)) === null;
        } catch {
          return true;
        }
      })
      .map((t) => t.id);
  },
  parseAnchor: (value) => parseTextAnchor(value),
  anchorFits: () => true,
  redactAnchor(anchor, secretValues) {
    const a = parseTextAnchor(anchor);
    const r = (s: string) => redactExactSecretValues(s, secretValues);
    // The marker can be longer than the value: cut back to the limits, keeping the side next to the quote.
    // A quote or context changed here may no longer match the document text exactly, so the thread can
    // go outdated on the next publish. That fails safe: the thread is kept, only its anchor is lost.
    return parseTextAnchor({
      type: "text",
      quote: r(a.quote).slice(0, MAX_QUOTE_CHARS),
      prefix: r(a.prefix).slice(-MAX_CONTEXT_CHARS),
      suffix: r(a.suffix).slice(0, MAX_CONTEXT_CHARS),
    });
  },
  anchorLabel: (anchor) => `the text ${JSON.stringify((anchor as TextAnchor).quote)}`,
};
