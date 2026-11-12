import { createHash } from "node:crypto";

export type VersionFormat = "markdown" | "boards-v1";
export type VersionContent =
  { format: "markdown"; markdown: string } | { format: "boards-v1"; files: Record<string, string> };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A Markdown version's text. Throws document_format_mismatch for a design version. */
export function markdownOf(version: { format: string; markdown: string | null }): string {
  if (version.format !== "markdown" || version.markdown === null) throw new Error("document_format_mismatch");
  return version.markdown;
}

/** sha256 hex of a version's content; for designs, over the sorted path and per-file hash list. */
export function contentHash(content: VersionContent): string {
  if (content.format === "markdown") return sha256(content.markdown);
  const lines = Object.keys(content.files)
    .sort()
    .map((path) => `${path}\0${sha256(content.files[path])}\n`);
  return sha256(lines.join(""));
}
