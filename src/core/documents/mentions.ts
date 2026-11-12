/**
 * Mentions in comment bodies. Two stored forms: `@[<principalId>]` for a
 * member and `@[guest:<guestId>]` for a guest of one of the document's share
 * links. Both share the id shape (1-64 of A-Z a-z 0-9 _ -), the body length
 * limit and the per-comment cap (MAX_MENTIONS_CHECKED in comments.ts).
 */
export type MentionRef = { kind: "principal"; id: string } | { kind: "guest"; id: string };

const MENTION = /@\[(guest:)?([A-Za-z0-9_-]{1,64})\]/g;

/** Every mention in order of appearance, deduped (first occurrence kept). */
export function parseMentionRefs(body: string): MentionRef[] {
  const seen = new Set<string>();
  const out: MentionRef[] = [];
  for (const m of body.matchAll(MENTION)) {
    const ref: MentionRef = m[1] ? { kind: "guest", id: m[2] } : { kind: "principal", id: m[2] };
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** Principal ids referenced as `@[id]` in a comment body. */
export function parseMentions(body: string): string[] {
  return parseMentionRefs(body).flatMap((r) => (r.kind === "principal" ? [r.id] : []));
}

/** Guest ids referenced as `@[guest:id]` in a comment body. */
export function parseGuestMentions(body: string): string[] {
  return parseMentionRefs(body).flatMap((r) => (r.kind === "guest" ? [r.id] : []));
}
