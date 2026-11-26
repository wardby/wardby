/**
 * What the live server needs from a kind of document (spec "common interfaces for like systems"): Markdown documents
 * and designs share one live server — sign-in, access, review lock, tickets, epoch, leases, replicas — and differ
 * only in these steps. Documents: formats/markdown.ts.
 */
import type * as Y from "yjs";

/** A stored version, as the live server reads it. */
export interface LiveVersion {
  number: number;
  /** The version it was based on (null for the first). */
  baseNumber: number | null;
  format: string;
  markdown: string | null;
}

/** What a checkpoint publishes (publishVersion's content fields: a design's complete file set). */
export type LiveContent = { markdown: string } | { files: Record<string, string> };

export interface LiveFormat {
  /** A new live document from the current version, or null when this version cannot be edited live. */
  seed(documentId: string, v: LiveVersion): Promise<Y.Doc | null>;
  /** What this format compares checkpoints against, read from a stored version. */
  versionText(documentId: string, v: LiveVersion): Promise<string>;
  /**
   * What a checkpoint would publish now and the text it compares next time, or null when nothing changed since
   * `since`. Runs synchronously from the state it is given, so the version is exactly that state.
   */
  snapshot(doc: Y.Doc, since: string): { content: LiveContent; text: string } | null;
  /** Version `v` merged into the live document from its base state, or "reset" when it cannot be. */
  merge(
    documentId: string,
    base: Uint8Array,
    v: LiveVersion,
  ): Promise<{ update: Uint8Array; versionState: Uint8Array; text: string } | "reset">;
  /** Why an incoming edit is refused (scratch = the live document with the edit applied), or null. */
  refuse(scratch: Y.Doc, secretValues: string[]): string | null;
  /** Comment anchors follow the live document after a merge or before a checkpoint. */
  refreshAnchors(documentId: string, doc: Y.Doc): Promise<void>;
}
