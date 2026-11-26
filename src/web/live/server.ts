/**
 * Live co-editing of Markdown documents: Hocuspocus (Yjs over a WebSocket) on the control plane's own port,
 * at /d/live/<documentId>.
 *
 * - Sign-in: the web session cookie the browser sends on the upgrade (member or guest), then the document's
 *   access: write edits, comment/view joins read-only. A member whose only access is a share link presents a
 *   single-use ticket (POST /d/api/<id>/live-ticket) in the first message, never in a URL.
 * - Review lock: approved, rejected or archived documents are read-only for everyone, switched live on review
 *   events.
 * - History: the live state is loaded from Postgres, or created once from the latest version under the
 *   document's lease, and saved after each pause. Its epoch is checked on every connection: a browser holding
 *   another history is refused (live_state_stale) so it can never merge stale state back in.
 * - Secret values of the document's agent: an incoming edit that would put one into the text is refused before
 *   it is applied or broadcast, and that browser is told why (edit_refused) and reloads from the server.
 * - Nothing here logs document text, tokens or tickets.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Hocuspocus } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { requireDocumentAccess } from "../../core/documents/access.js";
import type { DocumentEventBus } from "../../core/documents/events.js";
import { seedLiveDoc } from "../../core/documents/live/markdown.js";
import {
  acquireLease,
  createLiveState,
  loadLiveState,
  redeemLiveTicket,
  releaseLease,
  saveLiveState,
} from "../../core/documents/live/store.js";
import { showsSecret } from "../../core/documents/live/text.js";
import { documentSecretValues } from "../../core/documents/redact.js";
import { isLocked } from "../../core/documents/review-state.js";
import { logger } from "../../core/logger.js";
import { resolveContext, type WebDeps } from "../context.js";

const log = logger.child({ module: "live" });

export const LIVE_PATH = /^\/d\/live\/([A-Za-z0-9_-]{1,64})$/;
/** Where the epoch of a live document's history is kept, inside the shared state (browsers send it back). */
export const LIVE_META = "wardby-meta";
const MAX_TOKEN = 4096;

/** A refusal the browser sees: Hocuspocus sends `reason` to it (the page acts on live_state_stale). */
function refusal(
  code: "document_not_found" | "invalid_request" | "live_state_stale" | "live_unavailable" | "edit_refused",
) {
  return Object.assign(new Error(code), { reason: code });
}

export interface LiveTimings {
  /** Save after this long without edits (ms). */
  storeDebounceMs: number;
  /** ...and at least this often while edits keep coming (ms). */
  storeMaxDebounceMs: number;
  /** Lease length and renewal (seconds / ms). */
  leaseSeconds: number;
  leaseRenewMs: number;
  /** How long a document's secret values are reused before they are read again (ms). */
  secretsTtlMs: number;
}

export const LIVE_TIMINGS: LiveTimings = {
  storeDebounceMs: 3000,
  storeMaxDebounceMs: 15_000,
  leaseSeconds: 30,
  leaseRenewMs: 10_000,
  secretsTtlMs: 30_000,
};

export interface LiveServerDeps extends WebDeps {
  bus: DocumentEventBus;
  /** This replica's advertise address (host:port): the lease names it. */
  replica: string;
  timings?: Partial<LiveTimings>;
}

export interface LiveServer {
  /** Takes the upgrade when its path is /d/live/<id> and returns true; false for any other path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): Promise<void>;
}

interface LiveContext {
  documentId: string;
  /** Set for members; guests edit nothing and save nothing. */
  principalId?: string;
  /** Read-only by access (a ticket may lift it); the review lock applies on top. */
  readOnly: boolean;
  /** A member with no access of their own: only a share-link ticket lets them in. */
  needsTicket: boolean;
}

interface Loaded {
  epoch: string;
}

