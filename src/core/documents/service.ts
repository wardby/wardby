import { createHash } from "node:crypto";
import { Prisma } from "#prisma";
import type { Document, DocumentVersion, PrismaClient } from "#prisma";
import type { loadAgentSecretValues } from "../secret-guard.js";
import { preferIndexScans, withSerializableRetry } from "../serializable-retry.js";
import { locateAnchor, parseTextAnchor } from "./anchors.js";
import { notifyDocumentChange } from "./events.js";
import { MAX_MARKDOWN_BYTES } from "./limits.js";
import { markdownToPlainText } from "./plain-text.js";
import { redactForDocumentAgent } from "./redact.js";

type Cipher = Parameters<typeof loadAgentSecretValues>[1];
export type DocumentServiceDb = PrismaClient;

export type PublishVia = "editor" | "agent" | "mcp" | "import";

async function prepareMarkdown(
  db: DocumentServiceDb,
  cipher: Cipher,
  agentId: string | null,
  markdown: string,
): Promise<string> {
  if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) throw new Error("document_too_large");
  return redactForDocumentAgent(db, cipher, agentId, markdown);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createDocument(
  db: DocumentServiceDb,
  cipher: Cipher,
  input: {
    kind?: string;
    ownerId: string;
    title: string;
    markdown: string;
    agentId?: string;
    repository?: string;
    path?: string;
    baseRef?: string;
    via?: PublishVia;
  },
): Promise<{ id: string; versionId: string }> {
  if ((input.kind ?? "document") !== "document") throw new Error("document_kind_unsupported");
  const markdown = await prepareMarkdown(db, cipher, input.agentId ?? null, input.markdown);
  // The title is shown on pages, share pages and MCP lists: redacted like the body.
  const title = await redactForDocumentAgent(db, cipher, input.agentId ?? null, input.title);
  return db.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: {
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
        markdown,
        contentHash: sha256(markdown),
        via: input.via ?? "editor",
        createdById: input.ownerId,
      },
    });
    await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    return { id: doc.id, versionId: version.id };
  });
}

export async function publishVersion(
  db: DocumentServiceDb,
  cipher: Cipher,
  input: {
    documentId: string;
    markdown: string;
    via: PublishVia;
    createdById?: string;
    runId?: string;
    summary?: string;
    /** The number the editor started from: when it is no longer the latest, throws document_version_conflict. */
    expectedNumber?: number;
    /** Only restoreVersion sets this: a summary reading "Restored v<N>" marks a restore, so no one else may write it. */
    allowRestoredSummary?: boolean;
  },
): Promise<{ versionId: string; number: number; reanchored: { kept: number; outdated: number } }> {
  if (input.summary !== undefined && !input.allowRestoredSummary && /^\s*Restored v\d+/i.test(input.summary)) {
    throw new Error("document_summary_invalid");
  }
  const doc = await db.document.findUnique({ where: { id: input.documentId }, select: { agentId: true } });
  if (!doc) throw new Error("document_not_found");
  const markdown = await prepareMarkdown(db, cipher, doc.agentId, input.markdown);
  const plain = markdownToPlainText(markdown);
  const summary =
    input.summary === undefined ? null : await redactForDocumentAgent(db, cipher, doc.agentId, input.summary);
  const published = await withSerializableRetry(() =>
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
            markdown,
            contentHash: sha256(markdown),
            via: input.via,
            createdById: input.createdById ?? null,
            runId: input.runId ?? null,
            summary,
          },
        });
        await tx.document.update({
          where: { id: input.documentId },
          data: { currentVersionId: version.id },
        });
        const threads = await tx.commentThread.findMany({
          where: { documentId: input.documentId, status: "open" },
          select: { id: true, anchor: true },
        });
        let kept = 0;
        const outdatedIds: string[] = [];
        for (const t of threads) {
          let found: boolean;
          try {
            found = locateAnchor(plain, parseTextAnchor(t.anchor)) !== null;
          } catch {
            found = false;
          }
          if (found) kept += 1;
          else outdatedIds.push(t.id);
        }
        if (outdatedIds.length > 0) {
          await tx.commentThread.updateMany({ where: { id: { in: outdatedIds } }, data: { status: "outdated" } });
        }
        return { versionId: version.id, number, reanchored: { kept, outdated: outdatedIds.length } };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  // After the commit: the editor, MCP and the agent loop all publish here.
  await notifyDocumentChange(db, input.documentId, "version");
  return published;
}

export async function getDocument(
  db: DocumentServiceDb,
  documentId: string,
): Promise<{ document: Document; version: DocumentVersion }> {
  const document = await db.document.findUnique({ where: { id: documentId }, include: { currentVersion: true } });
  if (!document || !document.currentVersion) throw new Error("document_not_found");
  const { currentVersion, ...rest } = document;
  return { document: rest, version: currentVersion };
}
