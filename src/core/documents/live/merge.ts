/**
 * The three-way merge of a published version into a live document. The publisher read version B; the live
 * document has moved on since (people typing, other publishes). The new Markdown is applied to a copy of B's
 * live state, so the result holds only what the publisher changed relative to B, and applying it to the live
 * document keeps everyone else's edits. Merging from any state other than B's applies B's own changes again
 * (duplicated text), so callers must pass the exact base. Pure: no database.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { LIVE_FIELD, markdownToDoc } from "./markdown.js";

/** The transaction origin of a merged publish (so observers can tell it from people's edits). */
export const MERGE_ORIGIN = "wardby-publish";

export function mergePublish(
  baseState: Uint8Array,
  markdown: string,
): { update: Uint8Array; versionState: Uint8Array } {
  const fork = new Y.Doc();
  Y.applyUpdate(fork, baseState);
  const before = Y.encodeStateVector(fork);
  const target = markdownToDoc(markdown);
  fork.transact(() => mergeChildren(fork, fork.getXmlFragment(LIVE_FIELD), target), MERGE_ORIGIN);
  return { update: Y.encodeStateAsUpdate(fork, before), versionState: Y.encodeStateAsUpdate(fork) };
}

type Meta = Parameters<typeof updateYFragment>[3];
const newMeta = (): Meta => ({ mapping: new Map(), isOMark: new Map() });

/**
 * Brings `parent`'s block children to `target`'s, touching only the blocks that changed. updateYFragment on its
 * own pairs blocks up by position once two differ, so every block between a change and the next block that does
 * not read back exactly from Markdown was re-created (and comments on it went outdated): here unchanged blocks are
 * lined up first (longest common run), and only the blocks between them are updated, inserted or deleted.
 */
function mergeChildren(doc: Y.Doc, parent: Y.XmlFragment | Y.XmlElement, target: PMNode): void {
  const schema = target.type.schema;
  const ys = parent.toArray();
  const wrapped = yXmlFragmentToProsemirrorJSON(parent) as { content?: unknown[] };
  const yKeys = (wrapped.content ?? []).map((j) => JSON.stringify(schema.nodeFromJSON(j).toJSON()));
  const ps: PMNode[] = [];
  target.forEach((n) => ps.push(n));
  const pKeys = ps.map((n) => JSON.stringify(n.toJSON()));
  if (yKeys.length !== ys.length || ys.some((y) => !(y instanceof Y.XmlElement))) {
    updateYFragment(doc, parent, target, newMeta());
    return;
  }
  // Longest common run of identical blocks.
  const n = ys.length;
  const m = ps.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = yKeys[i] === pKeys[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const kept: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (yKeys[i] === pKeys[j]) kept.push([i++, j++]);
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  kept.push([n, m]);
  // From the end, so earlier indexes stay valid.
  for (let k = kept.length - 1, [yEnd, pEnd] = kept[k]; k >= 0; k--) {
    const [yStart, pStart] = k > 0 ? [kept[k - 1][0] + 1, kept[k - 1][1] + 1] : [0, 0];
    mergeGap(doc, parent, ys.slice(yStart, yEnd) as Y.XmlElement[], yStart, ps.slice(pStart, pEnd));
    if (k > 0) [yEnd, pEnd] = kept[k - 1];
  }
}

/**
 * Between two unchanged blocks. Deleting a live block deletes everything typed in it since the publisher's version,
 * so blocks are updated in place whenever they can be paired: the same number of blocks of the same types are
 * paired in order; otherwise each live block is paired with the most alike new block of its type, in order.
 */
function mergeGap(doc: Y.Doc, parent: Y.XmlFragment | Y.XmlElement, ys: Y.XmlElement[], at: number, ps: PMNode[]) {
  const pairs: [number, number][] = [];
  let from = 0;
  if (ys.length === ps.length && ys.every((y, i) => y.nodeName === ps[i].type.name))
    ys.forEach((_, i) => pairs.push([i, i]));
  else
    for (let i = 0; i < ys.length; i++) {
      let best = -1;
      let score = 0.5;
      for (let j = from; j < ps.length; j++) {
        if (ps[j].type.name !== ys[i].nodeName) continue;
        const s = alike(yText(ys[i]), ps[j].textContent);
        if (s > score) [best, score] = [j, s];
      }
      if (best >= 0) {
        pairs.push([i, best]);
        from = best + 1;
      }
    }
  // Apply from the end: the paired blocks are updated in place, the others deleted or inserted.
  let yEnd = ys.length;
  let pEnd = ps.length;
  for (const [i, j] of [...pairs.reverse(), [-1, -1] as [number, number]]) {
    for (let y = yEnd - 1; y > i; y--) parent.delete(at + y, 1);
    for (let p = pEnd - 1; p > j; p--) insertBlock(doc, parent, at + i + 1, ps[p]);
    if (i >= 0) updateBlock(doc, ys[i], ps[j]);
    [yEnd, pEnd] = [i, j];
  }
}

function insertBlock(doc: Y.Doc, parent: Y.XmlFragment | Y.XmlElement, index: number, p: PMNode) {
  const el = new Y.XmlElement(p.type.name);
  parent.insert(index, [el]);
  updateYFragment(doc, el, p, newMeta());
}

/** A text block is updated by updateYFragment (a character diff); a container's children are lined up again. */
function updateBlock(doc: Y.Doc, y: Y.XmlElement, p: PMNode) {
  if (p.isTextblock || p.isLeaf || p.childCount === 0) {
    updateYFragment(doc, y, p, newMeta());
    return;
  }
  const attrs = y.getAttributes();
  for (const [key, value] of Object.entries(p.attrs)) {
    if (value === null || value === undefined) {
      if (key in attrs) y.removeAttribute(key);
    } else if (JSON.stringify(attrs[key]) !== JSON.stringify(value)) y.setAttribute(key, value as string);
  }
  for (const key of Object.keys(attrs)) if (!(key in p.attrs)) y.removeAttribute(key);
  mergeChildren(doc, y, p);
}

function yText(y: Y.XmlElement): string {
  let out = "";
  const walk = (n: Y.XmlElement | Y.XmlText) => {
    if (n instanceof Y.XmlText) out += String(n.toString()).replace(/<[^>]*>/g, "");
    else for (const c of n.toArray()) walk(c as Y.XmlElement | Y.XmlText);
  };
  walk(y);
  return out;
}

/** How alike two texts are, 0 to 1: the words they share (spacing aside), over all their words. */
function alike(a: string, b: string): number {
  const wa = a.split(/\s+/).filter(Boolean);
  const wb = b.split(/\s+/).filter(Boolean);
  if (!wa.length && !wb.length) return 1;
  const left = new Map<string, number>();
  for (const w of wa) left.set(w, (left.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wb) {
    const n = left.get(w) ?? 0;
    if (n > 0) {
      shared++;
      left.set(w, n - 1);
    }
  }
  return (2 * shared) / (wa.length + wb.length);
}
