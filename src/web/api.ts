/**
 * The document JSON API under /d/api/. Every handler takes an already
 * resolved viewer; the router has checked Origin and CSRF for writes.
 *
 * Output: document titles, Markdown, design files and comment bodies are
 * returned as raw strings (the page renders text with textContent, boards only
 * in sandboxed srcdoc frames). They were redacted against the document agent's
 * secret values when stored (service.ts, comments.ts), and fidelity samples
 * when they are recorded (fidelity.ts), so no new secret path opens here:
 * /frames only rewrites links in stored boards (frames.ts). Names only: no email of
 * any viewer, member or guest is ever part of a response. Review names and notes are stored redacted (review.ts).
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
import { documentLinkSendable } from "../core/documents/agent-link.js";
import { BOARD_ID } from "../core/documents/boards/ids.js";
import { versionFrames } from "../core/documents/boards/frames.js";
import { MANIFEST_PATH, parseManifest } from "../core/documents/boards/format.js";
import { recordFidelity, type FidelityBoard } from "../core/documents/fidelity.js";
import { loadContent } from "../core/documents/files.js";
import { createShareLink } from "../core/documents/share-links.js";
import { getDocument, publishVersion } from "../core/documents/service.js";
import {
  chooseOption,
  forceApprove,
  MAX_CHOOSE_REJECTS,
  rejectDocument,
  getReviewView,
  reopenDocument,
  reviewCandidates,
  reviewDocument,
  setArchived,
  submitForReview,
  type ReviewView,
} from "../core/documents/review.js";
import { isLocked } from "../core/documents/review-state.js";
import type { VersionWarning } from "../core/documents/warnings.js";
import { getVersion, listVersions, MAX_VERSIONS_PAGE, restoreVersion } from "../core/documents/versions.js";
import { resolvePlanLinks } from "../core/plans/links.js";
import type { PlanLinksPayload, PlanSetPayload } from "../core/plans/page-payload.js";
import { readablePlanSet } from "../core/plans/set-view.js";
import { sendWebJson, WebError, type WebDeps } from "./context.js";

export type { PlanLinksPayload, PlanSetPayload } from "../core/plans/page-payload.js";
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
  const { document, version, content } = await getDocument(deps.db, documentId);
  const me = await describeViewer(deps, documentId, viewer, anonymous);
  const threads = await listThreads(deps.db, { documentId, viewer, filter: "all" });
  // Names for @[guest:id] mentions, only for this document's own guests.
  const mentionedGuests = await mentionedGuestNames(
    deps.db,
    documentId,
    threads.flatMap((t) => t.comments.map((c) => c.body)),
  );
  const member = viewer.kind === "principal";
  const design = document.kind === "design";
  const review = await getReviewView(deps.db, documentId, viewer);
  const planSet = document.planSetId
    ? await deps.db.planSet.findUnique({ where: { id: document.planSetId }, select: { store: true, agentId: true } })
    : null;
  const linked = documentLinkSendable(document, planSet);
  const plan = document.planSetId
    ? await planPayload(
        deps,
        document.planSetId,
        documentId,
        viewer,
        content.format === "markdown" ? content.markdown : null,
      )
    : null;
  sendWebJson(res, 200, {
    document: {
      id: document.id,
      kind: design ? "design" : "document",
      title: document.title,
      updatedAt: document.updatedAt,
      // Where a linked document lives is for members only.
      ...(member ? { repository: document.repository, path: document.path } : {}),
      canSend: atLeast("document", me.access, "write") && linked && !isLocked(review.state),
      // Whether PNG/PDF export is available (a renderer is configured).
      canRender: deps.exports?.renderer != null,
    },
    version: {
      number: version.number,
      format: content.format,
      ...(content.format === "markdown" ? { markdown: content.markdown } : { files: content.files }),
      warnings: storedWarnings(version.warnings),
      createdAt: version.createdAt,
    },
    me,
    threads,
    mentionedGuests,
    review: reviewJson(review),
    ...(plan ? plan : {}),
  });
}

/**
 * A plan document's bar and links. The bar lists the set's documents this viewer can read (a share-link
 * guest sees only theirs), and counts only those. Links resolve against every document still in the
 * set, but a link to one the viewer cannot read is left out of both lists: no id of it reaches the page,
 * and it shows as plain text without a warning.
 */
