/**
 * Document review actions (spec "States", "Roles", "Concurrency"). Every action runs in one
 * Serializable transaction (withSerializableRetry + preferIndexScans, as publishVersion) that reads
 * the document row, the current version number, the reviewers and the latest force and reopen
 * events, checks the action, writes, recomputes the state with the pure rule (review-state.ts) and
 * appends one event. Live pages are told after the commit (`review`).
 *
 * Time: the state rule orders verdicts and forces against the latest reopen by timestamp, so one
 * action takes its verdict time and its event time from one clock, the database's, read inside the
 * transaction after its reads, and always later than the document's newest review event. An action
 * that saw an earlier one in its snapshot is therefore always stamped after it.
 *
 * Access: each action checks access once early (to fail fast and to find the agent for redaction) and again
 * inside its transaction, so a grant or share link revoked in between is seen.
 *
 * Secrets: notes are redacted by exact value against the document agent's secret values before the
 * transaction, as comment bodies are; events carry ids, states, version numbers and notes only.
 * Errors are codes; nothing here logs.
 */
import { Prisma, type PrismaClient } from "#prisma";
import { atLeast, effectiveAccess, principalGranteeKey } from "../grants.js";
import type { loadAgentSecretValues } from "../secret-guard.js";
import { preferIndexScans, withSerializableRetry } from "../serializable-retry.js";
import { documentAccess, requireDocumentAccess, type Viewer } from "./access.js";
import { mentionCandidates, principalNames } from "./comments.js";
import { notifyDocumentChange } from "./events.js";
import { DOCUMENT_WRITE_ATTEMPTS, MAX_REVIEW_EVENTS, MAX_REVIEW_NOTE_CHARS, MAX_REVIEWERS } from "./limits.js";
import { redactForDocumentAgent } from "./redact.js";
import {
  approvedCount,
  computeReviewState,
  countsNow,
  forceCounts,
  isLocked,
  isReviewState,
  overriddenReviewerIds,
  overrideSentence,
  reviewerCounts,
  type Mark,
  type ReviewEventKind,
  type ReviewState,
  type RuleInput,
  type Verdict,
} from "./review-state.js";

export type Cipher = Parameters<typeof loadAgentSecretValues>[1];
type Tx = Prisma.TransactionClient;

export class ReviewVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("document_version_conflict");
    this.name = "ReviewVersionConflictError";
  }
}

export interface ReviewerView {
  id: string;
  kind: "member" | "guest";
  /** A principal id or `guest:<guestId>` (the form submit_for_review takes). */
  ref: string;
  name: string;
  verdict: Verdict;
  versionNumber: number | null;
  note: string | null;
  verdictAt: Date | null;
  /** The verdict counts now (on the current version and not before its latest reopen). */
  current: boolean;
  me: boolean;
}

export interface ReviewEventView {
  id: string;
  kind: ReviewEventKind;
  actorRef: string | null;
  actorName: string;
  fromState: ReviewState;
  toState: ReviewState;
  versionNumber: number;
  note: string | null;
  overridden: string[];
  createdAt: Date;
}

export interface ReviewCan {
  submit: boolean;
  review: boolean;
  force: boolean;
  reopen: boolean;
  archive: boolean;
  unarchive: boolean;
}

export interface ReviewView {
  documentId: string;
  state: ReviewState;
  currentVersion: number;
  progress: { approved: number; total: number };
  reviewers: ReviewerView[];
  finalApprover: { principalId: string; name: string; me: boolean } | null;
  forced: { byName: string; versionNumber: number; notes: string[] } | null;
  /** Newest first, at most MAX_REVIEW_EVENTS. */
  events: ReviewEventView[];
  can: ReviewCan;
}

const SUBMITTABLE = new Set<string>(["draft", "in_review", "changes_requested"]);
const REVIEWABLE = new Set<string>(["in_review", "changes_requested", "approved"]);
const FORCEABLE = new Set<string>(["in_review", "changes_requested"]);
const invalid = (): never => {
  throw new Error("document_review_state_invalid");
};

