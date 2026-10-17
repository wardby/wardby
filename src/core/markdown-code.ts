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

/** Up to three spaces, at least the opening run of the fence's character, then only whitespace. */
function closesFence(line: string, fence: { char: string; length: number }): boolean {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  const start = index;
  while (line[index] === fence.char) index += 1;
  return index - start >= fence.length && line.slice(index).trim() === "";
}

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
      if (closesFence(line, fence)) fence = null;
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
  const runs: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < paragraph.length;) {
    if (paragraph[index] !== "`") {
      index += 1;
      continue;
    }
    const start = index;
    while (paragraph[index] === "`") index += 1;
    runs.push({ start, end: index });
  }
  // A span closes at the next run of exactly the opening run's length.
  const closer = new Array<number>(runs.length).fill(-1);
  const nextOfLength = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i].end - runs[i].start;
    closer[i] = nextOfLength.get(length) ?? -1;
    nextOfLength.set(length, i);
  }
  let result = "";
  let copied = 0;
  for (let i = 0; i < runs.length; i++) {
    const close = closer[i];
    if (close === -1) continue;
    result += `${paragraph.slice(copied, runs[i].start)} `;
    copied = runs[close].end;
    i = close;
  }
  return result + paragraph.slice(copied);
}

/** `markdown` without its code blocks and inline code spans. */
export function withoutMarkdownCode(markdown: string): string {
  return withoutCodeBlocks(markdown)
    .join("\n")
    .split(/(\n[ \t]*\n)/)
    .map((part, i) => (i % 2 === 1 ? part : withoutCodeSpans(part)))
    .join("");
}
