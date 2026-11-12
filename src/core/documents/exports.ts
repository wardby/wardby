/**
 * Document exports (spec "Export"), one path for both kinds. A design exports as a file computed on
 * request (board HTML, whole-prototype HTML) or as a rendered job (PNG of one board, PDF of all
 * boards); a Markdown document exports as a rendered PDF only. Rendered jobs run in a `Renderer`
 * (the renderer service; null = not configured) and are stored in DocumentExport for an hour.
 *
 * Secrets: every input is stored content, redacted against the document agent's secret values when
 * it was written (service.ts), so a file or a renderer request holds none (tests with a fake value
 * prove it for board HTML, prototype HTML and the HTML sent to the renderer). Request bodies and
 * results are never logged: the only log fields are the export id and a fixed code.
 */
import type { Document, DocumentVersion, PrismaClient } from "#prisma";
import { RateLimitError, type RateLimiter } from "../../mcp/auth/self-hosted/rate-limit.js";
import { logger } from "../logger.js";
import { requireDocumentAccess, type Viewer } from "./access.js";
import { documentHourlyLimiter } from "./agent-loop.js";
import { exportSlug, prototypeFile } from "./boards/export.js";
import { MANIFEST_PATH, parseManifest, type Manifest } from "./boards/format.js";
import { frameHtml } from "./boards/frames.js";
import { loadContent } from "./files.js";
import { MARKDOWN_PDF_WIDTH, markdownPrintFile, markdownToSafeHtml } from "./markdown-export.js";

const log = logger.child({ module: "documents-exports" });

export type FileExportFormat = "board-html" | "prototype";
export type RenderedExportFormat = "png" | "pdf";

export interface Renderer {
  png(input: { html: string; width: number }): Promise<Buffer>;
  pdf(input: { boards: { html: string; width: number }[] }): Promise<Buffer>;
}

export interface ExportDeps {
  db: PrismaClient;
  /** The renderer service; null = PNG and PDF are not available (export_renderer_unavailable). */
  renderer: Renderer | null;
  /** Wakes a scaled-to-zero renderer before a job renders; a throw fails the job as unavailable. */
  wake?: (exportId: string) => Promise<void>;
  /** Counts requests per document; default: the Postgres limiter over one-hour windows. */
  rateLimiter?: RateLimiter;
}

export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
export const EXPORTS_PER_DOCUMENT_HOUR = 30;
export const EXPORT_RATE_BUCKET = "document-export";
export const EXPORT_TTL_MS = 3_600_000;
export const EXPORT_STALE_MS = 600_000;

const EXPORT_CODES = new Set([
  "export_format_unsupported",
  "export_sign_in_required",
  "export_not_found",
  "export_rate_limited",
  "export_too_large",
  "export_renderer_unavailable",
  "export_failed",
]);
const codeOf = (err: unknown): string =>
  err instanceof Error && EXPORT_CODES.has(err.message) ? err.message : "export_failed";

type Source = {
  doc: Document;
  version: DocumentVersion;
  content: Awaited<ReturnType<typeof loadContent>>;
};

/** The document (read access required) and the requested or current version with its content. */
async function source(db: PrismaClient, documentId: string, viewer: Viewer, versionNumber?: number): Promise<Source> {
  const doc = await requireDocumentAccess(db, documentId, viewer, "read");
  let version: DocumentVersion | null;
  if (versionNumber !== undefined) {
    version = await db.documentVersion.findUnique({
      where: { documentId_number: { documentId, number: versionNumber } },
    });
    if (!version) throw new Error("document_not_found");
  } else {
    version = doc.currentVersionId
      ? await db.documentVersion.findUnique({ where: { id: doc.currentVersionId } })
      : null;
    if (!version) throw new Error("document_not_found");
  }
  return { doc, version, content: await loadContent(db, version) };
}

interface DesignParts {
  files: Record<string, string>;
  manifest: Manifest;
}

function designParts(content: Source["content"]): DesignParts {
  if (content.format !== "boards-v1") throw new Error("export_format_unsupported");
  return { files: content.files, manifest: parseManifest(content.files[MANIFEST_PATH] ?? "") };
}

