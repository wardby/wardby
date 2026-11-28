/**
 * The Tiptap editor and the comment highlights. Highlights are ProseMirror
 * decorations, not marks: they never enter the document, so the Markdown the
 * page saves holds no comment markup, and they are mapped through every edit.
 */
import { Editor, Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type * as Y from "yjs";
import { Markdown } from "@tiptap/markdown";
import { keepPlainText } from "../../core/documents/markdown-text.js";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { documentExtensions, type PlanLinkTargets } from "./extensions.js";
import { diffMarks, type DiffMarks } from "./history.js";

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

/** Live co-editing: the shared document, its provider (for carets) and who this person is. */
export interface CollabOptions {
  ydoc: Y.Doc;
  provider: unknown;
  user: { name: string; color: string };
}

/** Another person's caret, drawn with CSSOM only (the page's CSP refuses style attributes from markup). */
function renderCaret(user: { name?: unknown; color?: unknown }): HTMLElement {
  const color = typeof user.color === "string" && /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : "#868e96";
  const caret = document.createElement("span");
  caret.className = "collab-caret";
  caret.style.borderColor = color;
  const label = document.createElement("span");
  label.className = "collab-caret-label";
  label.style.backgroundColor = color;
  // Text only: a name from another browser is never parsed as markup.
  label.textContent = typeof user.name === "string" ? user.name.slice(0, 60) : "Someone";
  caret.append(label);
  return caret;
}

/**
 * `planLinks`: a plan document's link targets, read on every render (they follow the latest payload).
 * `collab`: edit the live document instead of `markdown` (the content comes from it).
 */
export function createEditor(
  element: HTMLElement,
  markdown: string,
  editable: boolean,
  planLinks?: () => PlanLinkTargets | null,
  collab?: CollabOptions,
): Editor {
  const editor = new Editor({
    element,
    // The page's CSP allows no inline <style>; the editor's base styles are in styles.css.
    injectCSS: false,
    editable,
    extensions: [
      ...documentExtensions(planLinks, { collab: Boolean(collab) }),
      Markdown,
      CommentHighlights,
      ...(collab
        ? [
            Collaboration.configure({ document: collab.ydoc, field: "default" }),
            CollaborationCaret.configure({
              provider: collab.provider,
              user: collab.user,
              render: renderCaret,
              selectionRender: () => ({ nodeName: "span", class: "collab-selection" }),
            }),
          ]
        : []),
    ],
    ...(collab ? {} : { content: markdown, contentType: "markdown" as const }),
  });
  // Saves write "&" as "&", not "&amp;" (markdown-text.ts); the server's live documents do the same.
  if (editor.markdown) keepPlainText(editor.markdown);
  return editor;
}

export function getHighlights(editor: Editor): Highlight[] {
  return key.getState(editor.state)?.ranges ?? [];
}

/** Replaces the highlights and/or the active one (not added to undo history). */
export function setHighlights(editor: Editor, update: { ranges?: Highlight[]; active?: string | null }): void {
  editor.view.dispatch(editor.state.tr.setMeta(key, update).setMeta("addToHistory", false));
}

const diffKey = new PluginKey<DecorationSet>("wardby-version-diff");

/** The decorations for a version's changes: inserted text highlighted, deleted text as struck widgets. */
function diffDecorations(doc: EditorState["doc"], marks: DiffMarks): DecorationSet {
  const size = doc.content.size;
  const decos = [
    ...marks.inserts
      .filter((r) => r.to > r.from && r.from >= 0 && r.to <= size)
      .map((r) => Decoration.inline(r.from, r.to, { class: "diff-ins" })),
    ...marks.deletes
      .filter((d) => d.pos >= 0 && d.pos <= size)
      .map((d, i) =>
        Decoration.widget(
          d.pos,
          () => {
            // Text only: the deleted words are set with textContent, never parsed as markup.
            const el = document.createElement("del");
            el.className = "diff-del";
            el.textContent = d.text;
            el.setAttribute("aria-label", `Deleted: ${d.text}`);
            return el;
          },
          { side: -1, key: `del-${i}-${d.pos}`, ignoreSelection: true },
        ),
      ),
  ];
  return DecorationSet.create(doc, decos);
}

/**
 * A read-only editor showing one version with its changes against the
 * version before (`before`: that version's plain text; null shows no
 * changes). Decorations only: the document itself is the version's Markdown.
 */
export function createVersionViewer(element: HTMLElement, markdown: string, before: string | null): Editor {
  const DiffMarksExt = Extension.create({
    name: "wardbyVersionDiff",
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: diffKey,
          state: {
            init: (_config, state) =>
              before === null ? DecorationSet.empty : diffDecorations(state.doc, diffMarks(state.doc, before)),
            apply: (tr, set) => set.map(tr.mapping, tr.doc),
          },
          props: { decorations: (state) => diffKey.getState(state) },
        }),
      ];
    },
  });
  return new Editor({
    element,
    injectCSS: false,
    editable: false,
    extensions: [...documentExtensions(), Markdown, DiffMarksExt],
    content: markdown,
    contentType: "markdown",
  });
}
