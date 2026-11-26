/**
 * Markdown ⇄ the live (Yjs) document, in the editor's own schema (editor-schema.ts), so the server reads and
 * writes Markdown exactly as the page's editor does. LIVE_FIELD is the XML fragment Tiptap's Collaboration
 * extension binds to.
 */
import { getSchema, resolveExtensions } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node as PMNode } from "@tiptap/pm/model";
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { editorBaseExtensions } from "../editor-schema.js";

export const LIVE_FIELD = "default";

const extensions = editorBaseExtensions();
export const liveSchema = getSchema(extensions);
// Built as web/app/history.ts builds its manager (flattened kits), so parse and serialize match the page.
const markdown = new MarkdownManager({ extensions: resolveExtensions(extensions) });

export function markdownToDoc(source: string): PMNode {
  return PMNode.fromJSON(liveSchema, markdown.parse(source));
}

export function seedLiveDoc(source: string): Y.Doc {
  return prosemirrorJSONToYDoc(liveSchema, markdown.parse(source), LIVE_FIELD);
}

export function liveDocToMarkdown(doc: Y.Doc): string {
  return markdown.serialize(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(LIVE_FIELD)));
}

/** The editor's form of some Markdown: two texts that differ only in formatting are equal here. */
export function normalMarkdown(source: string): string {
  return markdown
    .serialize(markdown.parse(source))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
