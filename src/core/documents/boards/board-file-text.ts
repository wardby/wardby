/**
 * A stored board file written from its parts (board format v1, ruling D7): the board's CSS as written stays in
 * <style data-wardby-base>, the editor's CSS goes in <style data-wardby-edits>. Pure string code shared by the page
 * (web/app/board-file.ts, which also reads files) and the server's live writer (boards/live/writer.ts).
 */
import { escapeHtml } from "../../html-escape.js";

export interface BoardParts {
  lang: string;
  title: string;
  /** The board's CSS as written: what the canvas injects first, under the editable rules. */
  baseCss: string;
  /** CSS the editor wrote on an earlier save, or null when the board has none yet. */
  editsCss: string | null;
  bodyHtml: string;
  /** The body's class, id and style (the only body attributes the format keeps). */
  bodyAttrs: Record<string, string>;
}

export const BODY_ATTRS = ["class", "id", "style"] as const;
export const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

export function serializeBoardFile(parts: BoardParts, editsCss: string, bodyHtml: string): string {
  const attrs = BODY_ATTRS.filter((a) => Object.hasOwn(parts.bodyAttrs, a))
    .map((a) => ` ${a}="${escapeHtml(parts.bodyAttrs[a])}"`)
    .join("");
  return (
    `<!doctype html>\n<html lang="${LANG.test(parts.lang) ? parts.lang : "en"}">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(parts.title)}</title>\n` +
    `<style data-wardby-base>${parts.baseCss}</style>\n` +
    `<style data-wardby-edits>${editsCss}</style>\n` +
    `</head>\n<body${attrs}>${bodyHtml}</body>\n</html>\n`
  );
}
