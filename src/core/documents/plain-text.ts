/**
 * The one plain-text form used to anchor comments: blocks (lines) joined with "\n", inline
 * formatting markers removed, heading hashes, list bullets/numbers and blockquote markers
 * removed, whitespace collapsed within a block, empty lines dropped (rulings R1, R1a). It is the
 * text the browser editor shows (ruling R16), so the page and the server anchor in the same
 * text: backslash escapes outside code are unescaped, a table gives one line per cell (the
 * delimiter row and outer pipes are not text), horizontal rules and setext underlines are not
 * text, the HTML entities &amp; &lt; &gt; &quot; &#39; and numeric references are decoded, a
 * trailing backslash before a new line is a line break, autolinks (<https://…>) lose their angle
 * brackets, and raw HTML is kept as literal text.
 */
export function markdownToPlainText(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const blocks: string[] = [];
  const push = (text: string) => {
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (collapsed) blocks.push(collapsed);
  };
  let fence: { ch: string; len: number } | null = null;
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.ch && fenceMatch[1].length >= fence.len && !/[^\s`~]/.test(raw)) {
        fence = null;
        continue;
      }
      // Code text is shown verbatim (fence lines are not text), so only collapse whitespace.
      push(raw);
      continue;
    }
    if (fenceMatch) {
      fence = { ch: fenceMatch[1][0], len: fenceMatch[1].length };
      inTable = false;
      continue;
    }
    if (!raw.trim()) {
      inTable = false;
      continue;
    }
    if (!inTable && raw.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      inTable = true;
      for (const cell of tableCells(raw)) push(inlineText(cell));
      i++; // the delimiter row is not text
      continue;
    }
    if (inTable) {
      for (const cell of tableCells(raw)) push(inlineText(cell));
      continue;
    }
    let line = raw.replace(/^\s*(?:>\s*)+/, "");
    if (THEMATIC_BREAK.test(line)) continue;
    // A setext heading's "===" underline (after a paragraph line) is not text.
    if (/^ {0,3}=+\s*$/.test(line) && i > 0 && lines[i - 1].trim()) continue;
    line = line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    // A backslash at the end of a line inside a paragraph is a hard line break, not text.
    const nextIsText = i + 1 < lines.length && lines[i + 1].trim() !== "";
    push(inlineText(line, nextIsText));
  }
  return blocks.join("\n");
}

/** A horizontal rule: three or more of the same "-", "*" or "_", optionally spaced, alone on the line. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** A GFM table delimiter row such as `|---|:--:|` (it must hold a pipe, so "---" alone is a rule). */
function isTableDelimiter(line: string): boolean {
  return line.includes("|") && /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

/** A table row's cells: outer pipes dropped, split on unescaped pipes. */
function tableCells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };

/** Decodes &amp; &lt; &gt; &quot; and numeric character references in one pass (no double decoding). */
function decodeEntities(text: string): string {
  return text.replace(/&(?:(amp|lt|gt|quot)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g, (m, name, dec, hex) => {
    if (name) return ENTITIES[name as string];
    const cp = dec ? Number.parseInt(dec as string, 10) : Number.parseInt(hex as string, 16);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

// Literal text (escaped characters, code spans) is parked in the Private Use Area while the
// formatting markers around it are removed, then put back.
const OPEN = "";
const CLOSE = "";
const PARKED = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

/** One line's inline text: code spans and escapes kept literally; links, autolinks, emphasis and strikes unwrapped. */
function inlineText(line: string, hardBreakAllowed = false): string {
  const parked: string[] = [];
  const park = (text: string) => `${OPEN}${parked.push(text) - 1}${CLOSE}`;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      const next = line[i + 1];
      if (next === undefined) {
        // Trailing backslash: a line break when the paragraph continues, otherwise literal.
        if (!hardBreakAllowed) out += c;
        i++;
      } else if (/[!-/:-@[-`{-~]/.test(next)) {
        out += park(next);
        i += 2;
      } else {
        out += c;
        i++;
      }
      continue;
    }
    if (c === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      const close = closingTicks(line, i + run, run);
      if (close < 0) {
        out += "`".repeat(run);
        i += run;
        continue;
      }
      let code = line.slice(i + run, close);
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      out += park(code);
      i = close + run;
      continue;
    }
    out += c;
    i++;
  }
  out = out
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, "$1");
  return decodeEntities(out).replace(PARKED, (_m, n: string) => parked[Number(n)]);
}

/** Index of the next backtick run of exactly `run` characters at or after `from`, or -1. */
function closingTicks(line: string, from: number, run: number): number {
  for (let i = from; i < line.length;) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let end = i;
    while (line[end] === "`") end++;
    if (end - i === run) return i;
    i = end;
  }
  return -1;
}
