/**
 * POST /d/api/<id>/live-ticket: a single-use, 60-second ticket that carries the access this request has, share
 * link included (x-wardby-share), for joining the live document. A browser cannot send that header on a
 * WebSocket, so the page sends the ticket in the first message instead (never in a URL).
 */
import type { ServerResponse } from "node:http";
import { requireDocumentAccess, type Viewer } from "../../core/documents/access.js";
import { issueLiveTicket } from "../../core/documents/live/store.js";
import { sendWebJson, type WebDeps } from "../context.js";

export async function postLiveTicket(res: ServerResponse, deps: WebDeps, documentId: string, viewer: Viewer) {
  // Guests join with their own session; only a member's access can come from a link per request.
  if (viewer.kind !== "principal") throw new Error("document_access_denied");
  let readOnly = true;
  try {
    await requireDocumentAccess(deps.db, documentId, viewer, "write");
    readOnly = false;
  } catch {
    await requireDocumentAccess(deps.db, documentId, viewer, "read");
  }
  const ticket = await issueLiveTicket(deps.db, { documentId, principalId: viewer.principalId, readOnly });
  sendWebJson(res, 200, { ticket, readOnly });
}
