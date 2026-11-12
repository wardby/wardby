import { Prisma } from "#prisma";
import type { Document, DocumentVersion, PrismaClient } from "#prisma";
import type { loadAgentSecretValues } from "../secret-guard.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { preferIndexScans, withSerializableRetry } from "../serializable-retry.js";
import { contentHash, type VersionContent } from "./content.js";
import { notifyDocumentChange } from "./events.js";
import { DOCUMENT_WRITE_ATTEMPTS } from "./limits.js";
import { loadContent, storeDocumentContent, storeVersionFileRows, storeVersionFiles } from "./files.js";
import { formatFor, type DocumentKind, type PreparedContent } from "./formats/index.js";
import { documentSecretValues } from "./redact.js";
import type { VersionWarning } from "./warnings.js";

type Cipher = Parameters<typeof loadAgentSecretValues>[1];
export type DocumentServiceDb = PrismaClient;

export type PublishVia = "editor" | "agent" | "mcp" | "import";

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

/** The DocumentVersion columns that hold prepared content (design files go to storeVersionFiles). */
function versionColumns(format: VersionContent["format"], prepared: PreparedContent) {
  return {
    format,
    markdown: prepared.content.format === "markdown" ? prepared.content.markdown : null,
    contentHash: contentHash(prepared.content),
    warnings: prepared.warnings.length ? (prepared.warnings as unknown as Prisma.InputJsonValue) : undefined,
  };
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
        createdById: input.ownerId,
      },
    });
    if (prepared.content.format === "boards-v1") {
      await storeVersionFiles(tx, doc.id, version.id, prepared.content.files);
    }
    await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    return { id: doc.id, versionId: version.id, warnings: prepared.warnings };
  });
}

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
    select: { agentId: true, kind: true },
  });
  if (!doc) throw new Error("document_not_found");
  const fmt = formatFor(doc.kind);
  const content = contentInput(fmt.kind, input);
  const secrets = await documentSecretValues(db, cipher, doc.agentId);
  const prepared = fmt.prepare(content, secrets);
  const summary = input.summary === undefined ? null : redactExactSecretValues(input.summary, secrets);
  // Re-anchoring parses the new content (jsdom for a design): done here, before the Serializable
  // transaction, so the transaction stays short. Anchors never change after a thread is created, so
  // the verdicts hold; a thread opened meanwhile is checked inside the transaction.
  const checked = new Map<string, boolean>();
  const openBefore = await db.commentThread.findMany({
    where: { documentId: input.documentId, status: "open" },
    select: { id: true, anchor: true },
  });
  const outdatedBefore = new Set(fmt.outdated(prepared.content, openBefore));
  for (const t of openBefore) checked.set(t.id, outdatedBefore.has(t.id));
  // A design's text goes in before the transaction too (idempotent per document), so the transaction
  // only writes the version, its file rows and thread statuses.
  const files = prepared.content.format === "boards-v1" ? prepared.content.files : null;
  if (files) await storeDocumentContent(db, input.documentId, files);
  const published = await withSerializableRetry(
    () =>
      db.$transaction(
        async (tx) => {
          await preferIndexScans(tx);
          const last = await tx.documentVersion.aggregate({
            where: { documentId: input.documentId },
            _max: { number: true },
          });
          if (input.expectedNumber !== undefined && (last._max.number ?? 0) !== input.expectedNumber) {
            throw new Error("document_version_conflict");
          }
          const number = (last._max.number ?? 0) + 1;
          const version = await tx.documentVersion.create({
            data: {
              documentId: input.documentId,
              number,
              ...versionColumns(fmt.format, prepared),
              via: input.via,
              createdById: input.createdById ?? null,
              runId: input.runId ?? null,
              summary,
            },
          });
          if (files) await storeVersionFileRows(tx, input.documentId, version.id, files);
          await tx.document.update({
            where: { id: input.documentId },
            data: { currentVersionId: version.id },
          });
          const threads = await tx.commentThread.findMany({
            where: { documentId: input.documentId, status: "open" },
            select: { id: true, anchor: true },
          });
          const unchecked = threads.filter((t) => !checked.has(t.id));
          const outdatedNew = new Set(unchecked.length ? fmt.outdated(prepared.content, unchecked) : []);
          const outdatedIds = threads.filter((t) => checked.get(t.id) ?? outdatedNew.has(t.id)).map((t) => t.id);
          const kept = threads.length - outdatedIds.length;
          if (outdatedIds.length > 0) {
            await tx.commentThread.updateMany({ where: { id: { in: outdatedIds } }, data: { status: "outdated" } });
          }
          return {
            versionId: version.id,
            number,
            reanchored: { kept, outdated: outdatedIds.length },
            warnings: prepared.warnings,
          };
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
