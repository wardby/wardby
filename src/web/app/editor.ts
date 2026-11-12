/**
 * The Tiptap editor and the comment highlights. Highlights are ProseMirror
 * decorations, not marks: they never enter the document, so the Markdown the
 * page saves holds no comment markup, and they are mapped through every edit.
 */
import { Editor, Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { documentExtensions } from "./extensions.js";

export interface Highlight {
  /** A thread id, or "draft" while the composer is open. */
  id: string;
  from: number;
  to: number;
}

interface HighlightState {
  ranges: Highlight[];
  active: string | null;
  set: DecorationSet;
}

const key = new PluginKey<HighlightState>("wardby-comment-highlights");

function decorations(state: EditorState | { doc: EditorState["doc"] }, ranges: Highlight[], active: string | null) {
  return DecorationSet.create(
    state.doc,
    ranges
      .filter((r) => r.to > r.from)
      .map((r) =>
        Decoration.inline(
          r.from,
          r.to,
          {
            class: `comment-mark${r.id === active ? " active" : ""}${r.id === "draft" ? " draft" : ""}`,
            "data-comment-id": r.id,
          },
          { inclusiveStart: false, inclusiveEnd: false },
        ),
      ),
  );
}

const CommentHighlights = Extension.create({
  name: "wardbyCommentHighlights",
  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightState>({
        key,
        state: {
          init: (_config, state) => ({ ranges: [], active: null, set: DecorationSet.create(state.doc, []) }),
          apply(tr: Transaction, value: HighlightState, _old, state: EditorState): HighlightState {
            const meta = tr.getMeta(key) as Partial<Pick<HighlightState, "ranges" | "active">> | undefined;
            let ranges = value.ranges;
            if (tr.docChanged) {
              ranges = ranges
                .map((r) => ({ id: r.id, from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) }))
                .filter((r) => r.to > r.from);
            }
            if (meta?.ranges) ranges = meta.ranges;
            const active = meta && "active" in meta ? (meta.active ?? null) : value.active;
            if (!meta && !tr.docChanged) return value;
            return { ranges, active, set: decorations(state, ranges, active) };
          },
        },
        props: { decorations: (state) => key.getState(state)?.set },
      }),
    ];
  },
});

export function createEditor(element: HTMLElement, markdown: string, editable: boolean): Editor {
  return new Editor({
    element,
    // The page's CSP allows no inline <style>; the editor's base styles are in styles.css.
    injectCSS: false,
    editable,
    extensions: [...documentExtensions(), Markdown, CommentHighlights],
    content: markdown,
    contentType: "markdown",
  });
}

export function getHighlights(editor: Editor): Highlight[] {
  return key.getState(editor.state)?.ranges ?? [];
}

/** Replaces the highlights and/or the active one (not added to undo history). */
export function setHighlights(editor: Editor, update: { ranges?: Highlight[]; active?: string | null }): void {
  editor.view.dispatch(editor.state.tr.setMeta(key, update).setMeta("addToHistory", false));
}
