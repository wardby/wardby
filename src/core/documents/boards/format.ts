/**
 * Board format v1 (spec "Board format v1"): the manifest, the size limits and the check that
 * turns an agent's or person's files into a stored design version. Problems are our own fixed
 * text plus board ids that passed the id pattern; caller text (paths, URLs, ids that failed
 * validation) is counted, never quoted.
 */
import { z } from "zod";
import type { VersionWarning } from "../warnings.js";
import { BoardFormatError } from "./errors.js";
import { BOARD_ID } from "./ids.js";
import { sanitizeBoard } from "./sanitize.js";

export const BOARD_SOFT_BYTES = 40 * 1024;
export const BOARD_MAX_BYTES = 512 * 1024;
export const DESIGN_VERSION_MAX_BYTES = 2 * 1024 * 1024;
export const BRAND_MAX_BYTES = 64 * 1024;
export const MAX_BOARDS = 50;
export { BOARD_ID };
export const MANIFEST_PATH = "manifest.json";
export const BRAND_PATH = "brand.md";
export const boardPath = (id: string): string => `boards/${id}.html`;

export interface BoardEntry {
  id: string;
  name: string;
  file: string;
  width: number;
}
export interface Manifest {
  title: string;
  boards: BoardEntry[];
}

export { BoardFormatError };

const manifestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  boards: z
    .array(
      z.object({
        id: z.string().regex(BOARD_ID),
        name: z.string().trim().min(1).max(80),
        file: z.string(),
        width: z.number().int().min(320).max(2560).default(1280),
      }),
    )
    .min(1)
    .max(MAX_BOARDS),
});

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BoardFormatError(["manifest.json is not valid JSON"]);
  }
  const r = manifestSchema.safeParse(raw);
  if (!r.success) {
    // Paths are our schema's keys and array indexes; codes are zod's fixed names. No values.
    throw new BoardFormatError(
      r.error.issues.slice(0, 10).map((i) => `manifest.json ${i.path.map(String).join(".") || "(root)"}: ${i.code}`),
    );
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const b of r.data.boards) {
    if (seen.has(b.id)) problems.push(`manifest.json: board id ${b.id} is listed twice`);
    seen.add(b.id);
    if (b.file !== boardPath(b.id)) problems.push(`manifest.json: board ${b.id} file must be ${boardPath(b.id)}`);
  }
  if (problems.length) throw new BoardFormatError(problems);
  return {
    title: r.data.title,
    boards: r.data.boards.map((b) => ({ id: b.id, name: b.name, file: b.file, width: b.width })),
  };
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Checks a design's files against board format v1 and returns them normalised: the manifest
 * re-serialised, each board sanitised (sanitize.ts), brand.md kept if present. Pure: no I/O and
 * no secrets (the caller redacts afterwards). Throws BoardFormatError, board_too_large (a board
 * over 512 KB) or document_too_large (the version over 2 MiB).
 */
export function normalizeDesign(files: Record<string, string>): {
  files: Record<string, string>;
  manifest: Manifest;
  warnings: VersionWarning[];
} {
  const notText = Object.values(files).filter((t) => typeof t !== "string").length;
  if (notText) throw new BoardFormatError([`${plural(notText, "file is", "files are")} not text`]);
  const total = Object.values(files).reduce((n, t) => n + bytes(t), 0);
  if (total > DESIGN_VERSION_MAX_BYTES) throw new Error("document_too_large");
  if (!Object.hasOwn(files, MANIFEST_PATH)) throw new BoardFormatError(["manifest.json is missing"]);
  const manifest = parseManifest(files[MANIFEST_PATH]);

  const listed = new Set([MANIFEST_PATH, BRAND_PATH, ...manifest.boards.map((b) => b.file)]);
  const problems: string[] = [];
  const unlisted = Object.keys(files).filter((p) => !listed.has(p)).length;
  if (unlisted) problems.push(`${plural(unlisted, "file is", "files are")} not listed in manifest.json`);

  const out: Record<string, string> = { [MANIFEST_PATH]: `${JSON.stringify(manifest, null, 2)}\n` };
  const warnings: VersionWarning[] = [];
  if (Object.hasOwn(files, BRAND_PATH)) {
    if (bytes(files[BRAND_PATH]) > BRAND_MAX_BYTES) problems.push("brand.md is over 64 KB");
    out[BRAND_PATH] = files[BRAND_PATH];
  }
  for (const b of manifest.boards) {
    if (!Object.hasOwn(files, b.file)) {
      problems.push(`board ${b.id}: ${b.file} is missing`);
      continue;
    }
    const text = files[b.file];
    if (bytes(text) > BOARD_MAX_BYTES) throw new Error("board_too_large");
    const s = sanitizeBoard(text);
    problems.push(...s.problems.map((p) => `board ${b.id}: ${p}`));
    const r = s.removed;
    const parts = [
      r.scripts && plural(r.scripts, "script", "scripts"),
      r.handlers && plural(r.handlers, "event handler attribute", "event handler attributes"),
      r.jsUrls && plural(r.jsUrls, "javascript: link", "javascript: links"),
      r.other && plural(r.other, "unsupported element", "unsupported elements"),
    ].filter(Boolean);
    if (parts.length) warnings.push({ kind: "sanitized", board: b.id, message: `removed ${parts.join(", ")}` });
    const size = bytes(s.html);
    if (size > BOARD_SOFT_BYTES) {
      warnings.push({
        kind: "size",
        board: b.id,
        message: `${Math.round(size / 1024)} KB is over the 40 KB recommended size`,
      });
    }
    out[b.file] = s.html;
  }
  if (problems.length) throw new BoardFormatError(problems);
  return { files: out, manifest, warnings };
}