async function planPayload(
  deps: WebDeps,
  planSetId: string,
  documentId: string,
  viewer: Viewer,
  markdown: string | null,
): Promise<{ planSet: PlanSetPayload; planLinks?: PlanLinksPayload } | null> {
  const set = await readablePlanSet(deps.db, planSetId, viewer);
  if (!set) return null;
  const guest = viewer.kind === "guest";
  const counted = set.documents.filter((d) => !d.removed);
  const documents = [...set.documents]
    .sort((a, b) => Number(a.removed) - Number(b.removed))
    .map((d) => ({
      id: d.id,
      title: d.title,
      kind: d.kind,
      reviewState: d.reviewState,
      path: d.path,
      removed: d.removed,
      current: d.id === documentId,
      versionNumber: d.versionNumber,
      pagePath: guest ? "" : `/d/${d.id}`,
    }));
  const planSet: PlanSetPayload = {
    number: set.number,
    approved: counted.filter((d) => d.reviewState === "approved").length,
    counted: counted.length,
    documents,
    ...(guest ? { partial: true } : {}),
  };
  if (markdown === null) return { planSet };
  // A guest always sees a partial set; warned versus plain links would tell them which files are in it.
  if (guest) return { planSet, planLinks: { links: [], unresolved: [] } };
  const inSet = await deps.db.document.findMany({
    where: { planSetId, removedFromPlan: false, planPath: { not: null } },
    select: { id: true, kind: true, planPath: true },
  });
  const self = inSet.find((d) => d.id === documentId);
  const { links, unresolved } = resolvePlanLinks(
    markdown,
    self?.planPath ?? "plan.md",
    inSet.map((d) => ({ id: d.id, path: d.planPath ?? "", kind: d.kind === "design" ? "design" : "document" })),
  );
  const readable = new Set(set.documents.map((d) => d.id));
  return { planSet, planLinks: { links: links.filter((l) => readable.has(l.documentId)), unresolved } };
}

/** The `review` payload of the page API. */
export type WebReview = ReturnType<typeof reviewJson>;

/** The review as the page shows it: names and notes as text; refs (principal ids, guest:<id>) for the owner only. */
export function reviewJson(view: ReviewView) {
  const owner = view.can.submit || view.can.archive || view.can.unarchive;
  return {
    state: view.state,
    currentVersion: view.currentVersion,
    progress: view.progress,
    reviewers: view.reviewers.map((r) => ({
      id: r.id,
      kind: r.kind,
      ...(owner ? { ref: r.ref } : {}),
      name: r.name,
      verdict: r.verdict,
      versionNumber: r.versionNumber,
      note: r.note,
      current: r.current,
      me: r.me,
    })),
    finalApprover: view.finalApprover
      ? {
          name: view.finalApprover.name,
          me: view.finalApprover.me,
          ...(owner ? { ref: view.finalApprover.principalId } : {}),
        }
      : null,
    forced: view.forced,
    events: view.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      actorName: e.actorName,
      fromState: e.fromState,
      toState: e.toState,
      versionNumber: e.versionNumber,
      note: e.note,
      createdAt: e.createdAt.toISOString(),
    })),
    can: view.can,
  };
}

const VERDICTS = new Set(["approve", "request_changes"]);

