/**
 * The document JSON API under /d/api/. Every handler takes an already
 * resolved viewer; the router has checked Origin and CSRF for writes.
 *
 * Output: document titles, Markdown and comment bodies are returned as raw
 * strings (the page renders them with textContent). They were redacted
 * against the document agent's secret values when stored (service.ts,
 * comments.ts), so no new secret path opens here. Names only: no email of
 * any viewer, member or guest is ever part of a response.
 */
import type { ServerResponse } from "node:http";
import { atLeast } from "../core/grants.js";
import { documentAccess, requireDocumentAccess, type Viewer } from "../core/documents/access.js";
import {
  createThread,
  deleteComment,
  editComment,
  guestMentionCandidates,
  listThreads,
  mentionCandidates,
  mentionedGuestNames,
  principalNames,
  reply,
  setThreadStatus,
} from "../core/documents/comments.js";
import { MAX_THREADS_PER_SEND } from "../core/documents/agent-loop.js";
import { getDocument, publishVersion } from "../core/documents/service.js";
import { getVersion, listVersions, MAX_VERSIONS_PAGE, restoreVersion } from "../core/documents/versions.js";
import { sendWebJson, WebError, type WebDeps } from "./context.js";
import type { PageViewer } from "./page.js";
import { GUEST_RATE_LIMITS, WEB_RATE_BUCKETS, webRateLimiter } from "./rate-limits.js";

const invalid = (): never => {
  throw new WebError("invalid_request");
};

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v : invalid();
}

/** Counts a guest's comment (thread or reply) against the hourly limit; members are not counted. */
async function countGuestComment(deps: WebDeps, viewer: Viewer): Promise<void> {
  if (viewer.kind !== "guest") return;
  const limit = deps.guestLimits?.commentsPerGuest ?? GUEST_RATE_LIMITS.commentsPerGuest;
  await (deps.rateLimiter ?? webRateLimiter(deps.db)).check(WEB_RATE_BUCKETS.commentsPerGuest, viewer.guestId, limit);
}

/** The name and access a viewer is shown as (to themselves). */
export async function describeViewer(
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  anonymous = false,
): Promise<PageViewer> {
  const access = await documentAccess(deps.db, documentId, viewer);
  if (viewer.kind === "principal") {
    const names = await principalNames(deps.db, [viewer.principalId]);
    return { kind: "member", name: names.get(viewer.principalId) ?? null, access };
  }
  if (anonymous) return { kind: "anonymous", name: null, access };
  const guest = await deps.db.documentGuest.findUnique({ where: { id: viewer.guestId }, select: { name: true } });
  return { kind: "guest", name: guest?.name ?? null, access };
}

export async function getDocumentJson(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  anonymous: boolean,
): Promise<void> {
  await requireDocumentAccess(deps.db, documentId, viewer, "read");
  const { document, version } = await getDocument(deps.db, documentId);
  const me = await describeViewer(deps, documentId, viewer, anonymous);
  const threads = await listThreads(deps.db, { documentId, viewer, filter: "all" });
  // Names for @[guest:id] mentions, only for this document's own guests.
  const mentionedGuests = await mentionedGuestNames(
    deps.db,
    documentId,
    threads.flatMap((t) => t.comments.map((c) => c.body)),
  );
  const member = viewer.kind === "principal";
  sendWebJson(res, 200, {
    document: {
      id: document.id,
      title: document.title,
      updatedAt: document.updatedAt,
      // Where a linked document lives is for members only.
      ...(member ? { repository: document.repository, path: document.path } : {}),
      canSend: atLeast("document", me.access, "write") && !!document.repository && !!document.path,
    },
    version: { number: version.number, markdown: version.markdown, createdAt: version.createdAt },
    me,
    threads,
    mentionedGuests,
  });
}