/** A board the manifest lists (export_not_found otherwise) and its stored file. */
function boardOf(parts: DesignParts, id: string) {
  const entry = parts.manifest.boards.find((b) => b.id === id);
  const html = entry ? parts.files[entry.file] : undefined;
  if (!entry || html === undefined) throw new Error("export_not_found");
  return { entry, html };
}

const boardIds = (m: Manifest) => new Set(m.boards.map((b) => b.id));

export async function exportFile(
  db: PrismaClient,
  input: { documentId: string; viewer: Viewer; format: FileExportFormat; board?: string; versionNumber?: number },
): Promise<{ filename: string; mime: string; body: string }> {
  const { doc, content } = await source(db, input.documentId, input.viewer, input.versionNumber);
  if (doc.kind !== "design") throw new Error("export_format_unsupported");
  const parts = designParts(content);
  const slug = exportSlug(doc.title);
  if (input.format === "board-html") {
    if (!input.board) throw new Error("export_format_unsupported");
    const { entry, html } = boardOf(parts, input.board);
    return { filename: `${slug}-${entry.id}.html`, mime: "text/html", body: html };
  }
  if (input.format !== "prototype") throw new Error("export_format_unsupported");
  const ids = boardIds(parts.manifest);
  const boards = parts.manifest.boards
    .filter((b) => typeof parts.files[b.file] === "string")
    .map((b) => ({ id: b.id, name: b.name, width: b.width, html: frameHtml(parts.files[b.file], "play", ids) }));
  return {
    filename: `${slug}-prototype.html`,
    mime: "text/html",
    body: prototypeFile({ title: doc.title, boards }),
  };
}

const owner = (viewer: Viewer) =>
  viewer.kind === "principal" ? { requestedById: viewer.principalId } : { guestId: viewer.guestId };

export async function requestRenderedExport(
  deps: ExportDeps,
  input: { documentId: string; viewer: Viewer; format: RenderedExportFormat; board?: string; versionNumber?: number },
): Promise<{ exportId: string }> {
  const { db } = deps;
  const { doc, version, content } = await source(db, input.documentId, input.viewer, input.versionNumber);
  let board: string | undefined;
  if (doc.kind === "design") {
    const parts = designParts(content);
    if (input.format === "png") {
      if (!input.board) throw new Error("export_format_unsupported");
      board = boardOf(parts, input.board).entry.id;
    } else if (input.format !== "pdf") {
      throw new Error("export_format_unsupported");
    }
  } else if (input.format !== "pdf") {
    // A Markdown document exports as PDF only.
    throw new Error("export_format_unsupported");
  }
  // An anonymous share-link reader (no guest session) cannot ask for a rendered file.
  if (input.viewer.kind === "guest" && input.viewer.guestId === "") throw new Error("export_sign_in_required");
  try {
    await (deps.rateLimiter ?? documentHourlyLimiter(db)).check(EXPORT_RATE_BUCKET, doc.id, EXPORTS_PER_DOCUMENT_HOUR);
  } catch (err) {
    if (err instanceof RateLimitError) throw new Error("export_rate_limited", { cause: err });
    throw err;
  }
  const row = await db.documentExport.create({
    data: {
      documentId: doc.id,
      versionId: version.id,
      format: input.format,
      ...(board ? { board } : {}),
      ...owner(input.viewer),
    },
    select: { id: true },
  });
  return { exportId: row.id };
}

async function fail(db: PrismaClient, exportId: string, code: string): Promise<void> {
  await db.documentExport.update({
    where: { id: exportId },
    data: { status: "failed", errorCode: code, finishedAt: new Date() },
  });
}