export function createLiveServer(deps: LiveServerDeps): LiveServer {
  const t: LiveTimings = { ...LIVE_TIMINGS, ...deps.timings };
  const db = deps.db;
  const loaded = new Map<string, Loaded>();
  const secrets = new Map<string, { values: string[]; at: number }>();

  const secretValues = async (documentId: string): Promise<string[]> => {
    const hit = secrets.get(documentId);
    if (hit && Date.now() - hit.at < t.secretsTtlMs) return hit.values;
    const doc = await db.document.findUnique({ where: { id: documentId }, select: { agentId: true } });
    const values = await documentSecretValues(db, deps.cipher, doc?.agentId ?? null);
    secrets.set(documentId, { values, at: Date.now() });
    return values;
  };

  const locked = async (documentId: string): Promise<boolean> => {
    const d = await db.document.findUnique({ where: { id: documentId }, select: { reviewState: true } });
    return !d || isLocked(d.reviewState);
  };

  /** Read-only for each connection: by its access, or for everyone while the document is locked. */
  const applyLock = async (documentId: string): Promise<void> => {
    const doc = hocuspocus.documents.get(documentId);
    if (!doc) return;
    const isLockedNow = await locked(documentId);
    for (const c of doc.getConnections()) c.readOnly = isLockedNow || (c.context as LiveContext).readOnly;
  };

  const hocuspocus = new Hocuspocus<LiveContext>({
    debounce: t.storeDebounceMs,
    maxDebounce: t.storeMaxDebounceMs,
    quiet: true,

    async onAuthenticate({ context, documentName, token, connectionConfig }) {
      if (documentName !== context.documentId) throw refusal("document_not_found");
      let sent: { epoch?: unknown; ticket?: unknown } = {};
      if (token) {
        if (token.length > MAX_TOKEN) throw refusal("invalid_request");
        try {
          sent = JSON.parse(token) as typeof sent;
        } catch {
          throw refusal("invalid_request");
        }
      }
      if (typeof sent.ticket === "string") {
        const ticket = context.principalId
          ? await redeemLiveTicket(db, {
              token: sent.ticket,
              documentId: documentName,
              principalId: context.principalId,
            })
          : null;
        if (!ticket) throw refusal("document_not_found");
        context.readOnly = context.readOnly && ticket.readOnly;
        context.needsTicket = false;
      }
      if (context.needsTicket) throw refusal("document_not_found");
      if (typeof sent.epoch === "string") {
        const epoch = loaded.get(documentName)?.epoch ?? (await loadLiveState(db, documentName))?.epoch;
        if (sent.epoch !== epoch) throw refusal("live_state_stale");
      }
      connectionConfig.readOnly = context.readOnly || (await locked(documentName));
    },

    async onLoadDocument({ document, documentName }) {
      let stored = await loadLiveState(db, documentName);
      if (!stored) {
        const owner = await acquireLease(db, documentName, deps.replica, t.leaseSeconds);
        if (owner !== deps.replica) throw refusal("live_unavailable");
        const current = await db.document.findUnique({
          where: { id: documentName },
          select: { currentVersion: { select: { number: true, markdown: true, format: true } } },
        });
        const v = current?.currentVersion;
        if (!v || v.format !== "markdown" || v.markdown === null) throw refusal("live_unavailable");
        const seed = seedLiveDoc(v.markdown);
        seed.getMap(LIVE_META).set("epoch", randomUUID());
        stored = await createLiveState(db, {
          documentId: documentName,
          epoch: seed.getMap(LIVE_META).get("epoch") as string,
          state: Y.encodeStateAsUpdate(seed),
          versionNumber: v.number,
        });
      }
      Y.applyUpdate(document, stored.state);
      loaded.set(documentName, { epoch: stored.epoch });
    },

    async beforeSync({ document, documentName, type, payload, connection }) {
      // Sync step 2 and updates carry content (1, 2); a read-only connection's are ignored anyway.
      if ((type !== 1 && type !== 2) || connection.readOnly) return;
      const values = await secretValues(documentName);
      if (values.length === 0) return;
      const scratch = new Y.Doc();
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(document));
      Y.applyUpdate(scratch, payload);
      if (showsSecret(scratch, values)) {
        log.warn({ documentId: documentName }, "live edit refused: it would show a secret value");
        connection.sendStateless(JSON.stringify({ type: "edit_refused", reason: "secret_value" }));
        throw refusal("edit_refused");
      }
    },

    async onStoreDocument({ document, documentName }) {
      const l = loaded.get(documentName);
      if (!l) return;
      const saved = await saveLiveState(db, {
        documentId: documentName,
        epoch: l.epoch,
        state: Y.encodeStateAsUpdate(document),
      });
      // The history was reset meanwhile: these connections hold a history that no longer exists.
      if (!saved) hocuspocus.closeConnections(documentName);
    },

    async afterUnloadDocument({ documentName }) {
      loaded.delete(documentName);
      secrets.delete(documentName);
      await releaseLease(db, documentName, deps.replica).catch(() => undefined);
    },
  });

  const renew = setInterval(() => {
    for (const id of hocuspocus.documents.keys()) {
      void acquireLease(db, id, deps.replica, t.leaseSeconds).catch((err: unknown) =>
        log.warn({ documentId: id, errorName: err instanceof Error ? err.name : typeof err }, "lease renewal failed"),
      );
    }
  }, t.leaseRenewMs);
  renew.unref();

  const unsubscribe = deps.bus.subscribe((event) => {
    if (event.kind === "review" && hocuspocus.documents.has(event.documentId)) {
      void applyLock(event.documentId).catch((err: unknown) =>
        log.warn({ errorName: err instanceof Error ? err.name : typeof err }, "live lock not applied"),
      );
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  const refuse = (socket: Duplex, status: number) => {
    socket.end(
      `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  };

  return {
    handleUpgrade(req, socket, head) {
      const m = LIVE_PATH.exec(new URL(req.url ?? "/", "http://x").pathname);
      if (!m) return false;
      const documentId = m[1];
      void (async () => {
        const ctx = await resolveContext(req, deps);
        if (ctx.kind === "none") return refuse(socket, 401);
        if (ctx.kind === "guest" && ctx.documentId !== documentId) return refuse(socket, 404);
        let readOnly = true;
        let any = true;
        try {
          await requireDocumentAccess(db, documentId, ctx.viewer, "write");
          readOnly = false;
        } catch {
          try {
            await requireDocumentAccess(db, documentId, ctx.viewer, "read");
          } catch {
            any = false;
          }
        }
        // A member without access of their own may still connect to present a share-link ticket.
        if (!any && ctx.kind !== "member") return refuse(socket, 404);
        wss.handleUpgrade(req, socket, head, (ws) => {
          const context: LiveContext = {
            documentId,
            ...(ctx.kind === "member" ? { principalId: ctx.principalId } : {}),
            readOnly,
            needsTicket: !any,
          };
          const conn = hocuspocus.handleConnection(ws, new Request("http://localhost/"), context);
          ws.on("message", (data: Buffer) => conn.handleMessage(new Uint8Array(data)));
          ws.on("close", (code, reason) => conn.handleClose({ code, reason: reason.toString() }));
          ws.on("pong", () => conn.touch());
        });
      })().catch((err: unknown) => {
        log.warn({ errorName: err instanceof Error ? err.name : typeof err }, "live upgrade failed");
        refuse(socket, 404);
      });
      return true;
    },
    async close() {
      clearInterval(renew);
      unsubscribe();
      hocuspocus.flushPendingStores();
      hocuspocus.closeConnections();
      wss.close();
    },
  };
}
