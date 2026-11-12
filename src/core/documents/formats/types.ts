import type { TextAnchor } from "../anchors.js";
import type { VersionContent } from "../content.js";
import type { ElementAnchor } from "../element-anchors.js";
import type { VersionWarning } from "../warnings.js";

export type Anchor = TextAnchor | ElementAnchor;
export type DocumentKind = "document" | "design";
export interface PreparedContent {
  content: VersionContent;
  warnings: VersionWarning[];
}

/**
 * What differs between a Markdown document and a design. Everything else (versions, threads,
 * access, share links, live events, the agent loop) is shared code that asks this adapter.
 */
export interface DocumentFormat {
  readonly kind: DocumentKind;
  readonly format: VersionContent["format"];
  /** Limits, format check and exact-value redaction of `secretValues`: what is stored. Throws on a refusal. */
  prepare(content: VersionContent, secretValues: readonly string[]): PreparedContent;
  /** Ids of the threads whose anchor no longer finds its place in `content`. */
  outdated(content: VersionContent, threads: readonly { id: string; anchor: unknown }[]): string[];
  /** Throws comment_anchor_invalid. */
  parseAnchor(value: unknown): Anchor;
  /** Whether the anchor can point into `content` at all (a design: its board is listed). */
  anchorFits(content: VersionContent, anchor: Anchor): boolean;
  /** The anchor's caller-written string fields with `secretValues` removed; still a valid anchor (or throws comment_anchor_invalid). */
  redactAnchor(anchor: Anchor, secretValues: readonly string[]): Anchor;
  /** Plain text for agents. */
  anchorLabel(anchor: Anchor): string;
}
