/**
 * The document schema the page edits in: StarterKit (without Underline, which
 * Markdown cannot hold, ruling R16) and GFM tables. The editor, the
 * round-trip check and the anchoring tests all use this one list.
 */
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

export function documentExtensions() {
  return [
    StarterKit.configure({
      underline: false,
      link: { openOnClick: false, autolink: true, protocols: ["https", "http", "mailto"] },
    }),
    TableKit.configure({ table: { resizable: false } }),
  ];
}
