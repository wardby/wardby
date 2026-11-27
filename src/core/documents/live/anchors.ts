/**
 * Comment positions in a live document. The page keeps each comment's range as Yjs relative positions in the
 * shared map LIVE_ANCHORS (thread id → { from, to }), so a comment follows its words through everyone's edits.
 * The server reads them back here: to say which threads are anchored live (the quote check leaves those alone)
 * and to rewrite each thread's stored quote from where its positions are now.
 */
import * as Y from "yjs";
import type { PrismaClient } from "#prisma";
import type { TextAnchor } from "../anchors.js";
import { MAX_CONTEXT_CHARS, MAX_QUOTE_CHARS } from "../limits.js";

export const LIVE_ANCHORS = "wardby-anchors";

/**
 * What a thread's positions say now: its quote (and context) as the text reads now; "gone" when its words were
 * deleted; "keep" when the positions cannot give a quote (a range across paragraphs), so the stored one stands.
 */
export type LiveAnchorReading = TextAnchor | "gone" | "keep";

const plain = (t: Y.XmlText) =>
  (t.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === "string" ? d.insert : "")).join("");
const squash = (s: string) => s.replace(/\s+/g, " ");

export function readLiveAnchors(doc: Y.Doc): Map<string, LiveAnchorReading> {
  const out = new Map<string, LiveAnchorReading>();
  const positions = doc.getMap<{ from: unknown; to: unknown }>(LIVE_ANCHORS);
  for (const [threadId, rel] of positions.entries()) {
    let a: Y.AbsolutePosition | null;
    let b: Y.AbsolutePosition | null;
    try {
      a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel.from), doc);
      b = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel.to), doc);
    } catch {
      out.set(threadId, "keep");
      continue;
    }
    if (!a || !b) {
      out.set(threadId, "gone");
      continue;
    }
    if (a.type !== b.type || !(a.type instanceof Y.XmlText)) {
      out.set(threadId, "keep");
      continue;
    }
    if (b.index <= a.index) {
      out.set(threadId, "gone");
      continue;
    }
    const text = plain(a.type);
    const quote = squash(text.slice(a.index, b.index)).trim();
    if (!quote) {
      out.set(threadId, "gone");
      continue;
    }
    out.set(threadId, {
      type: "text",
      quote: quote.slice(0, MAX_QUOTE_CHARS),
      prefix: squash(text.slice(Math.max(0, a.index - MAX_CONTEXT_CHARS), a.index)).slice(-MAX_CONTEXT_CHARS),
      suffix: squash(text.slice(b.index, b.index + MAX_CONTEXT_CHARS)).slice(0, MAX_CONTEXT_CHARS),
    });
  }
  return out;
}

/** The threads a document's stored live state anchors by position (none when it has no live state). */
export async function liveAnchoredThreadIds(
  db: Pick<PrismaClient, "documentLiveState">,
  documentId: string,
): Promise<Set<string>> {
  const row = await db.documentLiveState.findUnique({ where: { documentId }, select: { state: true } });
  if (!row) return new Set();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.state));
  return new Set(doc.getMap(LIVE_ANCHORS).keys());
}

/**
 * Re-points comment positions whose words an undo brought back. Undo re-creates deleted text as new items, and
 * only the page that undid knows which items they replace (Yjs keeps that link locally, never in an update), so
 * the server would read those positions as deleted and the comment would stay outdated. Run on the page after its
 * own undo or redo: a position that now resolves through a restored item is written again against the new one.
 */
export function repointRestoredAnchors(doc: Y.Doc): number {
  const positions = doc.getMap<{ from: unknown; to: unknown }>(LIVE_ANCHORS);
  const again = (json: unknown): unknown => {
    const rel = Y.createRelativePositionFromJSON(json);
    // Only a position on a deleted item that an undo or redo re-created (a deleted item without one stays gone).
    if (!rel.item || rel.item.clock >= Y.getState(doc.store, rel.item.client)) return json;
    const item = Y.getItem(doc.store, rel.item);
    if (!(item instanceof Y.Item) || !item.deleted || !item.redone) return json;
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
    if (!abs) return json;
    const next: unknown = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(abs.type, abs.index, rel.assoc),
    );
    return JSON.stringify(next) === JSON.stringify(Y.relativePositionToJSON(rel)) ? json : next;
  };
  const changed: [string, { from: unknown; to: unknown }][] = [];
  for (const [threadId, rel] of positions.entries()) {
    try {
      const from = again(rel.from);
      const to = again(rel.to);
      if (from !== rel.from || to !== rel.to) changed.push([threadId, { from, to }]);
    } catch {
      // A position this page cannot read stays as it is.
    }
  }
  if (changed.length) doc.transact(() => changed.forEach(([id, rel]) => positions.set(id, rel)));
  return changed.length;
}
