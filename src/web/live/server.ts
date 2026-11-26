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
import { readLiveAnchors } from "../../core/documents/live/anchors.js";
import { liveDocToMarkdown, normalMarkdown, seedLiveDoc } from "../../core/documents/live/markdown.js";
import { MERGE_ORIGIN, mergePublish } from "../../core/documents/live/merge.js";
import {
  acquireLease,
  createLiveState,
  getVersionState,
  loadLiveState,
  putVersionState,
  redeemLiveTicket,
  releaseLease,
  resetLiveState,
  saveLiveState,
} from "../../core/documents/live/store.js";
import { notifyDocumentChange } from "../../core/documents/events.js";
import { publishVersion } from "../../core/documents/service.js";
import { showsSecret } from "../../core/documents/live/text.js";
import { documentSecretValues } from "../../core/documents/redact.js";
import { isLocked } from "../../core/documents/review-state.js";
import { logger } from "../../core/logger.js";
import { isLosslessRoundTrip } from "../app/roundtrip.js";
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
  /** The newest version merged into (or saved from) the live document, and its Markdown. */
  versionNumber: number;
  versionMarkdown: string;
  /** Who changed the text since the last checkpoint: the next checkpoint's author. */
  lastEditor: string | null;
  /** Merges and checkpoints for this document run one at a time, in order. */
  queue: Promise<void>;
  /** The live state was dropped (a version the editor cannot keep, or a base no longer held). */
  reset: boolean;
}