/** POST /d/api/<id>/review: one review action, answered with the updated review. */
export async function postReview(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<void> {
  let view: ReviewView;
  switch (body.action) {
    case "submit": {
      const reviewers = body.reviewers;
      if (!Array.isArray(reviewers) || !reviewers.every((r) => typeof r === "string")) return invalid();
      const fa = body.finalApproverId;
      if (fa !== undefined && fa !== null && typeof fa !== "string") return invalid();
      view = await submitForReview(deps.db, {
        documentId,
        viewer,
        reviewers: reviewers,
        ...(fa !== undefined ? { finalApproverId: fa } : {}),
      });
      break;
    }
    case "verdict": {
      const n = body.versionNumber;
      if (typeof body.verdict !== "string" || !VERDICTS.has(body.verdict)) return invalid();
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return invalid();
      if (body.note !== undefined && typeof body.note !== "string") return invalid();
      view = await reviewDocument(deps.db, deps.cipher, {
        documentId,
        viewer,
        verdict: body.verdict as "approve" | "request_changes",
        versionNumber: n,
        ...(typeof body.note === "string" ? { note: body.note } : {}),
      });
      break;
    }
    case "force": {
      const note = str(body, "note");
      if (note.trim() === "") return invalid();
      view = (await forceApprove(deps.db, deps.cipher, { documentId, viewer, note })).view;
      break;
    }
    case "reject": {
      const note = str(body, "note");
      if (note.trim() === "") return invalid();
      view = await rejectDocument(deps.db, deps.cipher, { documentId, viewer, note });
      break;
    }
    case "choose": {
      // Approve this option and reject the listed documents of its plan, in one transaction (chooseOption).
      const n = body.versionNumber;
      const reject = body.reject;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return invalid();
      if (!Array.isArray(reject) || reject.length > MAX_CHOOSE_REJECTS) return invalid();
      if (!reject.every((r): r is string => typeof r === "string" && r !== "")) return invalid();
      if (body.note !== undefined && typeof body.note !== "string") return invalid();
      view = (
        await chooseOption(deps.db, deps.cipher, {
          documentId,
          viewer,
          versionNumber: n,
          reject,
          ...(typeof body.note === "string" ? { note: body.note } : {}),
        })
      ).view;
      break;
    }
    case "reopen":
      view = await reopenDocument(deps.db, deps.cipher, { documentId, viewer });
      break;
    case "archive":
      if (typeof body.archived !== "boolean") return invalid();
      view = await setArchived(deps.db, { documentId, viewer, archived: body.archived });
      break;
    default:
      return invalid();
  }
  sendWebJson(res, 200, { review: reviewJson(view) });
}

/** GET /d/api/<id>/review-candidates: whom the owner may name (owner only). */
export async function getReviewCandidates(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
): Promise<void> {
  sendWebJson(res, 200, await reviewCandidates(deps.db, documentId, viewer));
}

/**
 * POST /d/api/<id>/share-links: the owner makes a comment link from the reviewer picker, for a reviewer
 * with no account. Answers the link's path (the page adds its own origin) once; it is never shown again
 * and never logged. Comment permission and the default expiry; the MCP tool create_share_link has the options.
 */
export async function postShareLink(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
): Promise<void> {
  const link = await createShareLink(deps.db, { documentId, viewer, permission: "comment" });
  sendWebJson(res, 200, { id: link.id, path: link.url, expiresAt: link.expiresAt.toISOString() });
}

/** A version's stored warnings (always an array). */
function storedWarnings(value: unknown): VersionWarning[] {
  return Array.isArray(value) ? (value as VersionWarning[]) : [];
}

/** A design save names at most this many files (a design has at most 50 boards plus manifest and brand). */
const MAX_SAVE_FILES = 60;
const MAX_PATH_LENGTH = 200;

/** `files` of a design save: path → new text, or null to delete. Anything else is invalid_request. */
function changedFiles(value: unknown): Map<string, string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SAVE_FILES) invalid();
  const out = new Map<string, string | null>();
  for (const [path, text] of entries) {
    if (path.length === 0 || path.length > MAX_PATH_LENGTH) invalid();
    if (text !== null && typeof text !== "string") invalid();
    out.set(path, text as string | null);
  }
  return out;
}

/**
 * Saves the editor's content. A document sends its whole Markdown; a design sends only changed files
 * (`null` deletes one, omitted ones stay as in `baseNumber`), merged here over `baseNumber`'s files.
 * Either way `baseNumber` must still be the latest (document_version_conflict otherwise).
 */
