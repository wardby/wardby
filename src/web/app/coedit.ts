/**
 * Joining live co-editing (/d/live/<id>): the shared Yjs document, other people's carets, and comment
 * positions kept in the shared document so a comment follows its words through everyone's edits.
 *
 * The page joins before it draws the editor and falls back to saving versions the usual way when it cannot
 * (no session, a proxy without WebSockets, a document the editor cannot keep): joinLive resolves null then.
 * The server's refusals arrive as codes: live_state_stale (this page holds a history the server no longer has)
 * and edit_refused (an edit would have shown a secret value) both reload the page from the server's copy, once.
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Editor } from "@tiptap/core";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import type { Api, Bootstrap } from "./api.js";
import type { LiveAnchors } from "./text-surface.js";

/** The shared-document field Tiptap's Collaboration extension binds to (core/documents/live/markdown.ts). */
const FIELD = "default";
const META = "wardby-meta";
const ANCHORS = "wardby-anchors";
const JOIN_TIMEOUT_MS = 4000;
/** Set before a reload the server asked for, so a second refusal is shown instead of reloading again. */
const RELOADED = "wardby-live-reloaded";
const REFUSED = "wardby-live-refused";

export interface Coedit {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  /** Comment positions in the shared document, for the comment highlights. */
  anchors(editor: Editor): LiveAnchors;
  /** Called after each later sync (a reconnect): the page places comments again. */
  onResync(cb: () => void): void;
  /** Set when the server refused an edit and the page reloaded: the message to show once. */
  refusedNotice: string | null;
}

const COLORS = ["#d9480f", "#1971c2", "#2f9e44", "#9c36b5", "#e8590c", "#0c8599", "#c2255c", "#5c940d"];

/** A stable colour per name, so a person's caret keeps its colour across reloads. */
export function caretColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function reloadOnce(documentId: string): void {
  try {
    if (sessionStorage.getItem(RELOADED) === documentId) return;
    sessionStorage.setItem(RELOADED, documentId);
  } catch {
    return; // without storage, never risk a reload loop
  }
  location.reload();
}

export function joinLive(boot: Bootstrap, api: Api, who: string): Promise<Coedit | null> {
  const ydoc = new Y.Doc();
  let settled = false;
  let resync: (() => void) | null = null;
  let refusedNotice: string | null = null;
  try {
    if (sessionStorage.getItem(REFUSED) === boot.documentId) {
      refusedNotice = "Your last edit contained a secret value, so it was not kept.";
      sessionStorage.removeItem(REFUSED);
    }
  } catch {
    /* storage unavailable: no notice */
  }
  return new Promise((resolve) => {
    const giveUp = () => {
      if (settled) return;
      settled = true;
      provider.destroy();
      resolve(null);
    };
    const provider = new HocuspocusProvider({
      url: `${location.origin.replace(/^http/, "ws")}/d/live/${encodeURIComponent(boot.documentId)}`,
      name: boot.documentId,
      document: ydoc,
      token: async () => {
        let ticket: string | undefined;
        // A member here through a share link: the link's access travels in a ticket (never in the URL).
        if (boot.shareToken && boot.viewer.kind === "member") {
          ticket = await api.liveTicket().then(
            (t) => t.ticket,
            () => undefined,
          );
        }
        const epoch = ydoc.getMap(META).get("epoch");
        return JSON.stringify({ ...(typeof epoch === "string" ? { epoch } : {}), ...(ticket ? { ticket } : {}) });
      },
      onSynced: ({ state }) => {
        if (!state) return;
        try {
          sessionStorage.removeItem(RELOADED);
        } catch {
          /* ignore */
        }
        if (!settled) {
          settled = true;
          resolve({
            ydoc,
            provider,
            anchors: (editor) => liveAnchors(ydoc, editor),
            onResync: (cb) => {
              resync = cb;
            },
            refusedNotice,
          });
        } else resync?.();
      },
      onAuthenticationFailed: ({ reason }) => {
        if (reason === "live_state_stale" && settled) return reloadOnce(boot.documentId);
        if (reason === "live_state_stale") {
          // Not yet drawn: start from the server's state in a fresh document.
          reloadOnce(boot.documentId);
        }
        giveUp();
      },
      onStateless: ({ payload }) => {
        let msg: { type?: unknown } = {};
        try {
          msg = JSON.parse(payload) as typeof msg;
        } catch {
          return;
        }
        if (msg.type !== "edit_refused") return;
        try {
          sessionStorage.setItem(REFUSED, boot.documentId);
        } catch {
          /* ignore */
        }
        reloadOnce(boot.documentId);
      },
      onClose: () => {
        // Closed before the first sync (no WebSocket through a proxy, or refused): save the usual way.
        if (!settled) giveUp();
      },
    });
    provider.setAwarenessField("user", { name: who, color: caretColor(who) });
    setTimeout(giveUp, JOIN_TIMEOUT_MS);
  });
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
