/**
 * The three-way merge of a published version into a live document. The publisher read version B; the live
 * document has moved on since (people typing, other publishes). The new Markdown is applied to a copy of B's
 * live state, so the result holds only what the publisher changed relative to B, and applying it to the live
 * document keeps everyone else's edits. Merging from any state other than B's applies B's own changes again
 * (duplicated text), so callers must pass the exact base. Pure: no database.
 */
import { updateYFragment } from "@tiptap/y-tiptap";
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
  fork.transact(
    () =>
      updateYFragment(fork, fork.getXmlFragment(LIVE_FIELD), markdownToDoc(markdown), {
        mapping: new Map(),
        isOMark: new Map(),
      }),
    MERGE_ORIGIN,
  );
  return { update: Y.encodeStateAsUpdate(fork, before), versionState: Y.encodeStateAsUpdate(fork) };
}
