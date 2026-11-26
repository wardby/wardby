/**
 * The schema documents are edited in: StarterKit (without Underline, which Markdown cannot hold, ruling R16)
 * and GFM tables. The page's editor (web/app/extensions.ts adds plan links on top) and the live-editing server
 * use this one list, so both read and write Markdown the same way.
 */
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

/** `collab`: live co-editing, which brings its own (Yjs) undo history in place of StarterKit's. */
export function editorBaseExtensions(opts: { collab?: boolean } = {}) {
  return [
    StarterKit.configure({
      underline: false,
      ...(opts.collab ? { undoRedo: false as const } : {}),
      link: { openOnClick: false, autolink: true, protocols: ["https", "http", "mailto"] },
    }),
    TableKit.configure({ table: { resizable: false } }),
  ];
}