export async function putContent(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<void> {
  const baseNumber = body.baseNumber;
  if (typeof baseNumber !== "number" || !Number.isInteger(baseNumber) || baseNumber < 1) invalid();
  const expectedNumber = baseNumber as number;
  await requireDocumentAccess(deps.db, documentId, viewer, "write");
  if (viewer.kind !== "principal") throw new Error("document_access_denied");
  const doc = await deps.db.document.findUnique({ where: { id: documentId }, select: { kind: true } });
  if (!doc) throw new Error("document_not_found");
  let content: { markdown: string } | { files: Record<string, string> };
  if (doc.kind === "design") {
    if (body.markdown !== undefined) throw new Error("document_format_mismatch");
    const changed = changedFiles(body.files);
    const current = await getDocument(deps.db, documentId);
    if (current.version.number !== expectedNumber) throw new Error("document_version_conflict");
    if (current.content.format !== "boards-v1") throw new Error("document_format_mismatch");
    // A Map, then Object.fromEntries: own data properties only, so no path can reach a prototype.
    const merged = new Map(Object.entries(current.content.files));
    for (const [path, text] of changed) {
      if (text === null) merged.delete(path);
      else merged.set(path, text);
    }
    content = { files: Object.fromEntries(merged) };
  } else {
    if (body.files !== undefined) throw new Error("document_format_mismatch");
    content = { markdown: str(body, "markdown") };
  }
  const v = await publishVersion(deps.db, deps.cipher, {
    documentId,
    ...content,
    via: "editor",
    createdById: viewer.principalId,
    expectedNumber,
  });
  sendWebJson(res, 200, { version: { number: v.number }, reanchored: v.reanchored, warnings: v.warnings });
}

const MAX_FIDELITY_SAMPLES = 6;
const MAX_SAMPLE_LENGTH = 160;
const MAX_MISMATCHES = 10_000;
const MAX_FIDELITY_BOARDS = 50;

/** The fidelity report's boards, checked field by field; anything else is invalid_request. */
function fidelityBoards(value: unknown): FidelityBoard[] {
  if (!Array.isArray(value) || value.length > MAX_FIDELITY_BOARDS) invalid();
  const seen = new Set<string>();
  return (value as unknown[]).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid();
    const { board, mismatches, samples } = item as Record<string, unknown>;
    if (typeof board !== "string" || !BOARD_ID.test(board) || seen.has(board)) invalid();
    seen.add(board as string);
    if (typeof mismatches !== "number" || !Number.isInteger(mismatches) || mismatches < 0) invalid();
    if ((mismatches as number) > MAX_MISMATCHES) invalid();
    if (!Array.isArray(samples) || samples.length > MAX_FIDELITY_SAMPLES) invalid();
    for (const s of samples as unknown[]) if (typeof s !== "string" || s.length > MAX_SAMPLE_LENGTH) invalid();
    return { board: board as string, mismatches: mismatches as number, samples: [...(samples as string[])] };
  });
}

/** The page's fidelity check for one design version: stored once (fidelity.ts); 204. Needs write. */
export async function postFidelity(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  body: Record<string, unknown>,
): Promise<void> {
  const number = body.versionNumber;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) invalid();
  const boards = fidelityBoards(body.boards);
  await requireDocumentAccess(deps.db, documentId, viewer, "write");
  await recordFidelity(deps.db, deps.cipher, { documentId, number: number as number, boards });
  res.writeHead(204, { "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
}

/**
 * A design version's boards as sandboxed-frame HTML (frames.ts): `mode` play (board links go to the
 * parent page's fragment) or overview (no links); `version` defaults to the current one. Read access.
 */
export async function getFrames(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  params: URLSearchParams,
): Promise<void> {
  const mode = params.get("mode");
  if (mode !== "play" && mode !== "overview") invalid();
  const number = intParam(params, "version", Number.MAX_SAFE_INTEGER);
  await requireDocumentAccess(deps.db, documentId, viewer, "read");
  const doc = await deps.db.document.findUnique({ where: { id: documentId }, select: { kind: true } });
  if (!doc) throw new Error("document_not_found");
  if (doc.kind !== "design") throw new Error("document_format_mismatch");
  let content;
  let versionId: string;
  if (number === undefined) {
    const current = await getDocument(deps.db, documentId);
    content = current.content;
    versionId = current.version.id;
  } else {
    const v = await deps.db.documentVersion.findUnique({
      where: { documentId_number: { documentId, number } },
      select: { id: true, format: true, markdown: true },
    });
    if (!v) throw new Error("document_version_not_found");
    content = await loadContent(deps.db, v);
    versionId = v.id;
  }
  if (content.format !== "boards-v1") throw new Error("document_format_mismatch");
  const files = content.files;
  const manifest = parseManifest(files[MANIFEST_PATH] ?? "");
  const boards = versionFrames(versionId, mode as "play" | "overview", manifest.boards, files);
  sendWebJson(res, 200, { boards });
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

/** One version's Markdown, or a design version's files (redacted when it was published). */
export async function getVersionJson(
  res: ServerResponse,
  deps: WebDeps,
  documentId: string,
  viewer: Viewer,
  number: number,
): Promise<void> {
  const v = await getVersion(deps.db, { documentId, viewer, number });
  const content = v.content.format === "markdown" ? { markdown: v.content.markdown } : { files: v.content.files };
  sendWebJson(res, 200, { version: { number: v.number, format: v.format, ...content, createdAt: v.createdAt } });
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