const asError = (err: unknown) => (err instanceof Error ? err.name : typeof err);

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
      // A reset document is still unloading: wait for it, so this connection starts from the new history.
      for (let i = 0; i < 60 && loaded.get(documentName)?.reset; i++) await new Promise((r) => setTimeout(r, 50));
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
        // Formatting the editor cannot keep (images, checklists, HTML) would be dropped from the live document and
        // then saved: such documents stay out of live editing (the page opens them comment-only, as before).
        if (!isLosslessRoundTrip(v.markdown, liveDocToMarkdown(seed))) throw refusal("live_unavailable");
        seed.getMap(LIVE_META).set("epoch", randomUUID());
        stored = await createLiveState(db, {
          documentId: documentName,
          epoch: seed.getMap(LIVE_META).get("epoch") as string,
          state: Y.encodeStateAsUpdate(seed),
          versionNumber: v.number,
        });
      }
      Y.applyUpdate(document, stored.state);
      const since = await db.documentVersion.findUnique({
        where: { documentId_number: { documentId: documentName, number: stored.versionNumber } },
        select: { markdown: true },
      });
      const l: Loaded = {
        epoch: stored.epoch,
        versionNumber: stored.versionNumber,
        versionMarkdown: since?.markdown ?? "",
        lastEditor: null,
        queue: Promise.resolve(),
        reset: false,
      };
      loaded.set(documentName, l);
      // Versions published while no one had it open are merged in before anyone sees it.
      await catchUp(documentName, document, l);
      if (l.reset) throw refusal("live_unavailable");
    },

    async onChange({ documentName, context, transactionOrigin }) {
      const l = loaded.get(documentName);
      if (l && context?.principalId && transactionOrigin !== MERGE_ORIGIN) l.lastEditor = context.principalId;
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
      if (!l || l.reset) return;
      await enqueue(documentName, l, async () => {
        if (l.reset) return;
        const saved = await saveLiveState(db, {
          documentId: documentName,
          epoch: l.epoch,
          state: Y.encodeStateAsUpdate(document),
          versionNumber: l.versionNumber,
        });
        // The history was reset meanwhile: these connections hold a history that no longer exists.
        if (!saved) return hocuspocus.closeConnections(documentName);
        await checkpoint(documentName, document, l);
      });
    },

    async afterUnloadDocument({ documentName }) {
      loaded.delete(documentName);
      secrets.delete(documentName);
      await releaseLease(db, documentName, deps.replica).catch(() => undefined);
    },
  });

  /** Runs one step after the document's earlier ones; a failure is logged and does not stop the next. */
  const enqueue = (documentId: string, l: Loaded, step: () => Promise<void>): Promise<void> => {
    const run = l.queue.then(step).catch((err: unknown) => {
      log.warn({ documentId, errorName: asError(err) }, "live step failed");
    });
    l.queue = run;
    return run;
  };

  /**
   * Drops the live state: pages are disconnected, refused as stale when they come back, and reload into the new
   * history (or into the usual saving, for a document the editor cannot keep).
   */
  const reset = async (documentId: string, l: Loaded, why: string): Promise<void> => {
    l.reset = true;
    await resetLiveState(db, documentId);
    log.info({ documentId, why }, "live document reset");
    hocuspocus.closeConnections(documentId);
  };

  /** Each thread's stored quote follows its positions; a thread whose words are gone becomes outdated. */
  const refreshQuotes = async (documentId: string, doc: Y.Doc): Promise<void> => {
    const readings = readLiveAnchors(doc);
    if (readings.size === 0) return;
    const threads = await db.commentThread.findMany({
      where: { documentId, id: { in: [...readings.keys()] }, status: { in: ["open", "outdated"] } },
      select: { id: true, status: true, anchor: true },
    });
    let changed = 0;
    for (const th of threads) {
      const r = readings.get(th.id);
      if (!r || r === "keep") continue;
      if (r === "gone") {
        if (th.status === "open") {
          await db.commentThread.update({ where: { id: th.id }, data: { status: "outdated" } });
          changed++;
        }
        continue;
      }
      if (th.status === "open" && JSON.stringify(th.anchor) === JSON.stringify(r)) continue;
      await db.commentThread.update({ where: { id: th.id }, data: { anchor: r, status: "open" } });
      changed++;
    }
    if (changed > 0) await notifyDocumentChange(db, documentId, "thread");
  };

  /** Merges every version newer than the live document's, in order, each from the version it was based on. */
  const catchUp = async (documentId: string, doc: Y.Doc, l: Loaded): Promise<void> => {
    const versions = await db.documentVersion.findMany({
      where: { documentId, number: { gt: l.versionNumber } },
      orderBy: { number: "asc" },
      select: { number: true, markdown: true, format: true, baseNumber: true },
    });
    for (const v of versions) {
      if (v.format !== "markdown" || v.markdown === null) return reset(documentId, l, "format");
      const base = await getVersionState(db, documentId, v.baseNumber ?? v.number - 1);
      if (!base) return reset(documentId, l, "base_not_held");
      const merged = mergePublish(base, v.markdown);
      // A version the editor cannot keep would lose content in the live document: start again without it.
      const check = new Y.Doc();
      Y.applyUpdate(check, merged.versionState);
      if (!isLosslessRoundTrip(v.markdown, liveDocToMarkdown(check))) return reset(documentId, l, "lossy");
      Y.applyUpdate(doc, merged.update, MERGE_ORIGIN);
      await putVersionState(db, { documentId, versionNumber: v.number, state: merged.versionState });
      l.versionNumber = v.number;
      l.versionMarkdown = v.markdown;
    }
    if (versions.length === 0) return;
    await saveLiveState(db, {
      documentId,
      epoch: l.epoch,
      state: Y.encodeStateAsUpdate(doc),
      versionNumber: l.versionNumber,
    });
    await refreshQuotes(documentId, doc);
  };

  /** Saves the live document as a version when someone changed its text since the last one. */
  const checkpoint = async (documentId: string, doc: Y.Doc, l: Loaded, retried = false): Promise<void> => {
    const author = l.lastEditor;
    if (!author || l.reset || (await locked(documentId))) return;
    await refreshQuotes(documentId, doc);
    // State and Markdown together, before any await: the version is exactly this state.
    const state = Y.encodeStateAsUpdate(doc);
    const markdown = liveDocToMarkdown(doc);
    if (normalMarkdown(markdown) === normalMarkdown(l.versionMarkdown)) {
      l.lastEditor = null;
      return;
    }
    try {
      const out = await publishVersion(db, deps.cipher, {
        documentId,
        markdown,
        via: "editor",
        createdById: author,
        expectedNumber: l.versionNumber,
        strictBase: true,
      });
      await putVersionState(db, { documentId, versionNumber: out.number, state });
      l.versionNumber = out.number;
      l.versionMarkdown = markdown;
      if (l.lastEditor === author) l.lastEditor = null;
      await saveLiveState(db, { documentId, epoch: l.epoch, state, versionNumber: out.number });
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      if (code === "document_locked") return;
      // A version arrived meanwhile: merge it, then save this document's edits on top of it.
      if (code === "document_version_conflict" && !retried) {
        await catchUp(documentId, doc, l);
        return checkpoint(documentId, doc, l, true);
      }
      throw err;
    }
  };

  const renew = setInterval(() => {
    for (const id of hocuspocus.documents.keys()) {
      void acquireLease(db, id, deps.replica, t.leaseSeconds).catch((err: unknown) =>
        log.warn({ documentId: id, errorName: err instanceof Error ? err.name : typeof err }, "lease renewal failed"),
      );
    }
  }, t.leaseRenewMs);
  renew.unref();

  const unsubscribe = deps.bus.subscribe((event) => {
    const doc = hocuspocus.documents.get(event.documentId);
    const l = loaded.get(event.documentId);
    if (event.kind === "version" && doc && l && !l.reset) {
      void enqueue(event.documentId, l, () => catchUp(event.documentId, doc, l));
    }
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
