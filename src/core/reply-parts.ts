/**
 * Splits an agent's reply into comment-sized parts, so a long reply (a plan
 * posted to an issue, say) can go out in full as numbered follow-up comments
 * instead of being cut. Pure: numbering, headers and the cut note are the
 * caller's job; each part is a raw slice of the defused text.
 */

export interface ReplyParts {
  parts: string[];
  truncated: boolean;
}

/** "@" + U+200B before a word character, so a quoted reply pings nobody. */
export function defuseMentions(text: string): string {
  return text.replace(/@(?=[\w-])/g, "@\u200b");
}

const FENCE_LINE = /^\s{0,3}(```|~~~)/;
const HEADING_LINE = /^#{1,6}\s/;

/** [open, close) offsets of each fenced code block; a cut strictly inside one would break it. */
function fenceSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let open = -1;
  let offset = 0;
  for (const line of text.split("\n")) {
    const end = offset + line.length + 1;
    if (FENCE_LINE.test(line)) {
      if (open < 0) open = offset;
      else {
        spans.push([open, Math.min(end, text.length)]);
        open = -1;
      }
    }
    offset = end;
  }
  if (open >= 0) spans.push([open, text.length]);
  return spans;
}

/**
 * Splits `text` into at most `maxParts` parts of at most `maxChars` each, preferring Markdown heading
 * boundaries, then blank lines (paragraphs), then single newlines, then a hard cut. Defuses @-mentions.
 * Never splits inside a fenced code block unless one block alone exceeds maxChars (then hard-cut it).
 */
export function splitReply(text: string, opts: { maxChars: number; maxParts: number }): ReplyParts {
  const maxChars = Math.max(1, Math.floor(opts.maxChars));
  const maxParts = Math.max(1, Math.floor(opts.maxParts));
  const defused = defuseMentions(text);
  if (defused.length <= maxChars) return { parts: [defused], truncated: false };

  const spans = fenceSpans(defused);
  const inFence = (at: number): boolean => spans.some(([open, close]) => at > open && at < close);
  const lineStart = (at: number): boolean => defused[at - 1] === "\n";
  const tiers: Array<(at: number) => boolean> = [
    (at) => lineStart(at) && HEADING_LINE.test(defused.slice(at, at + 7)),
    (at) => lineStart(at) && defused[at - 2] === "\n",
    lineStart,
  ];

  /** The furthest cut in (start, start + maxChars]: the best tier wins, then a hard cut. */
  const cutAfter = (start: number): number => {
    const limit = start + maxChars;
    for (const tier of tiers) {
      for (let at = limit; at > start; at--) if (!inFence(at) && tier(at)) return at;
    }
    // A surrogate pair is one character to a reader; keep it whole when we can.
    const code = defused.charCodeAt(limit - 1);
    return code >= 0xd800 && code <= 0xdbff && limit - 1 > start ? limit - 1 : limit;
  };

  const parts: string[] = [];
  let start = 0;
  while (start < defused.length && parts.length < maxParts) {
    const end = defused.length - start <= maxChars ? defused.length : cutAfter(start);
    parts.push(defused.slice(start, end));
    start = end;
  }
  return { parts, truncated: start < defused.length };
}
