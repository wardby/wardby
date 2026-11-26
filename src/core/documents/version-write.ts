/**
 * Writing a new version of a document: the part every route that makes a version shares (publishVersion, and
 * reopening for review, which copies the approved version). The caller prepares the content (normalised and
 * redacted by the format adapter, or an existing version's content as stored), stages it before its Serializable
 * transaction, and writes it inside that transaction after its own checks (the review lock, for a publish).
 */
import type { Prisma, PrismaClient } from "#prisma";
import { contentHash, type VersionContent } from "./content.js";
import { storeDocumentContent, storeVersionFileRows } from "./files.js";
import type { DocumentFormat, PreparedContent } from "./formats/index.js";
import { liveAnchoredThreadIds } from "./live/anchors.js";

type Tx = Prisma.TransactionClient;

export type PublishVia = "editor" | "agent" | "mcp" | "import" | "review";

/** The DocumentVersion columns that hold prepared content (design files go to the file rows). */
export function versionColumns(format: VersionContent["format"], prepared: PreparedContent) {
  return {
    format,
    markdown: prepared.content.format === "markdown" ? prepared.content.markdown : null,
    contentHash: contentHash(prepared.content),
    warnings: prepared.warnings.length ? (prepared.warnings as unknown as Prisma.InputJsonValue) : undefined,
  };
}

/** Content staged for writeVersion: the open threads' anchor checks and a design's text are done already. */
export interface StagedVersion {
  fmt: DocumentFormat;
  prepared: PreparedContent;
  files: Record<string, string> | null;
  /** Open thread id → outdated against the new content, for the threads open when it was staged. */
  checked: Map<string, boolean>;
  /** Threads the document's live state anchors by position: the quote check never marks these outdated. */
  liveAnchored: ReadonlySet<string>;
}

/**
 * Before the transaction: re-anchoring parses the new content (jsdom for a design), so it is done here and the
 * transaction stays short. Anchors never change after a thread is created, so the verdicts hold; a thread opened
 * meanwhile is checked inside the transaction. A design's text goes in here too (idempotent per document), so the
 * transaction only writes the version, its file rows and thread statuses.
 */
export async function stageVersion(
  db: PrismaClient,
  documentId: string,
  fmt: DocumentFormat,
  prepared: PreparedContent,
  expectedNumber?: number,
): Promise<StagedVersion> {
  const checked = new Map<string, boolean>();
  const openBefore = await db.commentThread.findMany({
    where: { documentId, status: "open" },
    select: { id: true, anchor: true },
  });
  const liveAnchored = await liveAnchoredThreadIds(db, documentId);
  const outdatedBefore = new Set(fmt.outdated(prepared.content, openBefore));
  for (const t of openBefore) checked.set(t.id, !liveAnchored.has(t.id) && outdatedBefore.has(t.id));
  const files = prepared.content.format === "boards-v1" ? prepared.content.files : null;
  if (files && expectedNumber !== undefined) {
    // A stale writer fails here, before it stores text no version will use. The check in writeVersion still
    // decides; this one only bounds the orphan text a conflict leaves.
    const last = await db.documentVersion.aggregate({ where: { documentId }, _max: { number: true } });
    if ((last._max.number ?? 0) !== expectedNumber) throw new Error("document_version_conflict");
  }
  if (files) await storeDocumentContent(db, documentId, files);
  return { fmt, prepared, files, checked, liveAnchored };
}

/**
 * Inside the caller's Serializable transaction: writes the staged content as the next version, makes it current
 * and re-anchors the open threads. `expectedNumber`: document_version_conflict unless it is still the latest.
 */
export async function writeVersion(
  tx: Tx,
  documentId: string,
  staged: StagedVersion,
  meta: {
    via: PublishVia;
    createdById?: string | null;
    runId?: string | null;
    summary?: string | null;
    expectedNumber?: number;
  },
): Promise<{ versionId: string; number: number; reanchored: { kept: number; outdated: number } }> {
  const { fmt, prepared, files, checked, liveAnchored } = staged;
  const last = await tx.documentVersion.aggregate({ where: { documentId }, _max: { number: true } });
  if (meta.expectedNumber !== undefined && (last._max.number ?? 0) !== meta.expectedNumber) {
    throw new Error("document_version_conflict");
  }
  const number = (last._max.number ?? 0) + 1;
  const version = await tx.documentVersion.create({
    data: {
      documentId,
      number,
      ...versionColumns(fmt.format, prepared),
      via: meta.via,
      createdById: meta.createdById ?? null,
      runId: meta.runId ?? null,
      summary: meta.summary ?? null,
      baseNumber: meta.expectedNumber ?? null,
    },
  });
  if (files) await storeVersionFileRows(tx, documentId, version.id, files);
  await tx.document.update({ where: { id: documentId }, data: { currentVersionId: version.id } });
  const threads = await tx.commentThread.findMany({
    where: { documentId, status: "open" },
    select: { id: true, anchor: true },
  });
  const unchecked = threads.filter((t) => !checked.has(t.id) && !liveAnchored.has(t.id));
  const outdatedNew = new Set(unchecked.length ? fmt.outdated(prepared.content, unchecked) : []);
  const outdatedIds = threads.filter((t) => checked.get(t.id) ?? outdatedNew.has(t.id)).map((t) => t.id);
  if (outdatedIds.length > 0) {
    await tx.commentThread.updateMany({ where: { id: { in: outdatedIds } }, data: { status: "outdated" } });
  }
  return {
    versionId: version.id,
    number,
    reanchored: { kept: threads.length - outdatedIds.length, outdated: outdatedIds.length },
  };
}
