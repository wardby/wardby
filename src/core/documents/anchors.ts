import { z } from "zod";
import { MAX_CONTEXT_CHARS, MAX_QUOTE_CHARS } from "./limits.js";

const schema = z.object({
  type: z.literal("text"),
  quote: z.string().min(1).max(MAX_QUOTE_CHARS),
  prefix: z.string().max(MAX_CONTEXT_CHARS),
  suffix: z.string().max(MAX_CONTEXT_CHARS),
});

export type TextAnchor = z.infer<typeof schema>;

export function parseTextAnchor(value: unknown): TextAnchor {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error("comment_anchor_invalid");
  return r.data;
}

/** Finds the anchor's quote in plain text, preferring the occurrence whose surrounding context matches. */
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