/** Renders a queued export and stores the bytes. Never throws; failures are stored as a fixed code. */
export async function runExport(deps: ExportDeps, exportId: string): Promise<void> {
  const { db } = deps;
  try {
    const claimed = await db.documentExport.updateMany({
      where: { id: exportId, status: "queued" },
      data: { status: "running" },
    });
    if (claimed.count === 0) return;
    try {
      const row = await db.documentExport.findUniqueOrThrow({ where: { id: exportId } });
      if (!deps.renderer) throw new Error("export_renderer_unavailable");
      if (deps.wake) {
        try {
          await deps.wake(exportId);
        } catch {
          throw new Error("export_renderer_unavailable");
        }
      }
      const doc = await db.document.findUniqueOrThrow({ where: { id: row.documentId } });
      const version = await db.documentVersion.findUniqueOrThrow({ where: { id: row.versionId } });
      const content = await loadContent(db, version);
      let bytes: Buffer;
      let mime: string;
      if (doc.kind === "design") {
        const parts = designParts(content);
        const ids = boardIds(parts.manifest);
        // Overview mode: a rendered image has no links.
        const framed = (file: string) => frameHtml(parts.files[file] ?? "", "overview", ids);
        if (row.format === "png") {
          const { entry } = boardOf(parts, row.board ?? "");
          bytes = await deps.renderer.png({ html: framed(entry.file), width: entry.width });
          mime = "image/png";
        } else {
          const boards = parts.manifest.boards.map((b) => ({ html: framed(b.file), width: b.width }));
          bytes = await deps.renderer.pdf({ boards });
          mime = "application/pdf";
        }
      } else {
        if (content.format !== "markdown") throw new Error("export_failed");
        const html = markdownPrintFile(doc.title, markdownToSafeHtml(content.markdown).html);
        bytes = await deps.renderer.pdf({ boards: [{ html, width: MARKDOWN_PDF_WIDTH }] });
        mime = "application/pdf";
      }
      if (bytes.length > MAX_EXPORT_BYTES) throw new Error("export_too_large");
      await db.documentExport.update({
        where: { id: exportId },
        data: { status: "done", mime, data: new Uint8Array(bytes), size: bytes.length, finishedAt: new Date() },
      });
    } catch (err) {
      const code = codeOf(err);
      log.warn({ exportId, code }, "export failed");
      await fail(db, exportId, code);
    }
  } catch (err) {
    log.error(
      { exportId, errorName: err instanceof Error ? err.name : typeof err },
      "export job could not be recorded",
    );
  }
}

async function ownRow(db: PrismaClient, exportId: string, viewer: Viewer) {
  const row = await db.documentExport.findUnique({ where: { id: exportId } });
  const mine =
    row &&
    (viewer.kind === "principal"
      ? row.requestedById === viewer.principalId
      : viewer.guestId !== "" && row.guestId === viewer.guestId);
  if (!row || !mine) throw new Error("export_not_found");
  try {
    await requireDocumentAccess(db, row.documentId, viewer, "read");
  } catch {
    throw new Error("export_not_found");
  }
  return row;
}

export async function exportStatus(
  db: PrismaClient,
  input: { exportId: string; viewer: Viewer },
): Promise<{ id: string; status: string; errorCode: string | null; format: string }> {
  const row = await ownRow(db, input.exportId, input.viewer);
  return { id: row.id, status: row.status, errorCode: row.errorCode, format: row.format };
}

export async function exportBytes(
  db: PrismaClient,
  input: { exportId: string; viewer: Viewer },
): Promise<{ filename: string; mime: string; body: Buffer }> {
  const row = await ownRow(db, input.exportId, input.viewer);
  if (row.status !== "done" || !row.data || !row.mime) throw new Error("export_not_found");
  const doc = await db.document.findUnique({ where: { id: row.documentId }, select: { title: true, kind: true } });
  if (!doc) throw new Error("export_not_found");
  const filename =
    doc.kind === "design"
      ? `${exportSlug(doc.title)}-${row.board ?? "boards"}.${row.format}`
      : `${exportSlug(doc.title, "document")}.${row.format}`;
  return { filename, mime: row.mime, body: Buffer.from(row.data) };
}

/** Deletes exports past their hour and fails jobs stuck queued or running. */
export async function sweepExports(
  db: Pick<PrismaClient, "documentExport">,
  now: Date = new Date(),
): Promise<{ deleted: number; failed: number }> {
  const deleted = await db.documentExport.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - EXPORT_TTL_MS) } },
  });
  const failed = await db.documentExport.updateMany({
    where: {
      status: { in: ["queued", "running"] },
      createdAt: { lt: new Date(now.getTime() - EXPORT_STALE_MS) },
    },
    data: { status: "failed", errorCode: "export_failed", finishedAt: now },
  });
  return { deleted: deleted.count, failed: failed.count };
}
