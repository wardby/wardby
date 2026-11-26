/**
 * A publish based on an older version of a live document, merged with everything published since. The live
 * state keeps each version's Yjs state, so the publisher's changes (its Markdown against its base version) are
 * applied to the latest version's state: the result is the latest version with the publisher's changes, which
 * is what gets saved. Every version stays the whole document, whoever has it open.
 */
import * as Y from "yjs";
import type { PrismaClient } from "#prisma";
import { liveDocToMarkdown } from "./markdown.js";
import { mergePublish } from "./merge.js";
import { getVersionState } from "./store.js";

type Db = Pick<PrismaClient, "documentLiveState" | "documentLiveVersionState" | "documentVersion">;

/**
 * Null when there is nothing to merge: the document has no live state, or `base` is the latest version.
 * Otherwise the merged Markdown and the version it now builds on. Throws document_base_unavailable when the base
 * version's state is no longer kept, and document_version_conflict when the latest version has not been merged
 * into the live state yet (the caller treats it as before live editing).
 */
export async function mergeIntoLatest(
  db: Db,
  documentId: string,
  base: number,
  markdown: string,
): Promise<{ markdown: string; latest: number } | null> {
  if ((await db.documentLiveState.count({ where: { documentId } })) === 0) return null;
  const last = await db.documentVersion.aggregate({ where: { documentId }, _max: { number: true } });
  const latest = last._max.number ?? 0;
  if (latest === base) return null;
  if (base > latest) throw new Error("document_version_conflict");
  const baseState = await getVersionState(db, documentId, base);
  if (!baseState) throw new Error("document_base_unavailable");
  const latestState = await getVersionState(db, documentId, latest);
  if (!latestState) throw new Error("document_version_conflict");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, latestState);
  Y.applyUpdate(doc, mergePublish(baseState, markdown).update);
  return { markdown: liveDocToMarkdown(doc), latest };
}
