/**
 * GET /d/api/<documentId>/events: live changes to one document as
 * Server-Sent Events, for the document page.
 *
 * - Auth: the page API's web session (member or guest cookie; a member's
 *   share token in `x-wardby-share` raises access as on every API call). A
 *   visitor without a session gets 401 `web_session_required`; read access
 *   is required at open (404/403 otherwise). GET only, so no CSRF; the
 *   transport's host and Origin rules apply as to every request.
 * - Frames: `retry: 3000`, `hello`, then `thread` | `comment` | `version` |
 *   `share` | `review` events whose data is `{documentId, kind}` only — never titles,
 *   Markdown, comment bodies or names (the client refetches through the
 *   access-checked API). `status` and `resync` follow the documents bus's
 *   LISTEN connection, as on the Viewer stream.
 * - A plan document's stream also carries the `review` and `version` events of
 *   the other documents in its plan set (for the plan bar), each only after
 *   checking that the document is still in the set and that this viewer can
 *   read it — a share-link guest hears only about documents they can open.
 * - Every heartbeat re-validates the session without refreshing it (expired,
 *   idle, revoked share link, disabled user) and the viewer's read access;
 *   any failure ends the stream. The heartbeat is not activity, but the
 *   page's refetches after an event (`GET /d/api/<id>`) are ordinary
 *   requests that touch the session, so an active document keeps it alive.
 * - At most MAX_STREAMS_PER_SESSION open streams per web session (the next
 *   one answers 429 `web_rate_limited`); all end on server shutdown.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { documentAccess, requireDocumentAccess, type Viewer } from "../core/documents/access.js";
import type { DocumentEvent, DocumentEventBus } from "../core/documents/events.js";
import { openSseStream } from "../mcp/transport/sse-stream.js";
import { SSE_MAX_BUFFERED_BYTES } from "../viewer/http.js";
import { SSE_HEARTBEAT_MS } from "../viewer/limits.js";
import { requestViewer, resolveContext, type WebDeps } from "./context.js";

/** Open document streams one web session may hold (tabs on documents); documented in docs/documents.md. */
export const MAX_STREAMS_PER_SESSION = 5;

export interface DocumentStreams {
  readonly bus: DocumentEventBus;
  readonly heartbeatMs: number;
  readonly maxBufferedBytes: number;
  readonly maxPerSession: number;
  /** Open streams per web session id. */
  readonly perSession: Map<string, number>;
  readonly closers: Set<() => void>;
  /** Ends every open stream (server shutdown). */
  closeStreams(): void;
}

export function createDocumentStreams(options: {
  bus: DocumentEventBus;
  heartbeatMs?: number; // tests
  maxBufferedBytes?: number; // tests
  maxPerSession?: number; // tests
}): DocumentStreams {
  const closers = new Set<() => void>();
  return {
    bus: options.bus,
    heartbeatMs: options.heartbeatMs ?? SSE_HEARTBEAT_MS,
    maxBufferedBytes: options.maxBufferedBytes ?? SSE_MAX_BUFFERED_BYTES,
    maxPerSession: options.maxPerSession ?? MAX_STREAMS_PER_SESSION,
    perSession: new Map(),
    closers,
    closeStreams() {
      for (const close of [...closers]) close();
    },
  };
}

/** Events of the other documents of a plan set that the page's plan bar follows. */
const SET_EVENT_KINDS = new Set<DocumentEvent["kind"]>(["review", "version"]);

/** Whether another document is in the stream's plan set and the viewer can read it (checked per event, never cached). */
async function inSetAndReadable(deps: WebDeps, planSetId: string, documentId: string, viewer: Viewer) {
  try {
    const doc = await deps.db.document.findUnique({ where: { id: documentId }, select: { planSetId: true } });
    if (doc?.planSetId !== planSetId) return false;
    return (await documentAccess(deps.db, documentId, viewer)) !== "none";
  } catch {
    return false;
  }
}

export async function openDocumentStream(
  req: IncomingMessage,
  res: ServerResponse,
  documentId: string,
  deps: WebDeps,
): Promise<void> {
  const streams = deps.events;
  if (!streams) throw new Error("not_found");
  const ctx = await resolveContext(req, deps);
  if (ctx.kind === "none") throw new Error("web_session_required");
  const viewer = await requestViewer(req, deps, ctx);
  await requireDocumentAccess(deps.db, documentId, viewer, "read");
  const planSetId =
    (await deps.db.document.findUnique({ where: { id: documentId }, select: { planSetId: true } }))?.planSetId ?? null;
  const sessionId = ctx.session.id;
  const open = streams.perSession.get(sessionId) ?? 0;
  if (open >= streams.maxPerSession) throw new Error("web_rate_limited");

  const stream = openSseStream(req, res, {
    heartbeatMs: streams.heartbeatMs,
    maxBufferedBytes: streams.maxBufferedBytes,
    beforeHeartbeat: async () => {
      const now = await resolveContext(req, deps, { touch: false });
      if (now.kind === "none" || now.session.id !== sessionId) return false;
      return (await documentAccess(deps.db, documentId, await requestViewer(req, deps, now))) !== "none";
    },
  });
  if (!stream) return;
  streams.perSession.set(sessionId, open + 1);
  stream.onEnd(() => {
    const left = (streams.perSession.get(sessionId) ?? 1) - 1;
    if (left > 0) streams.perSession.set(sessionId, left);
    else streams.perSession.delete(sessionId);
  });

  stream.send(`event: hello\ndata: ${JSON.stringify({ connected: streams.bus.connected() })}\n\n`);
  // Ids and a kind only: the bus schema allows nothing else.
  const forward = (event: DocumentEvent) =>
    stream.send(
      `event: ${event.kind}\ndata: ${JSON.stringify({ documentId: event.documentId, kind: event.kind })}\n\n`,
    );
  // Events pass through one queue, so a plan-set event checked against the database keeps its place.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => void | Promise<void>) => {
    queue = queue.then(task).catch(() => undefined);
  };
  stream.onEnd(
    streams.bus.subscribe((event) => {
      if (event.documentId === documentId) return enqueue(() => forward(event));
      if (!planSetId || !SET_EVENT_KINDS.has(event.kind)) return;
      enqueue(async () => {
        if (await inSetAndReadable(deps, planSetId, event.documentId, viewer)) forward(event);
      });
    }),
  );
  stream.onEnd(
    streams.bus.onState((live) => {
      stream.send(`event: status\ndata: ${JSON.stringify({ connected: live })}\n\n`);
      if (live) stream.send("event: resync\ndata: {}\n\n");
    }),
  );
  const close = () => stream.close();
  streams.closers.add(close);
  stream.onEnd(() => streams.closers.delete(close));
}
