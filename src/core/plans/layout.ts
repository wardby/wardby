/**
 * The plan folder's layout (docs/private spec §3): top-level Markdown files are documents
 * (plan.md first), each subfolder in board format v1 is one design, and the rest is ignored and
 * listed in the reply. Pure: no I/O. File content is never put in an error.
 */
import { MAX_SEND_MARKDOWN_CHARS } from "../documents/agent-formats.js";
import { BoardFormatError, MANIFEST_PATH, normalizeDesign } from "../documents/boards/format.js";
import { MAX_MARKDOWN_BYTES } from "../documents/limits.js";
import type { PlanFile } from "../../coding/plan-files/store.js";

export const MAX_PLAN_DOCUMENTS = 20;

export interface PlanLayoutDocument {
  kind: "document" | "design";
  /** The file ("plan.md") or, for a design, its folder with a trailing slash ("screens/"). */
  path: string;
  title: string;
  markdown?: string;
  files?: Record<string, string>;
}

export type PlanLayout =
  | { ok: true; documents: PlanLayoutDocument[]; ignored: string[] }
  | { ok: false; error: "plan_too_large" | "plan_empty" };

function titleOf(markdown: string, fallback: string): string {
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return (heading?.[1] ?? fallback).slice(0, 200);
}

/** A design folder's files as a design, "too_large", or "invalid" (not in board format: ignored). */
function checkDesign(files: Record<string, string>): "ok" | "too_large" | "invalid" {
  if (files[MANIFEST_PATH] === undefined) return "invalid";
  // R21: each design within the document limit, so createDocument never throws mid-set.
  const bytes = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  if (bytes > MAX_MARKDOWN_BYTES) return "too_large";
  try {
    normalizeDesign(files);
    return "ok";
  } catch (err) {
    if (err instanceof BoardFormatError) return "invalid";
    // document_too_large or board_too_large: over a limit.
    return "too_large";
  }
}

const order = (a: PlanLayoutDocument, b: PlanLayoutDocument): number => {
  if (a.path === "plan.md") return -1;
  if (b.path === "plan.md") return 1;
  if (a.kind !== b.kind) return a.kind === "document" ? -1 : 1;
  return a.path.localeCompare(b.path);
};

export function parsePlanLayout(files: readonly PlanFile[]): PlanLayout {
  const documents: PlanLayoutDocument[] = [];
  const ignored: string[] = [];
  const designs = new Map<string, Record<string, string>>();
  for (const file of files) {
    const segments = file.path.split("/");
    if (segments.length === 1 && file.path.endsWith(".md")) {
      if (file.content.length > MAX_SEND_MARKDOWN_CHARS) return { ok: false, error: "plan_too_large" };
      documents.push({
        kind: "document",
        path: file.path,
        title: titleOf(file.content, file.path),
        markdown: file.content,
      });
    } else if (segments.length >= 2) {
      const folder = segments[0];
      const design = designs.get(folder) ?? {};
      design[segments.slice(1).join("/")] = file.content;
      designs.set(folder, design);
    } else {
      ignored.push(file.path);
    }
  }
  for (const [folder, design] of [...designs].sort(([a], [b]) => a.localeCompare(b))) {
    const check = checkDesign(design);
    if (check === "too_large") return { ok: false, error: "plan_too_large" };
    if (check === "invalid") {
      ignored.push(...Object.keys(design).map((inner) => `${folder}/${inner}`));
      continue;
    }
    documents.push({ kind: "design", path: `${folder}/`, title: folder, files: design });
  }
  documents.sort(order);
  if (documents.length === 0) return { ok: false, error: "plan_empty" };
  if (documents.length > MAX_PLAN_DOCUMENTS) return { ok: false, error: "plan_too_large" };
  return { ok: true, documents, ignored: ignored.sort() };
}
