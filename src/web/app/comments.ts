/**
 * Pure helpers for the comment dialog: word snapping, previews, badge
 * stacking, the light body formatter and composer mentions. No DOM here, so
 * they run under vitest without a browser.
 */

const WORD = /[\p{L}\p{N}_]/u;
const isWord = (c: string | undefined) => c !== undefined && WORD.test(c);
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/**
 * Widens [start, end) to whole words (a drag can start or stop mid-word) and
 * trims whitespace at both edges. A whitespace-only range comes back empty.
 */
export function snapToWords(text: string, start: number, end: number): { start: number; end: number } {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  while (s < e && isSpace(text[s])) s++;
  while (e > s && isSpace(text[e - 1])) e--;
  if (s === e) return { start: s, end: s };
  while (s > 0 && isWord(text[s]) && isWord(text[s - 1])) s--;
  while (e < text.length && isWord(text[e - 1]) && isWord(text[e])) e++;
  return { start: s, end: e };
}

/** Badge tops in input order, pushed down so that no two are closer than `gap` (placed top to bottom). */
export function stackBadges(tops: number[], gap: number): number[] {
  const order = tops.map((top, i) => ({ top, i })).sort((a, b) => a.top - b.top || a.i - b.i);
  const out = new Array<number>(tops.length);
  let last = -Infinity;
  for (const { top, i } of order) {
    const y = Math.max(top, last + gap);
    out[i] = y;
    last = y;
  }
  return out;
}

export type Token = { kind: "text" | "bold" | "italic" | "code" | "mention" | "br"; text: string };

const MENTION_ID = "[A-Za-z0-9_-]{1,64}";
/** What goes between `@[` and `]`: a principal id, or `guest:` and a guest id. */
const MENTION_REF = `(?:guest:)?${MENTION_ID}`;
const FORMAT = new RegExp(
  [
    "`([^`\\n]+)`", // 1 code
    "\\*\\*([^*\\n]+)\\*\\*", // 2 bold
    "(?<![\\w*])\\*(?=\\S)([^*\\n]+?)(?<=\\S)\\*(?![\\w*])", // 3 italic (star)
    "(?<![\\w_])_(?=\\S)([^_\\n]+?)(?<=\\S)_(?![\\w_])", // 4 italic (underscore)
    `@\\[(${MENTION_REF})\\]`, // 5 mention
    "(\\n)", // 6 line break
  ].join("|"),
  "gu",
);

/**
 * The text shown for a mention: the current name when known. An unknown
 * member shows as "@member"; a guest not on this document (the server only
 * names this document's guests) shows as "@unknown".
 */
const mentionName = (ref: string, names?: ReadonlyMap<string, string>) =>
  `@${names?.get(ref) ?? (ref.startsWith("guest:") ? "unknown" : "member")}`;

/**
 * Splits a comment body into tokens for the renderer: **bold**, *italic* /
 * _italic_, `code`, @[id] and @[guest:id] mentions (shown with the current name) and line
 * breaks. Everything else is plain text; the renderer sets each token with
 * textContent, so no markup in a body is ever parsed.
 */
export function tokenizeBody(body: string, names?: ReadonlyMap<string, string>): Token[] {
  const out: Token[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += text;
    else out.push({ kind: "text", text });
  };
  let at = 0;
  for (const m of body.matchAll(FORMAT)) {
    pushText(body.slice(at, m.index));
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "bold", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "italic", text: m[3] });
    else if (m[4] !== undefined) out.push({ kind: "italic", text: m[4] });
    else if (m[5] !== undefined) out.push({ kind: "mention", text: mentionName(m[5], names) });
    else out.push({ kind: "br", text: "" });
    at = m.index + m[0].length;
  }
  pushText(body.slice(at));
  return out;
}

/** One line of plain text for the threads panel and badge titles: formatting markers stripped. */
export function previewText(body: string, names?: ReadonlyMap<string, string>): string {
  return tokenizeBody(body, names)
    .map((t) => (t.kind === "br" ? " " : t.text))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** The `@query` being typed just before the caret, if any (`@` at the start or after whitespace). */
export function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]{0,40})$/u.exec(value.slice(0, caret));
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[2] };
}

/** Someone the composer can mention: `ref` is what is stored between `@[` and `]`. */
export interface MentionCandidate {
  ref: string;
  name: string;
}

/** The ref and shown name for a /mentions entry: members by principal id, guests as "<name> (guest)". */
export function candidateFrom(c: { principalId?: string; guestId?: string; name: string }): MentionCandidate | null {
  if (typeof c.principalId === "string") return { ref: c.principalId, name: c.name };
  if (typeof c.guestId === "string") return { ref: `guest:${c.guestId}`, name: `${c.name} (guest)` };
  return null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Turns the `@Name` text of picked people into stored `@[ref]` mentions (longest names first). */
export function encodeMentions(text: string, picked: readonly MentionCandidate[]): string {
  let out = text;
  const byLength = [...picked].sort((a, b) => b.name.length - a.name.length);
  for (const p of byLength) {
    if (!p.name) continue;
    out = out.replace(new RegExp(`@${escapeRegExp(p.name)}(?![\\p{L}\\p{N}_])`, "gu"), `@[${p.ref}]`);
  }
  return out;
}

/** The editable form of a stored body: known `@[ref]` mentions become `@Name` (and are returned as picked). */
export function decodeMentions(
  body: string,
  names: ReadonlyMap<string, string>,
): { text: string; picked: MentionCandidate[] } {
  const picked = new Map<string, MentionCandidate>();
  const text = body.replace(new RegExp(`@\\[(${MENTION_REF})\\]`, "g"), (whole, ref: string) => {
    const name = names.get(ref);
    if (!name) return whole;
    picked.set(ref, { ref, name });
    return `@${name}`;
  });
  return { text, picked: [...picked.values()] };
}

/** Up to two initials for an avatar. */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w][0] ?? "")
    .join("");
  return [...letters].slice(0, 2).join("").toUpperCase() || "?";
}

/** "just now", "5m", "3h", "2d", or a date for anything older than a week. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  return new Date(t).toISOString().slice(0, 10);
}
