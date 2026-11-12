/**
 * The one plain-text form used to anchor comments: blocks (lines) joined with "\n", inline
 * formatting markers removed, heading hashes, list bullets/numbers and blockquote markers
 * removed, whitespace collapsed within a block. The browser builds anchors with the same rule.
 */
export function markdownToPlainText(markdown: string): string {
  const blocks: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    let line = raw
      .replace(/^\s*(?:>\s*)+/, "")
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    line = line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
      .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, "$2")
      .replace(/\s+/g, " ")
      .trim();
    if (line) blocks.push(line);
  }
  return blocks.join("\n");
}
