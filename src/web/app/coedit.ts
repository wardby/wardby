/**
 * Live co-editing of a Markdown document: the shared join (live-join.ts) plus comment positions kept in the shared
 * document, so a comment follows its words through everyone's edits.
 */
import type { Editor } from "@tiptap/core";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import type { Api, Bootstrap } from "./api.js";
import { caretColor, joinLiveDocument, type LiveJoin } from "./live-join.js";
import type { LiveAnchors } from "./text-surface.js";

/** The shared-document field Tiptap's Collaboration extension binds to (core/documents/live/markdown.ts). */
const FIELD = "default";
const ANCHORS = "wardby-anchors";

export interface Coedit extends LiveJoin {
  /** Comment positions in the shared document, for the comment highlights. */
  anchors(editor: Editor): LiveAnchors;
}

export { caretColor };

/** Joins a Markdown document's live editing (the shared path is live-join.ts), adding comment positions. */
export async function joinLive(boot: Bootstrap, api: Api, who: string): Promise<Coedit | null> {
  const joined = await joinLiveDocument(boot, api, who);
  return joined ? { ...joined, anchors: (editor) => liveAnchors(joined.ydoc, editor) } : null;
}

/** Comment ranges as Yjs relative positions in the shared document, so they follow everyone's edits. */
function liveAnchors(ydoc: Y.Doc, editor: Editor): LiveAnchors {
  const anchors = ydoc.getMap<{ from: unknown; to: unknown }>(ANCHORS);
  const fragment = ydoc.getXmlFragment(FIELD);
  const mapping = () => ySyncPluginKey.getState(editor.state)?.binding?.mapping;
  type Pair = { from: unknown; to: unknown };
  const capture = (from: number, to: number): Pair | null => {
    const m = mapping();
    if (!m) return null;
    return {
      from: Y.relativePositionToJSON(absolutePositionToRelativePosition(from, fragment, m)),
      to: Y.relativePositionToJSON(absolutePositionToRelativePosition(to, fragment, m)),
    };
  };
  const resolvePair = (rel: Pair | null) => {
    const m = mapping();
    if (!rel || !m) return null;
    const from = relativePositionToAbsolutePosition(ydoc, fragment, Y.createRelativePositionFromJSON(rel.from), m);
    const to = relativePositionToAbsolutePosition(ydoc, fragment, Y.createRelativePositionFromJSON(rel.to), m);
    return from === null || to === null ? null : { from, to };
  };
  return {
    has: (id) => anchors.has(id),
    resolve: (id) => resolvePair(anchors.get(id) ?? null),
    store: (id, from, to) => {
      const captured = capture(from, to);
      if (captured && !anchors.has(id)) anchors.set(id, captured);
    },
    capture: (from, to) => capture(from, to),
    resolveCaptured: (captured) => resolvePair(captured as Pair | null),
    adopt: (id, captured) => {
      if (captured && !anchors.has(id)) anchors.set(id, captured as Pair);
    },
  };
}