export async function putContent(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<void> {
  const markdown = str(body, "markdown");
  const baseNumber = body.baseNumber;
  if (typeof baseNumber !== "number" || !Number.isInteger(baseNumber) || baseNumber < 1) invalid();
  await requireDocumentAccess(deps.db, documentId, viewer, "write");
  if (viewer.kind !== "principal") throw new Error("document_access_denied");
  const v = await publishVersion(deps.db, deps.cipher, {
    documentId,
    markdown,
    via: "editor",
    createdById: viewer.principalId,
    expectedNumber: baseNumber as number,
  });
  sendWebJson(res, 200, { version: { number: v.number }, reanchored: v.reanchored });
}

export async function postThread(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<void> {
  const text = str(body, "body");
  if (body.sendToAgent !== undefined && typeof body.sendToAgent !== "boolean") invalid();
  const send = body.sendToAgent === true;
  // Sending needs write, exactly as POST /send does. Checked before anything is stored: a request that
  // cannot be carried out in full is refused in full (no thread is created).
  if (send) {
    await requireDocumentAccess(deps.db, documentId, viewer, "write");
    if (!deps.sendThreads) throw new Error("document_send_not_available");
  }
  await countGuestComment(deps, viewer);
  const t = await createThread(deps.db, deps.cipher, { documentId, viewer, anchor: body.anchor, body: text });
  let sent: unknown;
  if (send && deps.sendThreads) {
    sent = await deps.sendThreads({ documentId, threadIds: [t.threadId], viewer });
  }
  sendWebJson(res, 201, {
    threadId: t.threadId,
    number: t.number,
    mentionsWithoutAccess: t.mentionsWithoutAccess,
    ...(sent !== undefined ? { sent } : {}),
  });
}

export async function postReply(
  res: ServerResponse,
  deps: WebDeps,
  threadId: string,
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<void> {
  const text = str(body, "body");
  await countGuestComment(deps, viewer);
  const r = await reply(deps.db, deps.cipher, { threadId, viewer, body: text });
  sendWebJson(res, 201, { commentId: r.commentId, mentionsWithoutAccess: r.mentionsWithoutAccess });
}

export async function postStatus(
  res: ServerResponse,
  deps: WebDeps,
  threadId: string,
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<void> {
  const status = body.status;
  if (status !== "open" && status !== "resolved") invalid();
  await setThreadStatus(deps.db, { threadId, viewer, status: status as "open" | "resolved" });
  sendWebJson(res, 200, { ok: true });
}

export async function patchComment(
  res: ServerResponse,
  deps: WebDeps,
  commentId: string,
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<void> {
  await editComment(deps.db, deps.cipher, { commentId, viewer, body: str(body, "body") });
  sendWebJson(res, 200, { ok: true });
}

export async function removeComment(
  res: ServerResponse,
  deps: WebDeps,
  commentId: string,
  viewer: Viewer,
): Promise<void> {
  await deleteComment(deps.db, { commentId, viewer });
  sendWebJson(res, 200, { ok: true });
}

export async function getMentions(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
): Promise<void> {
  // mentionCandidates has no access check of its own: only commenters may list members.
  await requireDocumentAccess(deps.db, documentId, viewer, "comment");
  // A share-link guest never sees the member directory, and gets no list at all (R19). Members may
  // mention members and the guests who commented on this document (R22).
  if (viewer.kind === "guest") return sendWebJson(res, 200, { candidates: [] });
  const [members, guests] = await Promise.all([
    mentionCandidates(deps.db, documentId),
    guestMentionCandidates(deps.db, documentId),
  ]);
  sendWebJson(res, 200, {
    candidates: [
      ...members.map((c) => ({ principalId: c.principalId, name: c.name })),
      ...guests.map((g) => ({ guestId: g.guestId, name: g.name })),
    ],
  });
}

export async function postSend(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<void> {
  const ids = body.threadIds;
  if (!Array.isArray(ids) || ids.length > MAX_THREADS_PER_SEND || !ids.every((id) => typeof id === "string")) {
    invalid();
  }
  await requireDocumentAccess(deps.db, documentId, viewer, "write");
  if (!deps.sendThreads) throw new Error("document_send_not_available");
  const result = await deps.sendThreads({ documentId, threadIds: ids as string[], viewer });
  sendWebJson(res, 200, result ?? { ok: true });
}

/** A positive integer query parameter, or undefined when absent; anything else is invalid_request. */
function intParam(params: URLSearchParams, key: string, max: number): number | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) invalid();
  return Math.min(Number(raw), max);
}

/** The version history, newest first. Items carry no content (no Markdown). */
export async function listVersionsJson(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  params: URLSearchParams,
): Promise<void> {
  const before = intParam(params, "before", Number.MAX_SAFE_INTEGER);
  const limit = intParam(params, "limit", MAX_VERSIONS_PAGE);
  const list = await listVersions(deps.db, {
    documentId,
    viewer,
    ...(before !== undefined ? { before } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  sendWebJson(res, 200, list);
}

/** One version's Markdown (redacted when it was published). */
export async function getVersionJson(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  number: number,
): Promise<void> {
  const v = await getVersion(deps.db, { documentId, viewer, number });
  sendWebJson(res, 200, { version: v });
}

/** Publishes version <n>'s Markdown as a new version; baseNumber must still be the latest. */
export async function restoreVersionJson(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  number: number,
  body: Record<string, unknown>,
): Promise<void> {
  const baseNumber = body.baseNumber;
  if (typeof baseNumber !== "number" || !Number.isInteger(baseNumber) || baseNumber < 1) invalid();
  const out = await restoreVersion(deps.db, deps.cipher, {
    documentId,
    viewer,
    number,
    baseNumber: baseNumber as number,
    via: "editor",
  });
  sendWebJson(res, 200, { version: { number: out.number }, reanchored: out.reanchored });
}
