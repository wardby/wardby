/**
 * The one plain-text form used to anchor comments: blocks (lines) joined with "\n", inline
 * formatting markers removed, heading hashes, list bullets/numbers and blockquote markers
 * removed, whitespace collapsed within a block. The browser builds anchors with the same rule.
 */
export function markdownToPlainText(markdown: string): string {
  const blocks: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.ch && fenceMatch[1].length >= fence.len && !/[^\s`~]/.test(raw)) {
        fence = null;
        continue;
      }
      // Code text is shown verbatim (fence lines are not text), so only collapse whitespace.
      const code = raw.replace(/\s+/g, " ").trim();
      if (code) blocks.push(code);
      continue;
    }
    if (fenceMatch) {
      fence = { ch: fenceMatch[1][0], len: fenceMatch[1].length };
      continue;
    }
    let line = raw
      .replace(/^\s*(?:>\s*)+/, "")
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    line = line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
      .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1")
      .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (line) blocks.push(line);
  }
  return blocks.join("\n");
}
