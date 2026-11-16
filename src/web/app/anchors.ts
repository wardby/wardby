/**
 * Text anchors in the browser. The server anchors and re-anchors comments
 * against `markdownToPlainText` (src/core/documents/plain-text.ts); the page
 * must build the same plain text from the Tiptap document (rulings R1, R1a):
 * the document's text with "\n" between text blocks (Tiptap
 * `doc.textBetween(0, size, "\n")`, plus "\n" for hard breaks, which the
 * Markdown source writes as a new line), whitespace collapsed within each
 * line, empty lines dropped. No DOM here.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { snapToWords } from "./comments.js";

export interface TextAnchor {
  type: "text";
  quote: string;
  prefix: string;
  suffix: string;
}

/** Characters of context stored on each side of a quote. */
export const CONTEXT_CHARS = 32;
/** The server's limit on a quote (src/core/documents/limits.ts MAX_QUOTE_CHARS). */
export const MAX_QUOTE_CHARS = 500;

/** The document's raw text and, for each character, the document position it came from. */
export interface DocText {
  raw: string;
  pos: number[];
}

/** Walks the document like ProseMirror's textBetween(0, size, "\n"), keeping positions; hard breaks are "\n". */
export function docText(doc: PMNode): DocText {
  let raw = "";
  const pos: number[] = [];
  let first = true;
  doc.descendants((node, at) => {
    if (node.isTextblock) {
      if (!first) {
        raw += "\n";
        pos.push(at);
      }
      first = false;
    }
    if (node.isText) {
      const text = node.text ?? "";
      raw += text;
      for (let i = 0; i < text.length; i++) pos.push(at + i);
    } else if (node.type.name === "hardBreak") {
      raw += "\n";
      pos.push(at);
    }
  });
  return { raw, pos };
}

/** The normalized text and, for each of its characters, the offset in `raw` it came from. */
export function normalizeWithMap(raw: string): { text: string; toRaw: number[] } {
  let text = "";
  const toRaw: number[] = [];
  let lineStart = 0;
  for (const line of raw.split("\n")) {
    let pendingSpace = -1;
    let started = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (/\s/.test(c)) {
        if (started && pendingSpace < 0) pendingSpace = lineStart + i;
        continue;
      }
      if (!started && text.length > 0) {
        text += "\n";
        toRaw.push(lineStart - 1);
      }
      if (pendingSpace >= 0) {
        text += " ";
        toRaw.push(pendingSpace);
        pendingSpace = -1;
      }
      text += c;
      toRaw.push(lineStart + i);
      started = true;
    }
    lineStart += line.length + 1;
  }
  return { text, toRaw };
}

/** The plain text comments are anchored in (equal to the server's markdownToPlainText of the same document). */
export function plainTextForAnchoring(raw: string): string {
  return normalizeWithMap(raw).text;
}

/** First index whose value is >= target in a non-decreasing array. */
function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Document positions for [start, end) of the normalized text. */
function docRange(dt: DocText, toRaw: readonly number[], start: number, end: number): { from: number; to: number } {
  return { from: dt.pos[toRaw[start]], to: dt.pos[toRaw[end - 1]] + 1 };
}

/**
 * The anchor for a selection (document positions), snapped to whole words,
 * with CONTEXT_CHARS of context; and the snapped range to highlight. Null when
 * nothing but whitespace is selected or the quote is over the server's limit.
 */
export function anchorForRange(
  dt: DocText,
  from: number,
  to: number,
): { anchor: TextAnchor; range: { from: number; to: number } } | null {
  const { text, toRaw } = normalizeWithMap(dt.raw);
  const rawStart = lowerBound(dt.pos, from);
  const rawEnd = lowerBound(dt.pos, to);
  const snapped = snapToWords(text, lowerBound(toRaw, rawStart), lowerBound(toRaw, rawEnd));
  if (snapped.end <= snapped.start) return null;
  const quote = text.slice(snapped.start, snapped.end);
  if (quote.length > MAX_QUOTE_CHARS) return null;
  return {
    anchor: {
      type: "text",
      quote,
      prefix: text.slice(Math.max(0, snapped.start - CONTEXT_CHARS), snapped.start),
      suffix: text.slice(snapped.end, snapped.end + CONTEXT_CHARS),
    },
    range: docRange(dt, toRaw, snapped.start, snapped.end),
  };
}

/**
 * Finds a quote in plain text, preferring the occurrence whose context
 * matches. The same scoring as the server's locateAnchor
 * (src/core/documents/anchors.ts), kept here so the bundle does not pull in
 * the server's schema validation.
 */
export function locateAnchor(text: string, a: TextAnchor): { start: number; end: number } | null {
  let best: { start: number; score: number } | null = null;
  for (let i = text.indexOf(a.quote); i >= 0; i = text.indexOf(a.quote, i + 1)) {
    const before = text.slice(Math.max(0, i - a.prefix.length), i);
    const after = text.slice(i + a.quote.length, i + a.quote.length + a.suffix.length);
    const score =
      (before === a.prefix ? 2 : before.endsWith(a.prefix.slice(-8)) ? 1 : 0) +
      (after === a.suffix ? 2 : after.startsWith(a.suffix.slice(0, 8)) ? 1 : 0);
    if (!best || score > best.score) best = { start: i, score };
  }
  return best ? { start: best.start, end: best.start + a.quote.length } : null;
}

/** Where an anchor sits in the document now, as document positions; null when its quote is gone. */
export function rangeForAnchor(dt: DocText, anchor: TextAnchor): { from: number; to: number } | null {
  if (!anchor.quote) return null;
  const { text, toRaw } = normalizeWithMap(dt.raw);
  const hit = locateAnchor(text, anchor);
  return hit ? docRange(dt, toRaw, hit.start, hit.end) : null;
}
