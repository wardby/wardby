/**
 * Export routes under /d/api/: a design's board or prototype as an HTML attachment (computed on
 * request, share-readable), and rendered PNG/PDF jobs (request, poll, download; session only).
 *
 * Output: files are stored content (redacted when written) or renderer results; every file
 * response is an attachment, never rendered by the browser, with a sandboxing CSP as defence in
 * depth. Nothing here logs a body; errors are fixed codes (context.ts STATUS).
 */
import type { ServerResponse } from "node:http";
import type { Viewer } from "../core/documents/access.js";
import {
  exportBytes,
  exportFile,
  exportStatus,
  requestRenderedExport,
  runExport,
  type FileExportFormat,
  type RenderedExportFormat,
} from "../core/documents/exports.js";
import { sendWebJson, WebError, type WebDeps } from "./context.js";

const invalid = (): never => {
  throw new WebError("invalid_request");
};

/** The headers every exported file carries. */
const FILE_HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
  "referrer-policy": "no-referrer",
};

function sendFile(res: ServerResponse, file: { filename: string; mime: string; body: string | Buffer }): void {
  // The file name is our own slug: [a-z0-9-] plus the extension.
  res
    .writeHead(200, {
      ...FILE_HEADERS,
      "content-type": file.mime,
      "content-disposition": `attachment; filename="${file.filename}"`,
      "content-length": Buffer.byteLength(file.body),
    })
    .end(file.body);
}

/** A positive integer, or undefined when absent. */
function versionOf(value: string | null | number | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  if (!/^[1-9][0-9]{0,8}$/.test(text)) invalid();
  return Number(text);
}

const boardOf = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" && value.length <= 80 ? value : invalid();
};

export async function getExportFile(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  params: URLSearchParams,
): Promise<void> {
  const format = params.get("format");
  if (format !== "board-html" && format !== "prototype") invalid();
  const board = boardOf(params.get("board"));
  const versionNumber = versionOf(params.get("version"));
  sendFile(
    res,
    await exportFile(deps.db, {
      documentId,
      viewer,
      format: format as FileExportFormat,
      ...(board ? { board } : {}),
      ...(versionNumber ? { versionNumber } : {}),
    }),
  );
}

export async function postExport(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<void> {
  const format = body.format;
  if (format !== "png" && format !== "pdf") invalid();
  const board = boardOf(body.board);
  const versionNumber = versionOf(body.versionNumber as number | undefined);
  if (!deps.exports) throw new Error("export_renderer_unavailable");
  const { exportId } = await requestRenderedExport(deps.exports, {
    documentId,
    viewer,
    format: format as RenderedExportFormat,
    ...(board ? { board } : {}),
    ...(versionNumber ? { versionNumber } : {}),
  });
  sendWebJson(res, 202, { exportId });
  // After the 202 is written; runExport never throws.
  void runExport(deps.exports, exportId);
}

export async function getExportStatus(
  res: ServerResponse,
  deps: WebDeps,
  exportId: string,
  viewer: Viewer,
): Promise<void> {
  const { status, errorCode } = await exportStatus(deps.db, { exportId, viewer });
  sendWebJson(res, 200, { status, errorCode });
}

export async function getExportBytes(
  res: ServerResponse,
  deps: WebDeps,
  exportId: string,
  viewer: Viewer,
): Promise<void> {
  sendFile(res, await exportBytes(deps.db, { exportId, viewer }));
}
