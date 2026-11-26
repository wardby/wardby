import { Prisma } from "#prisma";
import type { Document, DocumentVersion, PrismaClient } from "#prisma";
import type { loadAgentSecretValues } from "../secret-guard.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { preferIndexScans, withSerializableRetry } from "../serializable-retry.js";
import type { VersionContent } from "./content.js";
import { requireDocumentAccess, type Viewer } from "./access.js";
import { notifyDocumentChange } from "./events.js";
import { DOCUMENT_WRITE_ATTEMPTS } from "./limits.js";
import { loadContent, storeVersionFiles } from "./files.js";
import { formatFor, type DocumentKind } from "./formats/index.js";
import { documentSecretValues } from "./redact.js";
import { mergeFilesIntoLatest, mergeIntoLatest } from "./live/merge-latest.js";
import { isLocked } from "./review-state.js";
import { assertNotLocked, recomputeAfterPublish } from "./review.js";
import { stageVersion, versionColumns, writeVersion, type PublishVia } from "./version-write.js";
import type { VersionWarning } from "./warnings.js";

type Cipher = Parameters<typeof loadAgentSecretValues>[1];
export type DocumentServiceDb = PrismaClient;

export type { PublishVia } from "./version-write.js";

/** Exactly one of markdown/files, matching the kind: a document takes Markdown, a design takes files. */
function contentInput(
  kind: DocumentKind,
  input: { markdown?: string; files?: Record<string, string> },
): VersionContent {
  if (kind === "document" && input.markdown !== undefined && input.files === undefined) {
    return { format: "markdown", markdown: input.markdown };
  }
  if (kind === "design" && input.files !== undefined && input.markdown === undefined) {
    return { format: "boards-v1", files: input.files };
  }
  throw new Error("document_format_mismatch");
}

export async function createDocument(
  db: DocumentServiceDb,
  cipher: Cipher,
  input: {
    kind?: DocumentKind;
    ownerId: string;
    title: string;
    markdown?: string;
    files?: Record<string, string>;
    agentId?: string;
    repository?: string;
    path?: string;
    baseRef?: string;
    via?: PublishVia;
    /** The run that wrote version 1 (an agent creating a document). */
    runId?: string;
    /** Who version 1 is credited to; defaults to the owner (an agent creates for its owner). */
    createdById?: string;
  },
): Promise<{ id: string; versionId: string; warnings: VersionWarning[] }> {
  const fmt = formatFor(input.kind ?? "document");
  const content = contentInput(fmt.kind, input);
  const secrets = await documentSecretValues(db, cipher, input.agentId ?? null);
  const prepared = fmt.prepare(content, secrets);
  // The title is shown on pages, share pages and MCP lists: redacted like the body.
  const title = redactExactSecretValues(input.title, secrets);
  return db.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: {
        kind: fmt.kind,
        title,
        ownerId: input.ownerId,
        agentId: input.agentId ?? null,
        repository: input.repository ?? null,
        path: input.path ?? null,
        baseRef: input.baseRef ?? null,
      },
    });
    const version = await tx.documentVersion.create({
      data: {
        documentId: doc.id,
        number: 1,
        ...versionColumns(fmt.format, prepared),
        via: input.via ?? "editor",
        createdById: input.createdById ?? input.ownerId,
        runId: input.runId ?? null,
      },
    });
    if (prepared.content.format === "boards-v1") {
      await storeVersionFiles(tx, doc.id, version.id, prepared.content.files);
    }
    await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    return { id: doc.id, versionId: version.id, warnings: prepared.warnings };
  });
}

