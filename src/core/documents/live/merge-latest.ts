/**
 * A publish based on an older version of a live document, merged with everything published since. The live
 * state keeps each version's Yjs state, so the publisher's changes (its Markdown against its base version) are
 * applied to the latest version's state: the result is the latest version with the publisher's changes, which
 * is what gets saved. Every version stays the whole document, whoever has it open.
 */
import * as Y from "yjs";
import type { PrismaClient } from "#prisma";
import { designFiles, isBuilt, liveManifest, newElementIds, planDesignMerge } from "../boards/live/design-doc.js";
import { loadVersionFiles } from "../files.js";
import { liveDocToMarkdown } from "./markdown.js";
import { mergePublish } from "./merge.js";
import { getVersionState } from "./store.js";

type Db = Pick<PrismaClient, "documentLiveState" | "documentLiveVersionState" | "documentVersion">;
type DesignDb = Db & Pick<PrismaClient, "documentFile">;

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

/**
 * A design published from an older version of a live design, merged with everything published since, as the live
 * server merges a version (core/documents/boards/live/design-doc.ts): the publisher's changes from its base
 * version, by element, applied to the latest version's state. A board nobody has opened takes the publisher's file
 * when only the publisher changed it; when both the publisher and a later version changed one, the publish is
 * refused with document_version_conflict (re-read and publish again) rather than one side's change being dropped.
 * Null and the errors as for mergeIntoLatest.
 */
export async function mergeFilesIntoLatest(
  db: DesignDb,
  documentId: string,
  base: number,
  files: Record<string, string>,
): Promise<{ files: Record<string, string>; latest: number } | null> {
  if ((await db.documentLiveState.count({ where: { documentId } })) === 0) return null;
  const versions = await db.documentVersion.findMany({
    where: { documentId },
    orderBy: { number: "desc" },
    take: 1,
    select: { id: true, number: true },
  });
  const latest = versions[0];
  if (!latest || latest.number === base) return null;
  if (base > latest.number) throw new Error("document_version_conflict");
  const baseRow = await db.documentVersion.findUnique({
    where: { documentId_number: { documentId, number: base } },
    select: { id: true },
  });
  const baseState = await getVersionState(db, documentId, base);
  if (!baseRow || !baseState) throw new Error("document_base_unavailable");
  const latestState = await getVersionState(db, documentId, latest.number);
  if (!latestState) throw new Error("document_version_conflict");
  const [before, now] = await Promise.all([loadVersionFiles(db, baseRow.id), loadVersionFiles(db, latest.id)]);
  const baseDoc = new Y.Doc();
  Y.applyUpdate(baseDoc, baseState);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, latestState);
  try {
    planDesignMerge(baseDoc, doc, before, files).apply(doc, newElementIds(baseDoc, doc), "wardby-merge");
  } catch {
    throw new Error("document_version_conflict");
  }
  // Files without a live copy (boards nobody opened, brand.md): three-way by whole file. Boards with a live copy
  // are written from it, and the board list comes from the merged live document.
  const live = new Set(
    liveManifest(doc)
      .boards.filter((b) => isBuilt(doc, b.id))
      .map((b) => b.file),
  );
  const kept: Record<string, string> = {};
  for (const path of new Set([...Object.keys(now), ...Object.keys(files)])) {
    if (live.has(path) || path === "manifest.json") continue;
    const [b, n, f] = [before[path], now[path], files[path]];
    if (f === b) {
      if (n !== undefined) kept[path] = n;
    } else if (n === b || n === f) {
      if (f !== undefined) kept[path] = f;
    } else throw new Error("document_version_conflict");
  }
  return { files: designFiles(doc, kept), latest: latest.number };
}
