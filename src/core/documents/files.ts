/**
 * A design version's files (DocumentFile rows) over the per-document text store (DocumentContent,
 * keyed by sha256). Text is written here only after the format adapter prepared it (normalised and
 * redacted), so reading it back opens no new secret path.
 */
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "#prisma";
import type { VersionContent } from "./content.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const MIME: Record<string, string> = { ".json": "application/json", ".html": "text/html", ".md": "text/markdown" };
const mimeFor = (path: string) => MIME[path.slice(path.lastIndexOf("."))] ?? "text/plain";

/**
 * Writes a design version's files; text already stored for this document (same hash) is reused.
 * Two statements whatever the file count, so the publish transaction (Serializable) stays short.
 */
export async function storeVersionFiles(
  tx: Prisma.TransactionClient,
  documentId: string,
  versionId: string,
  files: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(files).map(([path, text]) => ({ path, text, hash: sha256(text) }));
  if (entries.length === 0) return;
  const unique = new Map(entries.map((e) => [e.hash, e.text]));
  await tx.documentContent.createMany({
    data: [...unique].map(([hash, text]) => ({ documentId, hash, text, size: Buffer.byteLength(text, "utf8") })),
    skipDuplicates: true,
  });
  await tx.documentFile.createMany({
    data: entries.map((e) => ({ versionId, path: e.path, documentId, hash: e.hash, mime: mimeFor(e.path) })),
  });
}

/** A design version's files, or only `paths` of them when given. */
export async function loadVersionFiles(
  db: Pick<PrismaClient, "documentFile">,
  versionId: string,
  paths?: readonly string[],
): Promise<Record<string, string>> {
  const rows = await db.documentFile.findMany({
    where: { versionId, ...(paths ? { path: { in: [...paths] } } : {}) },
    orderBy: { path: "asc" },
    select: { path: true, content: { select: { text: true } } },
  });
  return Object.fromEntries(rows.map((r) => [r.path, r.content.text]));
}

/** A version's content: its Markdown, or its files for a design. */
export async function loadContent(
  db: Pick<PrismaClient, "documentFile">,
  version: { id: string; format: string; markdown: string | null },
): Promise<VersionContent> {
  if (version.format === "boards-v1") return { format: "boards-v1", files: await loadVersionFiles(db, version.id) };
  if (version.format !== "markdown" || version.markdown === null) throw new Error("document_format_mismatch");
  return { format: "markdown", markdown: version.markdown };
}
