/**
 * Joining a live document (/d/live/<id>), for every kind: Markdown documents (coedit.ts) and designs
 * (live-board/session.ts) share this one path.
 *
 * The page joins before it draws and falls back to saving versions the usual way when it cannot (no session, a
 * proxy without WebSockets, a document that cannot go live): joinLiveDocument resolves null then. The server's
 * refusals arrive as codes: live_state_stale (this page holds a history the server no longer has) and edit_refused
 * (an edit broke a rule: a secret value, the board format, a size limit) both reload the page from the server's
 * copy, once, with a notice saying why.
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { Api, Bootstrap } from "./api.js";

const META = "wardby-meta";
const JOIN_TIMEOUT_MS = 4000;
/** Set before a reload the server asked for, so a second refusal is shown instead of reloading again. */
const RELOADED = "wardby-live-reloaded";
const REFUSED = "wardby-live-refused";

/** What the page says after the server refused an edit and it reloaded, by the server's reason. */
const REFUSED_TEXT: Record<string, string> = {
  secret_value: "Your last edit contained a secret value, so it was not kept.",
  board_format:
    "Your last edit broke the board format (for example a script or an external image), so it was not kept.",
  board_too_large: "Your last edit made the board larger than 512 KB, so it was not kept.",
  server_data: "Your last edit changed data only the server may change, so it was not kept.",
};

export interface LiveJoin {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  /** Called after each later sync (a reconnect). */
  onResync(cb: () => void): void;
  /** Set when the server refused an edit and the page reloaded: the message to show once. */
  refusedNotice: string | null;
}

const COLORS = ["#d9480f", "#1971c2", "#2f9e44", "#9c36b5", "#e8590c", "#0c8599", "#c2255c", "#5c940d"];

/** A stable colour per name, so a person's caret and outline keep their colour across reloads. */
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

/**
 * Joins the live document, or resolves null when the page should save the usual way. `onMessage` receives the
 * server's other messages (a design's board roles).
 */
export function joinLiveDocument(
  boot: Bootstrap,
  api: Api,
  who: string,
  opts: { onMessage?: (msg: Record<string, unknown>) => void } = {},
): Promise<LiveJoin | null> {
  const ydoc = new Y.Doc();
  let settled = false;
  let resync: (() => void) | null = null;
  let refusedNotice: string | null = null;
  try {
    const reason = sessionStorage.getItem(REFUSED);
    if (reason) {
      const [doc, why] = reason.split("|");
      if (doc === boot.documentId) refusedNotice = REFUSED_TEXT[why ?? ""] ?? REFUSED_TEXT.secret_value;
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
            onResync: (cb) => {
              resync = cb;
            },
            refusedNotice,
          });
        } else resync?.();
      },
      onAuthenticationFailed: ({ reason }) => {
        if (reason === "live_state_stale") reloadOnce(boot.documentId);
        giveUp();
      },
      onStateless: ({ payload }) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type !== "edit_refused") return opts.onMessage?.(msg);
        try {
          sessionStorage.setItem(REFUSED, `${boot.documentId}|${typeof msg.reason === "string" ? msg.reason : ""}`);
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
