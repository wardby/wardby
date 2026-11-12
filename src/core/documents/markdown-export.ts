/**
 * A Markdown document as a printable page for the PDF renderer (spec "Export"). The Markdown is
 * rendered with `marked`, then sanitised with the board allow-list (sanitizeFragment, images
 * dropped): no script, no handler, no external reference, so the renderer never fetches anything.
 * The stored Markdown was redacted when written; this adds no new secret path.
 */
import { marked } from "marked";
import { escapeHtml } from "../html-escape.js";
import { sanitizeFragment } from "./boards/sanitize.js";

/** A4 at 96 dpi: the width the PDF renderer lays the page out at. */
export const MARKDOWN_PDF_WIDTH = 794;

const PRINT_CSS =
  "@page{size:A4;margin:18mm}html{font:11pt/1.55 Georgia,'Times New Roman',serif;color:#1b1f27}" +
  "body{margin:0}h1,h2,h3,h4{font-family:system-ui,sans-serif;line-height:1.25;page-break-after:avoid}" +
  "h1{font-size:22pt}h2{font-size:16pt}h3{font-size:13pt}pre,code{font-family:ui-monospace,Menlo,monospace;font-size:9.5pt}" +
  "pre{background:#f3f4f7;padding:8px 10px;border-radius:4px;white-space:pre-wrap;page-break-inside:avoid}" +
  "blockquote{margin:0;padding-left:12px;border-left:3px solid #d6dae1;color:#4a5160}" +
  "table{border-collapse:collapse}th,td{border:1px solid #d6dae1;padding:4px 8px}img{max-width:100%}";

/** The sanitised HTML body for Markdown, and how many external references were dropped. */
export function markdownToSafeHtml(markdown: string): { html: string; droppedImages: number } {
  const raw = marked.parse(markdown, { async: false, gfm: true });
  const clean = sanitizeFragment(raw, { images: "drop" });
  return { html: clean.html, droppedImages: clean.removed.images };
}

export function markdownPrintFile(title: string, html: string): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'";
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">` +
    `<title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${html}</body></html>\n`
  );
}