async function inReviewTx<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withSerializableRetry(
    () =>
      db.$transaction(
        async (tx) => {
          await preferIndexScans(tx);
          return fn(tx);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    { attempts: DOCUMENT_WRITE_ATTEMPTS },
  );
}

/** Everything the state rule reads, inside the caller's transaction. */
async function readReview(tx: Tx, documentId: string) {
  const doc = await tx.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      ownerId: true,
      agentId: true,
      reviewState: true,
      reviewStateBeforeArchive: true,
      finalApproverId: true,
    },
  });
  if (!doc) throw new Error("document_not_found");
  const last = await tx.documentVersion.aggregate({ where: { documentId }, _max: { number: true } });
  const reviewers = await tx.documentReviewer.findMany({
    where: { documentId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const latest = async (kind?: ReviewEventKind): Promise<Mark | null> => {
    const e = await tx.documentReviewEvent.findFirst({
      where: { documentId, ...(kind ? { kind } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { versionNumber: true, createdAt: true },
    });
    return e ? { versionNumber: e.versionNumber, at: e.createdAt } : null;
  };
  const rule: RuleInput = {
    currentVersion: last._max.number ?? 0,
    reviewers: reviewers.map((r) => ({
      id: r.id,
      verdict: r.verdict as Verdict,
      versionNumber: r.versionNumber,
      verdictAt: r.verdictAt,
    })),
    force: await latest("force_approved"),
    reopen: await latest("reopened"),
  };
  return { doc, reviewers, rule, lastEventAt: (await latest())?.at ?? null };
}

/**
 * The time of one action: the database clock, read after the action's reads, and at least a millisecond
 * after the document's newest review event (the columns keep milliseconds), so ordering by timestamp
 * matches the order the transactions saw each other in.
 */
async function actionTime(tx: Tx, lastEventAt: Date | null): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return lastEventAt && now.getTime() <= lastEventAt.getTime() ? new Date(lastEventAt.getTime() + 1) : now;
}

/** Writes the new state (when it changed) and one event stamped `at`. */
async function record(
  tx: Tx,
  input: {
    documentId: string;
    viewer: Viewer;
    kind: ReviewEventKind;
    from: string;
    to: ReviewState;
    versionNumber: number;
    at: Date;
    note?: string | null;
    overridden?: string[];
    extra?: Prisma.DocumentUpdateInput;
  },
): Promise<void> {
  if (input.from !== input.to || input.extra) {
    await tx.document.update({ where: { id: input.documentId }, data: { reviewState: input.to, ...input.extra } });
  }
  await tx.documentReviewEvent.create({
    data: {
      documentId: input.documentId,
      actorPrincipalId: input.viewer.kind === "principal" ? input.viewer.principalId : null,
      actorGuestId: input.viewer.kind === "guest" ? input.viewer.guestId : null,
      kind: input.kind,
      fromState: input.from,
      toState: input.to,
      versionNumber: input.versionNumber,
      note: input.note ?? null,
      createdAt: input.at,
      ...(input.overridden ? { overridden: input.overridden } : {}),
    },
  });
}

/** A note as it will be stored: length-checked, then redacted against the document agent's secret values. */
async function storedNote(
  db: PrismaClient,
  cipher: Cipher,
  agentId: string | null,
  note: string | undefined,
): Promise<string | null> {
  if (note === undefined || note.trim() === "") return null;
  if (note.length > MAX_REVIEW_NOTE_CHARS) throw new Error("comment_too_long");
  return redactForDocumentAgent(db, cipher, agentId, note);
}

/** A comment share link on this document that is still live (not revoked, not expired). */
const liveCommentLink = (documentId: string) => ({
  documentId,
  permission: "comment",
  revokedAt: null,
  expiresAt: { gt: new Date() },
});

type Ref = { principalId: string } | { guestId: string };
const parseRef = (ref: string): Ref => (ref.startsWith("guest:") ? { guestId: ref.slice(6) } : { principalId: ref });

/** Raises a principal to comment access on the document when they hold less; never lowers a grant. */
async function ensureCommentAccess(tx: Tx, doc: { id: string; ownerId: string }, principalId: string, by: string) {
  if (atLeast("document", await effectiveAccess(tx, "document", doc, principalId), "comment")) return;
  const granteeKey = principalGranteeKey(principalId);
  await tx.resourceGrant.upsert({
    where: { resourceType_resourceId_granteeKey: { resourceType: "document", resourceId: doc.id, granteeKey } },
    create: {
      resourceType: "document",
      resourceId: doc.id,
      granteeKind: "principal",
      granteePrincipalId: principalId,
      granteeKey,
      level: "comment",
      source: "document_review",
      grantedById: by,
    },
    update: { level: "comment", source: "document_review", grantedById: by },
  });
}

export async function submitForReview(
  db: PrismaClient,
  input: { documentId: string; viewer: Viewer; reviewers: string[]; finalApproverId?: string | null },
): Promise<ReviewView> {
  await requireDocumentAccess(db, input.documentId, input.viewer, "owner");
  if (input.viewer.kind !== "principal") throw new Error("document_access_denied");
  const by = input.viewer.principalId;
  const refs = [...new Set(input.reviewers)];
  if (refs.length === 0 || refs.length > MAX_REVIEWERS) invalid();
  const parsed = refs.map(parseRef);
  const principalIds = parsed.flatMap((r) => ("principalId" in r ? [r.principalId] : []));
  const guestIds = parsed.flatMap((r) => ("guestId" in r ? [r.guestId] : []));
  const approver = input.finalApproverId;
  await inReviewTx(db, async (tx) => {
    await requireDocumentAccess(tx, input.documentId, input.viewer, "owner");
    const { doc, reviewers, rule, lastEventAt } = await readReview(tx, input.documentId);
    if (!SUBMITTABLE.has(doc.reviewState)) invalid();
    const known = await tx.principal.findMany({
      where: { id: { in: [...principalIds, ...(approver ? [approver] : [])] } },
      select: { id: true },
    });
    const knownIds = new Set(known.map((p) => p.id));
    if (principalIds.some((id) => !knownIds.has(id)) || (approver && !knownIds.has(approver))) invalid();
    const guests = await tx.documentGuest.findMany({
      where: { id: { in: guestIds }, shareLink: liveCommentLink(doc.id) },
      select: { id: true },
    });
    if (guests.length !== guestIds.length) invalid();
    // Replace the list: rows no longer named go (their events stay), new names start with no verdict.
    const keep = reviewers.filter((r) =>
      r.principalId ? principalIds.includes(r.principalId) : r.guestId ? guestIds.includes(r.guestId) : false,
    );
    const drop = reviewers.filter((r) => !keep.includes(r)).map((r) => r.id);
    if (drop.length) await tx.documentReviewer.deleteMany({ where: { id: { in: drop } } });
    for (const principalId of principalIds) {
      if (!keep.some((r) => r.principalId === principalId)) {
        await tx.documentReviewer.create({ data: { documentId: doc.id, principalId } });
      }
      await ensureCommentAccess(tx, doc, principalId, by);
    }
    for (const guestId of guestIds) {
      if (!keep.some((r) => r.guestId === guestId)) {
        await tx.documentReviewer.create({ data: { documentId: doc.id, guestId } });
      }
    }
    if (approver) await ensureCommentAccess(tx, doc, approver, by);
    const next = await readReview(tx, doc.id);
    await record(tx, {
      documentId: doc.id,
      viewer: input.viewer,
      kind: doc.reviewState === "draft" ? "submitted" : "reviewers_changed",
      from: doc.reviewState,
      to: computeReviewState(next.rule),
      versionNumber: rule.currentVersion,
      at: await actionTime(tx, lastEventAt),
      ...(approver !== undefined ? { extra: { finalApproverId: approver } } : {}),
    });
  });
  await notifyDocumentChange(db, input.documentId, "review");
  return getReviewView(db, input.documentId, input.viewer);
}

export async function reviewDocument(
  db: PrismaClient,
  cipher: Cipher,
  input: {
    documentId: string;
    viewer: Viewer;
    verdict: "approve" | "request_changes";
    versionNumber: number;
    note?: string;
  },
): Promise<ReviewView> {
  const doc = await requireDocumentAccess(db, input.documentId, input.viewer, "comment");
  const note = await storedNote(db, cipher, doc.agentId, input.note);
  const verdict: Verdict = input.verdict === "approve" ? "approved" : "changes_requested";
  const changed = await inReviewTx(db, async (tx) => {
    // Live access decides inside the transaction: a grant or link revoked since the early check is seen here.
    await requireDocumentAccess(tx, input.documentId, input.viewer, "comment");
    const { doc: row, reviewers, rule, lastEventAt } = await readReview(tx, input.documentId);
    const viewer = input.viewer;
    const mine = reviewers.find((r) =>
      viewer.kind === "principal" ? r.principalId === viewer.principalId : r.guestId === viewer.guestId,
    );
    if (!mine) throw new Error("document_review_forbidden");
    if (!REVIEWABLE.has(row.reviewState)) invalid();
    // A force approval is final: only a writer's reopen takes the document back to review.
    if (row.reviewState === "approved" && forceCounts(rule)) invalid();
    if (input.versionNumber !== rule.currentVersion) throw new ReviewVersionConflictError(rule.currentVersion);
    // A repeat of the verdict that counts now changes nothing: no row update, no event (a new note is dropped).
    const counted = rule.reviewers.find((r) => r.id === mine.id);
    if (counted && counted.verdict === verdict && reviewerCounts(counted, rule)) return false;
    // One clock for the verdict and its event (see the file header).
    const at = await actionTime(tx, lastEventAt);
    await tx.documentReviewer.update({
      where: { id: mine.id },
      data: { verdict, versionNumber: rule.currentVersion, note, verdictAt: at },
    });
    const next = await readReview(tx, row.id);
    await record(tx, {
      documentId: row.id,
      viewer,
      kind: verdict === "approved" ? "approved" : "changes_requested",
      from: row.reviewState,
      to: computeReviewState(next.rule),
      versionNumber: rule.currentVersion,
      at,
      note,
    });
    return true;
  });
  if (changed) await notifyDocumentChange(db, input.documentId, "review");
  return getReviewView(db, input.documentId, input.viewer);
}

export async function forceApprove(
  db: PrismaClient,
  cipher: Cipher,
  input: { documentId: string; viewer: Viewer; note: string },
): Promise<{ view: ReviewView; overridden: string[] }> {
  const viewer = input.viewer;
  if (viewer.kind !== "principal") throw new Error("document_review_forbidden");
  const principalId = viewer.principalId;
  const access = await documentAccess(db, input.documentId, input.viewer);
  if (access === "none") throw new Error("document_not_found");
  const docRow = await db.document.findUnique({
    where: { id: input.documentId },
    select: { agentId: true, finalApproverId: true },
  });
  // Deleted since the access check.
  if (!docRow) throw new Error("document_not_found");
  const isApprover = docRow.finalApproverId === principalId && atLeast("document", access, "comment");
  if (access !== "owner" && !isApprover) throw new Error("document_review_forbidden");
  if (input.note.trim() === "") invalid();
  const note = await storedNote(db, cipher, docRow.agentId, input.note);
  const overridden = await inReviewTx(db, async (tx) => {
    // Force rights follow live access, the current owner and the current final approver, read in the transaction.
    const accessNow = await documentAccess(tx, input.documentId, viewer);
    if (accessNow === "none") throw new Error("document_not_found");
    const { doc, rule, lastEventAt } = await readReview(tx, input.documentId);
    const approverNow = doc.finalApproverId === principalId && atLeast("document", accessNow, "comment");
    if (accessNow !== "owner" && !approverNow) throw new Error("document_review_forbidden");
    if (!FORCEABLE.has(doc.reviewState)) invalid();
    const ids = overriddenReviewerIds(rule);
    await record(tx, {
      documentId: doc.id,
      viewer: input.viewer,
      kind: "force_approved",
      from: doc.reviewState,
      to: "approved",
      versionNumber: rule.currentVersion,
      at: await actionTime(tx, lastEventAt),
      note,
      overridden: ids,
    });
    return ids;
  });
  await notifyDocumentChange(db, input.documentId, "review");
  return { view: await getReviewView(db, input.documentId, input.viewer), overridden };
}

export async function reopenDocument(
  db: PrismaClient,
  input: { documentId: string; viewer: Viewer },
): Promise<ReviewView> {
  await requireDocumentAccess(db, input.documentId, input.viewer, "write");
  if (input.viewer.kind !== "principal") throw new Error("document_access_denied");
  await inReviewTx(db, async (tx) => {
    await requireDocumentAccess(tx, input.documentId, input.viewer, "write");
    const { doc, rule, lastEventAt } = await readReview(tx, input.documentId);
    if (doc.reviewState !== "approved") invalid();
    await record(tx, {
      documentId: doc.id,
      viewer: input.viewer,
      kind: "reopened",
      from: "approved",
      to: "in_review",
      versionNumber: rule.currentVersion,
      at: await actionTime(tx, lastEventAt),
    });
  });
  await notifyDocumentChange(db, input.documentId, "review");
  return getReviewView(db, input.documentId, input.viewer);
}

export async function setArchived(
  db: PrismaClient,
  input: { documentId: string; viewer: Viewer; archived: boolean },
): Promise<ReviewView> {
  await requireDocumentAccess(db, input.documentId, input.viewer, "owner");
  await inReviewTx(db, async (tx) => {
    await requireDocumentAccess(tx, input.documentId, input.viewer, "owner");
    const { doc, rule, lastEventAt } = await readReview(tx, input.documentId);
    if (input.archived === (doc.reviewState === "archived")) invalid();
    const back = doc.reviewStateBeforeArchive;
    const to: ReviewState = input.archived
      ? "archived"
      : back && isReviewState(back) && back !== "archived"
        ? back
        : "draft";
    await record(tx, {
      documentId: doc.id,
      viewer: input.viewer,
      kind: input.archived ? "archived" : "unarchived",
      from: doc.reviewState,
      to,
      versionNumber: rule.currentVersion,
      at: await actionTime(tx, lastEventAt),
      extra: { reviewStateBeforeArchive: input.archived ? doc.reviewState : null },
    });
  });
  await notifyDocumentChange(db, input.documentId, "review");
  return getReviewView(db, input.documentId, input.viewer);
}

/** In publishVersion's transaction, before the version is written: refuses an approved or archived document. */
export async function assertNotLocked(tx: Tx, documentId: string): Promise<void> {
  const row = await tx.document.findUnique({ where: { id: documentId }, select: { reviewState: true } });
  if (!row) throw new Error("document_not_found");
  if (isLocked(row.reviewState)) throw new Error("document_locked");
}

/**
 * In publishVersion's transaction, after the new version is current: while in review, the state is
 * recomputed (older verdicts stop counting). No event row: a publish is not a review action.
 */
export async function recomputeAfterPublish(tx: Tx, documentId: string): Promise<void> {
  const { doc, rule } = await readReview(tx, documentId);
  if (doc.reviewState !== "in_review" && doc.reviewState !== "changes_requested") return;
  const to = computeReviewState(rule);
  if (to !== doc.reviewState) await tx.document.update({ where: { id: documentId }, data: { reviewState: to } });
}

/** The stored state, or null when the document does not exist. */
export async function documentReviewState(
  db: Pick<PrismaClient, "document">,
  documentId: string,
): Promise<ReviewState | null> {
  const row = await db.document.findUnique({ where: { id: documentId }, select: { reviewState: true } });
  return row && isReviewState(row.reviewState) ? row.reviewState : null;
}

export async function getReviewView(db: PrismaClient, documentId: string, viewer: Viewer): Promise<ReviewView> {
  await requireDocumentAccess(db, documentId, viewer, "read");
  const access = await documentAccess(db, documentId, viewer);
  // One snapshot: state, reviewers, the force banner and the events agree with each other.
  const { doc, reviewers, rule, events } = await db.$transaction(
    async (tx) => ({
      ...(await readReview(tx, documentId)),
      events: await tx.documentReviewEvent.findMany({
        where: { documentId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MAX_REVIEW_EVENTS,
      }),
    }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const guestIds = [
    ...new Set([
      ...reviewers.flatMap((r) => (r.guestId ? [r.guestId] : [])),
      ...events.flatMap((e) => (e.actorGuestId ? [e.actorGuestId] : [])),
    ]),
  ];
  const guests = new Map(
    (await db.documentGuest.findMany({ where: { id: { in: guestIds } }, select: { id: true, name: true } })).map(
      (g) => [g.id, `${g.name} (guest)`],
    ),
  );
  const names = await principalNames(db, [
    ...reviewers.flatMap((r) => (r.principalId ? [r.principalId] : [])),
    ...events.flatMap((e) => (e.actorPrincipalId ? [e.actorPrincipalId] : [])),
    ...(doc.finalApproverId ? [doc.finalApproverId] : []),
  ]);
  const nameOf = (p: string | null, g: string | null) =>
    p ? (names.get(p) ?? "Former member") : g ? (guests.get(g) ?? "Guest") : "Someone";
  const isMe = (p: string | null, g: string | null) =>
    viewer.kind === "principal" ? p !== null && p === viewer.principalId : g !== null && g === viewer.guestId;
  const state = isReviewState(doc.reviewState) ? doc.reviewState : "draft";
  // Whether each reviewer's verdict counts now: the view and the force banner use the same answer.
  const counts = new Map(rule.reviewers.map((r) => [r.id, reviewerCounts(r, rule)]));
  const reviewerViews: ReviewerView[] = reviewers.map((r) => ({
    id: r.id,
    kind: r.principalId ? "member" : "guest",
    ref: r.principalId ?? `guest:${r.guestId}`,
    name: nameOf(r.principalId, r.guestId),
    verdict: r.verdict as Verdict,
    versionNumber: r.versionNumber,
    note: r.note,
    verdictAt: r.verdictAt,
    current: counts.get(r.id) ?? false,
    me: isMe(r.principalId, r.guestId),
  }));
  // The force that decides the state now: the latest force event, while it counts on the current version.
  const forceEvent = events.find((e) => e.kind === "force_approved");
  const forced =
    state === "approved" &&
    forceEvent &&
    countsNow({ versionNumber: forceEvent.versionNumber, at: forceEvent.createdAt }, rule)
      ? {
          byName: nameOf(forceEvent.actorPrincipalId, forceEvent.actorGuestId),
          versionNumber: forceEvent.versionNumber,
          notes: ((forceEvent.overridden as string[] | null) ?? []).map((id) => {
            const row = reviewers.find((r) => r.id === id);
            if (!row) return overrideSentence(null, null, forceEvent.versionNumber);
            // A verdict that no longer counts (e.g. changes requested before a reopen) is reported as no review.
            const verdict: Verdict = counts.get(row.id) ? (row.verdict as Verdict) : "none";
            return overrideSentence(
              nameOf(row.principalId, row.guestId),
              { verdict, versionNumber: row.versionNumber },
              forceEvent.versionNumber,
            );
          }),
        }
      : null;
  const principalId = viewer.kind === "principal" ? viewer.principalId : null;
  const owner = access === "owner";
  const listed = reviewerViews.some((r) => r.me);
  return {
    documentId,
    state,
    currentVersion: rule.currentVersion,
    progress: { approved: approvedCount(rule), total: reviewers.length },
    reviewers: reviewerViews,
    finalApprover: doc.finalApproverId
      ? {
          principalId: doc.finalApproverId,
          name: nameOf(doc.finalApproverId, null),
          me: doc.finalApproverId === principalId,
        }
      : null,
    forced,
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind as ReviewEventKind,
      actorRef: e.actorPrincipalId ?? (e.actorGuestId ? `guest:${e.actorGuestId}` : null),
      actorName: nameOf(e.actorPrincipalId, e.actorGuestId),
      fromState: e.fromState as ReviewState,
      toState: e.toState as ReviewState,
      versionNumber: e.versionNumber,
      note: e.note,
      overridden: (e.overridden as string[] | null) ?? [],
      createdAt: e.createdAt,
    })),
    can: {
      submit: owner && SUBMITTABLE.has(state),
      review:
        listed &&
        REVIEWABLE.has(state) &&
        !(state === "approved" && forceCounts(rule)) &&
        atLeast("document", access, "comment"),
      force:
        FORCEABLE.has(state) &&
        (owner ||
          (principalId !== null && principalId === doc.finalApproverId && atLeast("document", access, "comment"))),
      reopen: principalId !== null && state === "approved" && atLeast("document", access, "write"),
      archive: owner && state !== "archived",
      unarchive: owner && state === "archived",
    },
  };
}

/**
 * Who the owner may name: people with access (owner and principal grantees, as @-mentions list them) and this
 * document's comment-link guests who gave a name. Owner only.
 */
export async function reviewCandidates(
  db: PrismaClient,
  documentId: string,
  viewer: Viewer,
): Promise<{ members: { principalId: string; name: string }[]; guests: { guestId: string; name: string }[] }> {
  await requireDocumentAccess(db, documentId, viewer, "owner");
  const members = await mentionCandidates(db, documentId);
  const guests = await db.documentGuest.findMany({
    where: { shareLink: liveCommentLink(documentId) },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  return { members, guests: guests.map((g) => ({ guestId: g.id, name: g.name })) };
}
