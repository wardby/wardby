/**
 * Paging for run replies that can outgrow an MCP client's result limit (Claude Code replaces a tool
 * result over about 60,000 characters with an error). Nothing is cut away: a long field comes in
 * pieces, each reachable from the one before, and a list comes a page at a time.
 */

/** The most of a long text field get_run returns; the rest is one get_run_text call (or more) away. */
export const RUN_TEXT_FIRST_PAGE_CHARS = 8_000;
/** get_run_text's piece size: its default and its maximum. */
export const RUN_TEXT_DEFAULT_LIMIT = 32_000;
export const RUN_TEXT_MAX_LIMIT = 32_000;
/** The run text fields that page: exactly the long free-text fields get_run returns. */
export const RUN_TEXT_FIELDS = ["request", "taskOverride", "finalText", "error"] as const;
export type RunTextField = (typeof RUN_TEXT_FIELDS)[number];

/** get_run_packages' page size: its default and its maximum. */
export const RUN_PACKAGES_DEFAULT_LIMIT = 200;
export const RUN_PACKAGES_MAX_LIMIT = 500;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** True when `index` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, index: number): boolean {
  return index > 0 && index < text.length && isHigh(text.charCodeAt(index - 1)) && isLow(text.charCodeAt(index));
}

/** A whole number within [min, max], or the fallback when the value isn't a finite number. */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(min, n), max);
}

/**
 * A piece of `text`: up to `limit` UTF-16 code units from `offset`. Neither end splits a surrogate pair:
 * an offset inside one starts at the pair, and an end inside one stops before it (or, with a limit of 1,
 * takes the whole pair, so a page always moves on). `next` is where the following piece starts, or null
 * at the end.
 */
export function textPiece(
  text: string,
  offset: number,
  limit: number,
): { offset: number; text: string; next: number | null; total: number } {
  const total = text.length;
  let start = Math.min(Math.max(0, offset), total);
  if (splitsPair(text, start)) start -= 1;
  let end = Math.min(total, start + Math.max(1, limit));
  if (splitsPair(text, end)) end = end - 1 > start ? end - 1 : end + 1;
  return { offset: start, text: text.slice(start, end), next: end < total ? end : null, total };
}

/**
 * A long field's first page for get_run: the whole text when it is at most RUN_TEXT_FIRST_PAGE_CHARS,
 * else its first piece plus `<field>More` ({ next, total }) saying where get_run_text continues.
 */
export function firstPageFields<F extends string>(field: F, text: string | null | undefined): Record<string, unknown> {
  if (typeof text !== "string") return {};
  const piece = textPiece(text, 0, RUN_TEXT_FIRST_PAGE_CHARS);
  if (piece.next === null) return { [field]: text };
  return { [field]: piece.text, [`${field}More`]: { next: piece.next, total: piece.total } };
}

/** A page of a stable list: `after` items already read, up to `limit` more, and the next `after` or null. */
export function listPage<T>(items: readonly T[], after: number, limit: number): { page: T[]; next: number | null } {
  const page = items.slice(after, after + limit);
  const end = after + page.length;
  return { page, next: end < items.length ? end : null };
}
