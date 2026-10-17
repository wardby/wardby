/**
 * GitHub-flavoured Markdown with its code removed, so a mention quoted in code
 * (`` `@app` ``, a fenced or indented block) is documentation, not a request.
 * Close to CommonMark, not a full parser: when in doubt it keeps text, so a
 * real mention is never lost to an odd construct.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED = /^(?: {4}|\t)/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const BLANK = /^\s*$/;

/** Fenced and indented code blocks blanked out, line count kept. */
function withoutCodeBlocks(markdown: string): string[] {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  // Indented code needs a blank line before it, and indented text under a
  // list item is the item's paragraph, not code.
  let previousBlank = true;
  let inIndentedCode = false;
  let inList = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      if (close.test(line)) fence = null;
      out.push("");
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string cannot contain a backtick (CommonMark).
    if (open && !(open[1][0] === "`" && line.slice(line.indexOf(open[1]) + open[1].length).includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      inIndentedCode = false;
      previousBlank = false;
      out.push("");
      continue;
    }
    if (BLANK.test(line)) {
      previousBlank = true;
      out.push(line);
      continue;
    }
    if (INDENTED.test(line) && !inList && (previousBlank || inIndentedCode)) {
      inIndentedCode = true;
      previousBlank = false;
      out.push("");
      continue;
    }
    inIndentedCode = false;
    if (LIST_ITEM.test(line)) inList = true;
    else if (!INDENTED.test(line) && previousBlank) inList = false;
    previousBlank = false;
    out.push(line);
  }
  return out;
}

/** Inline code spans in one paragraph replaced by a space; an unmatched run of backticks is literal. */
function withoutCodeSpans(paragraph: string): string {
  let result = "";
  let index = 0;
  while (index < paragraph.length) {
    const start = paragraph.indexOf("`", index);
    if (start === -1) break;
    let runEnd = start;
    while (paragraph[runEnd] === "`") runEnd += 1;
    const run = paragraph.slice(start, runEnd);
    // The closing run has exactly the opening run's length.
    const closing = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
    closing.lastIndex = runEnd;
    const close = closing.exec(paragraph);
    if (!close) {
      result += paragraph.slice(index, runEnd);
      index = runEnd;
      continue;
    }
    result += `${paragraph.slice(index, start)} `;
    index = close.index + run.length;
  }
  return result + paragraph.slice(index);
}

/** `markdown` without its code blocks and inline code spans. */
export function withoutMarkdownCode(markdown: string): string {
  return withoutCodeBlocks(markdown)
    .join("\n")
    .split(/(\n[ \t]*\n)/)
    .map((part, i) => (i % 2 === 1 ? part : withoutCodeSpans(part)))
    .join("");
}