/** Refused with document_locked while the document is approved or archived (every route publishes here). */
export async function publishVersion(
  db: DocumentServiceDb,
  cipher: Cipher,
  input: {
    documentId: string;
    markdown?: string;
    files?: Record<string, string>;
    via: PublishVia;
    createdById?: string;
    runId?: string;
    summary?: string;
    /** The number the editor started from: when it is no longer the latest, throws document_version_conflict. */
    expectedNumber?: number;
    /** Only restoreVersion sets this: a summary reading "Restored v<N>" marks a restore, so no one else may write it. */
    allowRestoredSummary?: boolean;
    /**
     * Only the live server's checkpoints set this: expectedNumber must be the latest version, as without live
     * editing (the live server merges every newer version in first). Otherwise a live document merges a publish
     * based on an older version with everything published since (mergeIntoLatest).
     */
    strictBase?: boolean;
  },
): Promise<{
  versionId: string;
  number: number;
  reanchored: { kept: number; outdated: number };
  warnings: VersionWarning[];
}> {
  if (input.summary !== undefined && !input.allowRestoredSummary && /^\s*Restored v\d+/i.test(input.summary)) {
    throw new Error("document_summary_invalid");
  }
  const doc = await db.document.findUnique({
    where: { id: input.documentId },
    select: { agentId: true, kind: true, reviewState: true },
  });
  if (!doc) throw new Error("document_not_found");
  // Early refusal (the transaction below decides): a locked design must not store orphan file text.
  if (isLocked(doc.reviewState)) throw new Error("document_locked");
  const fmt = formatFor(doc.kind);
  const content = contentInput(fmt.kind, input);
  const secrets = await documentSecretValues(db, cipher, doc.agentId);
  let prepared = fmt.prepare(content, secrets);
  let expectedNumber = input.expectedNumber;
  if (!input.strictBase && expectedNumber !== undefined && prepared.content.format === "markdown") {
    const merged = await mergeIntoLatest(db, input.documentId, expectedNumber, prepared.content.markdown);
    if (merged) {
      // The merged text is new text: it passes the same checks (and redaction) as any publish.
      prepared = fmt.prepare({ format: "markdown", markdown: merged.markdown }, secrets);
      expectedNumber = merged.latest;
    }
  } else if (!input.strictBase && expectedNumber !== undefined && prepared.content.format === "boards-v1") {
    const merged = await mergeFilesIntoLatest(db, input.documentId, expectedNumber, prepared.content.files);
    if (merged) {
      prepared = fmt.prepare({ format: "boards-v1", files: merged.files }, secrets);
      expectedNumber = merged.latest;
    }
  }
  const summary = input.summary === undefined ? null : redactExactSecretValues(input.summary, secrets);
  const staged = await stageVersion(db, input.documentId, fmt, prepared, expectedNumber);
  const published = await withSerializableRetry(
    () =>
      db.$transaction(
        async (tx) => {
          await preferIndexScans(tx);
          await assertNotLocked(tx, input.documentId);
          const written = await writeVersion(tx, input.documentId, staged, {
            via: input.via,
            createdById: input.createdById,
            runId: input.runId,
            summary,
            expectedNumber,
          });
          await recomputeAfterPublish(tx, input.documentId);
          return { ...written, warnings: prepared.warnings };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    { attempts: DOCUMENT_WRITE_ATTEMPTS },
  );
  // After the commit: the editor, MCP and the agent loop all publish here.
  await notifyDocumentChange(db, input.documentId, "version");
  return published;
}

export async function getDocument(
  db: DocumentServiceDb,
  documentId: string,
): Promise<{ document: Document; version: DocumentVersion; content: VersionContent }> {
  const document = await db.document.findUnique({ where: { id: documentId }, include: { currentVersion: true } });
  if (!document || !document.currentVersion) throw new Error("document_not_found");
  const { currentVersion, ...rest } = document;
  return { document: rest, version: currentVersion, content: await loadContent(db, currentVersion) };
}

/**
 * Sets or clears a document's agent and repository link. The caller has already checked the link itself (the
 * agent, the repository and the path). Only the owner may change it, and not while a send is in flight: that run
 * publishes back through the link it started with. Content is untouched; the next send uses the new link.
 */
export async function linkDocument(
  db: DocumentServiceDb,
  input: {
    documentId: string;
    viewer: Viewer;
    link: { agentId: string | null; repository: string | null; path: string | null; baseRef: string | null };
  },
): Promise<void> {
  await requireDocumentAccess(db, input.documentId, input.viewer, "owner");
  const updated = await db.document.updateMany({
    where: {
      id: input.documentId,
      threads: { none: { sentRunId: { not: null }, answeredRunId: null } },
    },
    data: input.link,
  });
  if (updated.count === 0) throw new Error("document_link_busy");
  await notifyDocumentChange(db, input.documentId, "thread");
}
