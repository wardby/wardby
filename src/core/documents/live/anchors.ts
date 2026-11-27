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
/** The shared-document field (LIVE_FIELD in markdown.ts; not imported, so the page's bundle stays small). */
const FIELD = "default";

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

/**
 * Where a thread's words are now, found by its quote and context (the rule a document without live editing uses),
 * as new positions: for words deleted and written back the same in one change (a paragraph's text rewritten
 * whole), which leaves the old positions on deleted text. Null when the quote is not found in one paragraph with
 * its context on at least one side.
 */
export function reanchorByQuote(doc: Y.Doc, anchor: TextAnchor): { from: unknown; to: unknown } | null {
  if (!anchor.quote) return null;
  const texts: Y.XmlText[] = [];
  const walk = (n: Y.XmlFragment | Y.XmlElement) => {
    for (const c of n.toArray()) {
      if (c instanceof Y.XmlText) texts.push(c);
      else if (c instanceof Y.XmlElement) walk(c);
    }
  };
  walk(doc.getXmlFragment(FIELD));
  for (const t of texts) {
    // The quote and context are stored with whitespace runs as one space: search the text the same way.
    const raw = plain(t);
    const at: number[] = [];
    let s = "";
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i]) && /\s/.test(raw[i - 1] ?? "")) continue;
      at.push(i);
      s += /\s/.test(raw[i]) ? " " : raw[i];
    }
    at.push(raw.length);
    for (let i = s.indexOf(anchor.quote); i >= 0; i = s.indexOf(anchor.quote, i + 1)) {
      const before = s.slice(0, i);
      const after = s.slice(i + anchor.quote.length);
      const prefixOk = anchor.prefix.trim() !== "" && before.endsWith(anchor.prefix.slice(-8));
      const suffixOk = anchor.suffix.trim() !== "" && after.startsWith(anchor.suffix.slice(0, 8));
      if (!prefixOk && !suffixOk) continue;
      const pos = (index: number) =>
        Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, index, -1)) as unknown;
      return { from: pos(at[i]), to: pos(at[i + anchor.quote.length]) };
    }
  }
  return null;
}
