/**
 * The schema documents are edited in: StarterKit (without Underline, which Markdown cannot hold, ruling R16)
 * and GFM tables. The page's editor (web/app/extensions.ts adds plan links on top) and the live-editing server
 * use this one list, so both read and write Markdown the same way.
 */
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

export function editorBaseExtensions() {
  return [
    StarterKit.configure({
      underline: false,
      link: { openOnClick: false, autolink: true, protocols: ["https", "http", "mailto"] },
    }),
    TableKit.configure({ table: { resizable: false } }),
  ];
}
