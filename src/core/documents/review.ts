/**
 * Document review actions (spec "States", "Roles", "Concurrency"). Every action runs in one
 * Serializable transaction (withSerializableRetry + preferIndexScans, as publishVersion) that reads
 * the document row, the current version number, the reviewers and the latest force event,
 * checks the action, writes, recomputes the state with the pure rule (review-state.ts) and
 * appends one event. Live pages are told after the commit (`review`; a reopen, which also writes a version,
 * sends `version` too).
 *
 * Time: the events are the document's history, read in timestamp order, so one action takes its verdict
 * time and its event time from one clock, the database's, read inside the transaction after its reads, and
 * always later than the document's newest review event. An action that saw an earlier one in its snapshot is
 * therefore always stamped after it.
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
import { resolveRouter } from "../review-routing/lineage.js";
import { notifyDocumentChange } from "./events.js";
import { runReviewHooks } from "./review-hooks.js";
import { loadContent } from "./files.js";
import { formatFor } from "./formats/index.js";
import { DOCUMENT_WRITE_ATTEMPTS, MAX_REVIEW_EVENTS, MAX_REVIEW_NOTE_CHARS, MAX_REVIEWERS } from "./limits.js";
import { documentSecretValues, redactForDocumentAgent } from "./redact.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { stageVersion, writeVersion } from "./version-write.js";
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
  /** The verdict counts now (it is on the current version). */
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
  /** Reject this document (rejectDocument): only in a set, never a plan's plan.md. */
  reject: boolean;
  /** Choose this document over others in a set (chooseOption): approve it (or it is approved) and reject them. */
  choose: boolean;
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
  /** Where review actions go now and where the newest went (names are stored, redacted text). */
  routing: ReviewRoutingView;
  can: ReviewCan;
}

export interface ReviewRoutingView {
  /** The router the next review action would reach, or null (nothing is started). */
  router: { id: string; name: string } | null;
  /** The document's (or its set's) newest jobs, newest first. */
  jobs: {
    at: Date;
    eventId: string;
    /** "started", or a refusal code; null while the job is being claimed. */
    outcome: string | null;
    /** The router this job ran for (its own, which may differ from the router now). */
    routerName: string;
    /** Each started agent; the task line only for the document's owner or someone who can execute the router. */
    started: { agentName: string; task: string | null }[];
  }[];
}

const MAX_ROUTING_JOBS = 20;
const MAX_ROUTING_CHILDREN_PER_JOB = 10;
const MAX_TASK_LINE_CHARS = 200;

const SUBMITTABLE = new Set<string>(["draft", "in_review", "changes_requested"]);
const REVIEWABLE = new Set<string>(["in_review", "changes_requested", "approved"]);
const FORCEABLE = new Set<string>(["in_review", "changes_requested"]);
const REJECTABLE = new Set<string>(["in_review", "changes_requested", "approved"]);
/** Reopen takes these back to review (a rejected document also back into its plan). */
const REOPENABLE = new Set<string>(["approved", "rejected"]);
const invalid = (): never => {
  throw new Error("document_review_state_invalid");
};

async function inReviewTx<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>, eventIds?: string[]): Promise<T> {
  return withSerializableRetry(
    () =>
      db.$transaction(
        async (tx) => {
          // A retry re-runs fn: the ids of an aborted attempt's events (rolled back) must not survive it.
          if (eventIds) eventIds.length = 0;
          await preferIndexScans(tx);
          return fn(tx);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    { attempts: DOCUMENT_WRITE_ATTEMPTS },
  );
}

type Placement = { planSetId: string | null; setId: string | null; planPath: string | null; removedFromPlan: boolean };

/**
 * The set a document belongs to for choose and reject (documents/sets.ts): a plan document by its plan set,
 * else a native option by its document set; null outside a set.
 */
function memberOf(doc: Placement): string | null {
  if (doc.planSetId !== null) return `plan:${doc.planSetId}`;
  return doc.setId !== null ? `set:${doc.setId}` : null;
}

/** A document Reject applies to: one of a set, still in it, and never a plan's plan.md. */
function rejectablePlacement(doc: Placement) {
  if (doc.removedFromPlan) return false;
  if (doc.planSetId !== null) return doc.planPath !== null && doc.planPath !== "plan.md";
  return doc.setId !== null;
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
      // Set placement, for Reject (rejectDocument and the view's can.reject read it in the same snapshot).
      planSetId: true,
      planPath: true,
      setId: true,
      option: true,
      removedFromPlan: true,
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
    /** null: a publish with no known author (recomputeAfterPublish). */
    viewer: Viewer | null;
    kind: ReviewEventKind;
    from: string;
    to: ReviewState;
    versionNumber: number;
    at: Date;
    note?: string | null;
    overridden?: string[];
    extra?: Prisma.DocumentUpdateInput;
  },
): Promise<string> {
  if (input.from !== input.to || input.extra) {
    await tx.document.update({ where: { id: input.documentId }, data: { reviewState: input.to, ...input.extra } });
  }
  const event = await tx.documentReviewEvent.create({
    select: { id: true },
    data: {
      documentId: input.documentId,
      actorPrincipalId: input.viewer?.kind === "principal" ? input.viewer.principalId : null,
      actorGuestId: input.viewer?.kind === "guest" ? input.viewer.guestId : null,
      actorRunId: input.viewer?.kind === "agent" ? input.viewer.runId : null,
      kind: input.kind,
      fromState: input.from,
      toState: input.to,
      versionNumber: input.versionNumber,
      note: input.note ?? null,
      createdAt: input.at,
      ...(input.overridden ? { overridden: input.overridden } : {}),
    },
  });
  return event.id;
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
  // Through the shared rule, so access that comes live from a plan's access agent is not copied into a grant.
  const held = await documentAccess(tx, doc.id, { kind: "principal", principalId });
  if (atLeast("document", held, "comment")) return;
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

/**
 * An agent never approves, force-approves, reopens or archives. The document check runs first, so an agent
 * with no access to the document sees document_not_found, not a refusal that confirms it exists.
 */
async function denyAgent(db: PrismaClient, documentId: string, viewer: Viewer): Promise<never> {
  await requireDocumentAccess(db, documentId, viewer, "read");
  throw new Error("document_access_denied");
}

export async function submitForReview(
  db: PrismaClient,
  cipher: Cipher,
  input: {
    documentId: string;
    viewer: Viewer;
    reviewers: string[];
    finalApproverId?: string | null;
    note?: string;
    /**
     * Plan publish: the router hook skips this submit (ReviewAction.deferRouting) and its event ids are added
     * here, so the publish routes all its submits once at the end.
     */
    deferRouting?: { eventIds: string[] };
  },
): Promise<ReviewView> {
  // An agent needs write on the document; a person needs to own it.
  const need = input.viewer.kind === "agent" ? "write" : "owner";
  await requireDocumentAccess(db, input.documentId, input.viewer, need);
  if (input.viewer.kind === "guest") throw new Error("document_access_denied");
  const by = input.viewer.kind === "principal" ? input.viewer.principalId : null;
  const refs = [...new Set(input.reviewers)];
  if (refs.length === 0 || refs.length > MAX_REVIEWERS) invalid();
  const parsed = refs.map(parseRef);
  const principalIds = parsed.flatMap((r) => ("principalId" in r ? [r.principalId] : []));
  const guestIds = parsed.flatMap((r) => ("guestId" in r ? [r.guestId] : []));
  const approver = input.finalApproverId;
  const docRow = await db.document.findUnique({ where: { id: input.documentId }, select: { agentId: true } });
  if (!docRow) throw new Error("document_not_found");
  const note = await storedNote(db, cipher, docRow.agentId, input.note);
  const eventIds: string[] = [];
  await inReviewTx(
    db,
    async (tx) => {
      await requireDocumentAccess(tx, input.documentId, input.viewer, need);
      const { doc, reviewers, rule, lastEventAt } = await readReview(tx, input.documentId);
      // Grants made for the reviewers are attributed to the owner when an agent submits.
      const grantedBy = by ?? doc.ownerId;
      // An agent submits only its own owner's documents: the reviewer grants it makes act on the owner's behalf,
      // so a document someone else owns (one they linked to the agent) is never shared by it.
      if (input.viewer.kind === "agent") {
        const agent = await tx.agent.findUnique({ where: { id: input.viewer.agentId }, select: { ownerId: true } });
        if (!agent?.ownerId || agent.ownerId !== doc.ownerId) throw new Error("document_review_forbidden");
      }
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
        await ensureCommentAccess(tx, doc, principalId, grantedBy);
      }
      for (const guestId of guestIds) {
        if (!keep.some((r) => r.guestId === guestId)) {
          await tx.documentReviewer.create({ data: { documentId: doc.id, guestId } });
        }
      }
      if (approver) await ensureCommentAccess(tx, doc, approver, grantedBy);
      // A resubmit that changes nothing (same reviewers and final approver, no note) is no review action: a
      // revision is recorded when its version is published (recomputeAfterPublish), so it routes once.
      const added = principalIds.length + guestIds.length - keep.length;
      const approverChanged = approver !== undefined && approver !== doc.finalApproverId;
      if (doc.reviewState !== "draft" && drop.length === 0 && added === 0 && !approverChanged && !note) return;
      const next = await readReview(tx, doc.id);
      const id = await record(tx, {
        documentId: doc.id,
        viewer: input.viewer,
        kind: doc.reviewState === "draft" ? "submitted" : "reviewers_changed",
        from: doc.reviewState,
        to: computeReviewState(next.rule),
        versionNumber: rule.currentVersion,
        at: await actionTime(tx, lastEventAt),
        note,
        ...(approver !== undefined ? { extra: { finalApproverId: approver } } : {}),
      });
      eventIds.push(id);
    },
    eventIds,
  );
  await notifyDocumentChange(db, input.documentId, "review");
  // A resubmit that changed nothing recorded no event: no hook runs.
  if (eventIds.length) {
    await runReviewHooks(db, {
      documentId: input.documentId,
      eventIds,
      actorId: input.viewer.kind === "principal" ? input.viewer.principalId : null,
      ...(input.deferRouting ? { deferRouting: true } : {}),
    });
  }
  input.deferRouting?.eventIds.push(...eventIds);
  return getReviewView(db, input.documentId, input.viewer, cipher);
}

/**
 * One reviewer's verdict, inside the caller's transaction (reviewDocument, chooseOption). Returns false when it
 * changes nothing: the same verdict already counts now.
 */
async function applyVerdict(
  tx: Tx,
  input: { documentId: string; viewer: Viewer; verdict: Verdict; versionNumber: number; note: string | null },
): Promise<string | null> {
  // Live access decides inside the transaction: a grant or link revoked since the early check is seen here.
  await requireDocumentAccess(tx, input.documentId, input.viewer, "comment");
  const { doc: row, reviewers, rule, lastEventAt } = await readReview(tx, input.documentId);
  const { viewer, verdict, note } = input;
  if (viewer.kind === "agent") throw new Error("document_access_denied");
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
  if (counted && counted.verdict === verdict && reviewerCounts(counted, rule)) return null;
  // One clock for the verdict and its event (see the file header).
  const at = await actionTime(tx, lastEventAt);
  await tx.documentReviewer.update({
    where: { id: mine.id },
    data: { verdict, versionNumber: rule.currentVersion, note, verdictAt: at },
  });
  const next = await readReview(tx, row.id);
  return record(tx, {
    documentId: row.id,
    viewer,
    kind: verdict === "approved" ? "approved" : "changes_requested",
    from: row.reviewState,
    to: computeReviewState(next.rule),
    versionNumber: rule.currentVersion,
    at,
    note,
  });
}

/**
 * Rejects one document of a set inside the caller's transaction (rejectDocument, chooseOption): live access and the
 * reject rights (owner, or a named member reviewer or the final approver with comment access), its placement in
 * a set (`memberOf`, when given, must match: the chosen document's set) and its state are checked here.
 */
async function applyReject(
  tx: Tx,
  input: { documentId: string; viewer: Viewer & { kind: "principal" }; note: string | null; memberOf?: string },
): Promise<string> {
  const { viewer } = input;
  const principalId = viewer.principalId;
  const accessNow = await documentAccess(tx, input.documentId, viewer);
  if (accessNow === "none") throw new Error("document_not_found");
  const { doc, reviewers, rule, lastEventAt } = await readReview(tx, input.documentId);
  const named = reviewers.some((r) => r.principalId === principalId);
  const isApprover = doc.finalApproverId === principalId;
  const allowed = accessNow === "owner" || ((named || isApprover) && atLeast("document", accessNow, "comment"));
  if (!allowed) throw new Error("document_review_forbidden");
  if (!rejectablePlacement(doc) || (input.memberOf !== undefined && memberOf(doc) !== input.memberOf)) {
    throw new Error("document_reject_not_plan_document");
  }
  if (!REJECTABLE.has(doc.reviewState)) invalid();
  return record(tx, {
    documentId: doc.id,
    viewer,
    kind: "rejected",
    from: doc.reviewState,
    to: "rejected",
    versionNumber: rule.currentVersion,
    at: await actionTime(tx, lastEventAt),
    note: input.note,
    extra: { removedFromPlan: true },
  });
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
  const viewer = input.viewer;
  if (viewer.kind === "agent") return denyAgent(db, input.documentId, viewer);
  const doc = await requireDocumentAccess(db, input.documentId, viewer, "comment");
  const note = await storedNote(db, cipher, doc.agentId, input.note);
  const verdict: Verdict = input.verdict === "approve" ? "approved" : "changes_requested";
  const eventIds: string[] = [];
  const changed = await inReviewTx(
    db,
    async (tx) => {
      const id = await applyVerdict(tx, {
        documentId: input.documentId,
        viewer: input.viewer,
        verdict,
        versionNumber: input.versionNumber,
        note,
      });
      if (id === null) return false;
      eventIds.push(id);
      return true;
    },
    eventIds,
  );
  if (changed) {
    await notifyDocumentChange(db, input.documentId, "review");
    // Spec §7b: the verdict that approves a plan set's last document notifies or starts a build.
    await runReviewHooks(db, {
      documentId: input.documentId,
      eventIds,
      actorId: input.viewer.kind === "principal" ? input.viewer.principalId : null,
    });
  }
  return getReviewView(db, input.documentId, input.viewer, cipher);
}

export async function forceApprove(
  db: PrismaClient,
  cipher: Cipher,
  input: { documentId: string; viewer: Viewer; note: string },
): Promise<{ view: ReviewView; overridden: string[] }> {
  const viewer = input.viewer;
  if (viewer.kind === "agent") return denyAgent(db, input.documentId, viewer);
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
  const eventIds: string[] = [];
  const overridden = await inReviewTx(
    db,
    async (tx) => {
      // Force rights follow live access, the current owner and the current final approver, read in the transaction.
      const accessNow = await documentAccess(tx, input.documentId, viewer);
      if (accessNow === "none") throw new Error("document_not_found");
      const { doc, rule, lastEventAt } = await readReview(tx, input.documentId);
      const approverNow = doc.finalApproverId === principalId && atLeast("document", accessNow, "comment");
      if (accessNow !== "owner" && !approverNow) throw new Error("document_review_forbidden");
      if (!FORCEABLE.has(doc.reviewState)) invalid();
      const ids = overriddenReviewerIds(rule);
      const eventId = await record(tx, {
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
      eventIds.push(eventId);
      return ids;
    },
    eventIds,
  );
  await notifyDocumentChange(db, input.documentId, "review");
  await runReviewHooks(db, {
    documentId: input.documentId,
    eventIds,
    actorId: input.viewer.kind === "principal" ? input.viewer.principalId : null,
  });
  return { view: await getReviewView(db, input.documentId, input.viewer, cipher), overridden };
}

/**
 * Rejects a document of a set: a design option nobody chose, a part the plan no longer needs. The document
 * becomes `rejected` (locked like an approved one, comments still open) and leaves its set (`removedFromPlan`),
 * so it no longer counts toward the set's approval and is never given to a builder. A plan set's own plan.md
 * cannot be rejected. Who may: the owner, the final approver, or a named member reviewer; a note is required.
 * Reopen undoes it. Rejecting the last waiting document completes the plan's approval exactly as an approval
 * does (the plan review hook).
 */
export async function rejectDocument(
  db: PrismaClient,
  cipher: Cipher,
  input: { documentId: string; viewer: Viewer; note: string },
): Promise<ReviewView> {
  const viewer = input.viewer;
  // An agent never rejects (as it never approves): document_not_found without access, else access denied.
  if (viewer.kind === "agent") return denyAgent(db, input.documentId, viewer);
  if (viewer.kind !== "principal") throw new Error("document_review_forbidden");
  const principalId = viewer.principalId;
  const access = await documentAccess(db, input.documentId, viewer);
  if (access === "none") throw new Error("document_not_found");
  const docRow = await db.document.findUnique({ where: { id: input.documentId }, select: { agentId: true } });
  if (!docRow) throw new Error("document_not_found");
  if (input.note.trim() === "") invalid();
  const note = await storedNote(db, cipher, docRow.agentId, input.note);
  const eventIds: string[] = [];
  await inReviewTx(
    db,
    async (tx) => {
      eventIds.push(await applyReject(tx, { documentId: input.documentId, viewer, note }));
    },
    eventIds,
  );
  await notifyDocumentChange(db, input.documentId, "review");
  await runReviewHooks(db, { documentId: input.documentId, eventIds, actorId: principalId });
  return getReviewView(db, input.documentId, viewer, cipher);
}

/** The most documents one choice may reject. */
export const MAX_CHOOSE_REJECTS = 50;

/** The note a choice stores on each document it rejects. */
export const choiceNote = (chosenPath: string, note: string | null) =>
  note ? `Chose ${chosenPath}: ${note}` : `Chose ${chosenPath}`;

/**
 * Chooses one option of a set (a plan set, or a native writer's option set): the viewer's approval of
 * `documentId` (as Approve, so only a named reviewer, on `versionNumber`; skipped when it is already approved)
 * and a reject of each document in `reject` (as Reject: the same rights, the same set, never a plan's plan.md),
 * all in ONE transaction, so either every change lands or none does. Each rejected document gets the note
 * "Chose <option>" (its option label, a plan document's path; plus the viewer's note, when given). The plan
 * review hook runs once, after the commit, so a choice that decides the plan's last waiting documents completes
 * its approval the way the last single action would.
 */
export async function chooseOption(
  db: PrismaClient,
  cipher: Cipher,
  input: { documentId: string; viewer: Viewer; versionNumber: number; reject: string[]; note?: string },
): Promise<{ view: ReviewView; rejected: string[] }> {
  const viewer = input.viewer;
  // An agent never chooses (it would approve): denied as approve denies it.
  if (viewer.kind === "agent") return denyAgent(db, input.documentId, viewer);
  if (viewer.kind !== "principal") throw new Error("document_review_forbidden");
  const rejectIds = [...new Set(input.reject)];
  if (rejectIds.length === 0 || rejectIds.length > MAX_CHOOSE_REJECTS || rejectIds.includes(input.documentId)) {
    invalid();
  }
  await requireDocumentAccess(db, input.documentId, viewer, "comment");
  const rows = await db.document.findMany({
    where: { id: { in: [input.documentId, ...rejectIds] } },
    select: { id: true, agentId: true, planPath: true, option: true },
  });
  const chosenRow = rows.find((r) => r.id === input.documentId);
  if (!chosenRow) throw new Error("document_not_found");
  if (rows.length !== rejectIds.length + 1) throw new Error("document_not_found");
  const userNote = input.note === undefined || input.note.trim() === "" ? null : input.note.trim();
  const text = choiceNote(chosenRow.option ?? chosenRow.planPath ?? "", userNote);
  // Each rejected document's note is redacted against its own agent's secret values, before the transaction.
  const notes = new Map<string, string | null>();
  for (const r of rows) if (r.id !== input.documentId) notes.set(r.id, await storedNote(db, cipher, r.agentId, text));
  const eventIds: string[] = [];
  await inReviewTx(
    db,
    async (tx) => {
      const { doc: chosen } = await readReview(tx, input.documentId);
      const set = memberOf(chosen);
      if (!rejectablePlacement(chosen) || set === null) throw new Error("document_reject_not_plan_document");
      if (chosen.reviewState !== "approved") {
        const approved = await applyVerdict(tx, {
          documentId: chosen.id,
          viewer,
          verdict: "approved",
          versionNumber: input.versionNumber,
          note: null,
        });
        if (approved !== null) eventIds.push(approved);
      }
      for (const id of rejectIds) {
        eventIds.push(await applyReject(tx, { documentId: id, viewer, note: notes.get(id) ?? null, memberOf: set }));
      }
    },
    eventIds,
  );
  for (const id of [input.documentId, ...rejectIds]) await notifyDocumentChange(db, id, "review");
  await runReviewHooks(db, { documentId: input.documentId, eventIds, actorId: viewer.principalId });
  return { view: await getReviewView(db, input.documentId, viewer, cipher), rejected: rejectIds };
}

/**
 * Reopens an approved (or rejected) document for review by starting its next version: a copy of version N, written
 * as N+1 (via "review") in the same transaction as the state change and the `reopened` event, which names N+1.
 * N stays the approved record; nothing given on N counts on N+1, so every review after a reopen is on a new number.
 * The copy goes through the shared version writer but not publishVersion, whose lock check refuses every other
 * route while the document is approved. N's stored content is prepared again against the agent's current secret
 * values, as a restore is, so a value that became a secret after N was published is redacted from the copy (N
 * itself is never rewritten).
 */
export async function reopenDocument(
  db: PrismaClient,
  cipher: Cipher,
  input: { documentId: string; viewer: Viewer },
): Promise<ReviewView> {
  if (input.viewer.kind === "agent") return denyAgent(db, input.documentId, input.viewer);
  // Anyone who can open the document but not write it (a guest included) is refused as a review action, so
  // they are told to ask someone who can edit it to reopen it.
  const access = await documentAccess(db, input.documentId, input.viewer);
  if (access === "none") throw new Error("document_not_found");
  if (input.viewer.kind !== "principal" || !atLeast("document", access, "write")) {
    throw new Error("document_review_forbidden");
  }
  const principalId = input.viewer.principalId;
  const eventIds: string[] = [];
  for (let attempt = 1; ; attempt++) {
    // Staged before the transaction, as a publish is (re-anchoring a design parses it).
    const row = await db.document.findUnique({
      where: { id: input.documentId },
      select: {
        kind: true,
        agentId: true,
        reviewState: true,
        currentVersion: { select: { id: true, number: true, format: true, markdown: true } },
      },
    });
    if (!row?.currentVersion) throw new Error("document_not_found");
    // Early refusal (the transaction decides): nothing is staged for a document that is not approved or rejected.
    if (!REOPENABLE.has(row.reviewState)) invalid();
    const approved = row.currentVersion;
    const fmt = formatFor(row.kind);
    const secrets = await documentSecretValues(db, cipher, row.agentId);
    const prepared = fmt.prepare(await loadContent(db, approved), secrets);
    const staged = await stageVersion(db, input.documentId, fmt, prepared);
    try {
      await inReviewTx(db, async (tx) => {
        await requireDocumentAccess(tx, input.documentId, input.viewer, "write");
        const { doc, lastEventAt } = await readReview(tx, input.documentId);
        if (!REOPENABLE.has(doc.reviewState)) invalid();
        // A conflict means another reopen, publish and approval happened since the copy was staged.
        const written = await writeVersion(tx, doc.id, staged, {
          via: "review",
          createdById: principalId,
          summary: reopenedSummary(approved.number),
          expectedNumber: approved.number,
        });
        const eventId = await record(tx, {
          documentId: doc.id,
          viewer: input.viewer,
          kind: "reopened",
          from: doc.reviewState,
          to: "in_review",
          versionNumber: written.number,
          at: await actionTime(tx, lastEventAt),
          // A rejected document goes back into its plan (rejectDocument took it out).
          ...(doc.reviewState === "rejected" ? { extra: { removedFromPlan: false } } : {}),
        });
        eventIds.length = 0;
        eventIds.push(eventId);
      });
      break;
    } catch (err) {
      if (attempt < DOCUMENT_WRITE_ATTEMPTS && err instanceof Error && err.message === "document_version_conflict") {
        continue;
      }
      throw err;
    }
  }
  // As a publish does (open pages load the new version), and as a review action does.
  await notifyDocumentChange(db, input.documentId, "version");
  await notifyDocumentChange(db, input.documentId, "review");
  await runReviewHooks(db, {
    documentId: input.documentId,
    eventIds,
    actorId: input.viewer.kind === "principal" ? input.viewer.principalId : null,
  });
  return getReviewView(db, input.documentId, input.viewer, cipher);
}

/** The summary of the version a reopen starts. */
export const reopenedSummary = (number: number) => `Reopened for review from v${number}`;

export async function setArchived(
  db: PrismaClient,
  /** `cipher` only for the returned view's routed task lines (getReviewView). */
  input: { documentId: string; viewer: Viewer; archived: boolean; cipher?: Cipher },
): Promise<ReviewView> {
  if (input.viewer.kind === "agent") return denyAgent(db, input.documentId, input.viewer);
  await requireDocumentAccess(db, input.documentId, input.viewer, "owner");
  const eventIds: string[] = [];
  await inReviewTx(
    db,
    async (tx) => {
      await requireDocumentAccess(tx, input.documentId, input.viewer, "owner");
      const { doc, rule, lastEventAt } = await readReview(tx, input.documentId);
      if (input.archived === (doc.reviewState === "archived")) invalid();
      const back = doc.reviewStateBeforeArchive;
      const to: ReviewState = input.archived
        ? "archived"
        : back && isReviewState(back) && back !== "archived"
          ? back
          : "draft";
      const eventId = await record(tx, {
        documentId: doc.id,
        viewer: input.viewer,
        kind: input.archived ? "archived" : "unarchived",
        from: doc.reviewState,
        to,
        versionNumber: rule.currentVersion,
        at: await actionTime(tx, lastEventAt),
        extra: { reviewStateBeforeArchive: input.archived ? doc.reviewState : null },
      });
      eventIds.push(eventId);
    },
    eventIds,
  );
  await notifyDocumentChange(db, input.documentId, "review");
  await runReviewHooks(db, {
    documentId: input.documentId,
    eventIds,
    actorId: input.viewer.kind === "principal" ? input.viewer.principalId : null,
  });
  return getReviewView(db, input.documentId, input.viewer, input.cipher);
}

/** In publishVersion's transaction, before the version is written: refuses an approved or archived document. */
export async function assertNotLocked(tx: Tx, documentId: string): Promise<void> {
  const row = await tx.document.findUnique({ where: { id: documentId }, select: { reviewState: true } });
  if (!row) throw new Error("document_not_found");
  if (isLocked(row.reviewState)) throw new Error("document_locked");
}

/**
 * In publishVersion's transaction, after the new version is current: while in review, the state is
 * recomputed (older verdicts stop counting). A publish onto a document with changes requested answers them: it is
 * the review action "revised" (#646), recorded once per round of requested changes, and its event id is returned
 * for the caller's review hooks. Any other publish records no event.
 */
export async function recomputeAfterPublish(
  tx: Tx,
  documentId: string,
  author: { principalId?: string; runId?: string; agentId?: string | null } = {},
): Promise<string | null> {
  const { doc, rule, lastEventAt } = await readReview(tx, documentId);
  if (doc.reviewState !== "in_review" && doc.reviewState !== "changes_requested") return null;
  const to = computeReviewState(rule);
  if (doc.reviewState === "in_review") {
    if (to !== doc.reviewState) await tx.document.update({ where: { id: documentId }, data: { reviewState: to } });
    return null;
  }
  const viewer: Viewer | null = author.runId
    ? { kind: "agent", agentId: author.agentId ?? doc.agentId ?? "", runId: author.runId }
    : author.principalId
      ? { kind: "principal", principalId: author.principalId }
      : null;
  return record(tx, {
    documentId,
    viewer,
    kind: "revised",
    from: doc.reviewState,
    to,
    versionNumber: rule.currentVersion,
    at: await actionTime(tx, lastEventAt),
  });
}

/** The stored state, or null when the document does not exist. */
export async function documentReviewState(
  db: Pick<PrismaClient, "document">,
  documentId: string,
): Promise<ReviewState | null> {
  const row = await db.document.findUnique({ where: { id: documentId }, select: { reviewState: true } });
  return row && isReviewState(row.reviewState) ? row.reviewState : null;
}

/** The routing block: the router that applies now (as the hook resolves it) and the newest jobs with their children. */
async function routingView(
  db: PrismaClient,
  documentId: string,
  viewer: Viewer,
  owner: boolean,
  cipher: Cipher | undefined,
): Promise<ReviewRoutingView> {
  const setSelect = {
    select: { id: true, agentId: true, ownerId: true, routerAgentId: true, createdByRunId: true },
  } as const;
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: {
      agentId: true,
      ownerId: true,
      routerAgentId: true,
      versions: { where: { number: 1 }, select: { runId: true } },
      set: setSelect,
      planSet: { select: { set: setSelect } },
    },
  });
  if (!doc) return { router: null, jobs: [] };
  // A plan set's shared set carries its router; a native option set is its own home (as the hook reads it).
  const set = doc.planSet ? doc.planSet.set : doc.set;
  const routerId = await resolveRouter(
    db,
    set
      ? {
          routerAgentId: set.routerAgentId,
          writerAgentId: set.agentId,
          ownerId: set.ownerId,
          recordedByRunId: set.createdByRunId,
        }
      : {
          routerAgentId: doc.routerAgentId,
          writerAgentId: doc.agentId,
          ownerId: doc.ownerId,
          recordedByRunId: doc.versions[0]?.runId ?? null,
        },
  );
  const router = routerId
    ? await db.agent.findUnique({ where: { id: routerId }, select: { id: true, name: true } })
    : null;
  const jobs = await db.reviewJob.findMany({
    where: set ? { OR: [{ documentId }, { setId: set.id }] } : { documentId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_ROUTING_JOBS,
    select: { createdAt: true, reviewEventId: true, outcome: true, routerRunId: true, routerAgentId: true },
  });
  const runIds = [...new Set(jobs.flatMap((j) => (j.routerRunId ? [j.routerRunId] : [])))];
  // Each job's newest started agents, capped per job, so a busy older job never hides a newer one's.
  const childrenOf = new Map(
    await Promise.all(
      runIds.map(
        async (runId) =>
          [
            runId,
            await db.run.findMany({
              where: { parentRunId: runId },
              orderBy: [{ startedAt: "desc" }, { id: "desc" }],
              take: MAX_ROUTING_CHILDREN_PER_JOB,
              select: { id: true, agentId: true, taskOverride: true, agent: { select: { name: true } } },
            }),
          ] as const,
      ),
    ),
  );
  const routerIds = [...new Set(jobs.map((j) => j.routerAgentId))];
  const routers = new Map(
    (
      await db.agent.findMany({ where: { id: { in: routerIds } }, select: { id: true, name: true, ownerId: true } })
    ).map((a) => [a.id, a]),
  );
  // Task text: the document's owner, or a person who can execute that job's router.
  const principalId = viewer.kind === "principal" ? viewer.principalId : null;
  const seeTask = new Map<string, boolean>();
  for (const a of routers.values()) {
    seeTask.set(
      a.id,
      owner ||
        (principalId !== null && atLeast("agent", await effectiveAccess(db, "agent", a, principalId), "execute")),
    );
  }
  // Task text is model-written and stored raw: redacted by exact value against the router's and the started
  // agent's secret values. No cipher, or values that cannot be read, shows no task text (fail closed).
  const secretsOf = new Map<string, Promise<readonly string[] | null>>();
  const secrets = (agentId: string) => {
    let got = secretsOf.get(agentId);
    if (!got) {
      got = cipher ? documentSecretValues(db, cipher, agentId).catch(() => null) : Promise.resolve(null);
      secretsOf.set(agentId, got);
    }
    return got;
  };
  const taskLine = async (routerAgentId: string, child: { agentId: string; taskOverride: string | null }) => {
    if (!seeTask.get(routerAgentId) || !child.taskOverride) return null;
    const [a, b] = await Promise.all([secrets(routerAgentId), secrets(child.agentId)]);
    if (a === null || b === null) return null;
    const first = child.taskOverride.split("\n", 1)[0] ?? "";
    return (
      redactExactSecretValues(first, [...a, ...b])
        .trim()
        .slice(0, MAX_TASK_LINE_CHARS) || null
    );
  };
  return {
    router,
    jobs: await Promise.all(
      jobs.map(async (j) => ({
        at: j.createdAt,
        eventId: j.reviewEventId,
        outcome: j.outcome,
        routerName: routers.get(j.routerAgentId)?.name ?? "The router",
        started: await Promise.all(
          (j.routerRunId ? (childrenOf.get(j.routerRunId) ?? []) : []).map(async (c) => ({
            agentName: c.agent.name,
            task: await taskLine(j.routerAgentId, c),
          })),
        ),
      })),
    ),
  };
}

/**
 * `cipher` reads the secret values a routed agent's task line is redacted against; without it the routing block
 * shows no task text.
 */
export async function getReviewView(
  db: PrismaClient,
  documentId: string,
  viewer: Viewer,
  cipher?: Cipher,
): Promise<ReviewView> {
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
    viewer.kind === "principal"
      ? p !== null && p === viewer.principalId
      : viewer.kind === "guest" && g !== null && g === viewer.guestId;
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
            // A verdict that no longer counts (given on an older version) is reported as no review.
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
  const rejectablePlanDocument = rejectablePlacement(doc);
  const canReview =
    listed &&
    REVIEWABLE.has(state) &&
    !(state === "approved" && forceCounts(rule)) &&
    atLeast("document", access, "comment");
  const canReject =
    principalId !== null &&
    rejectablePlanDocument &&
    REJECTABLE.has(state) &&
    (owner ||
      (((listed && viewer.kind === "principal") || doc.finalApproverId === principalId) &&
        atLeast("document", access, "comment")));
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
      actorName: e.actorRunId ? "Agent" : nameOf(e.actorPrincipalId, e.actorGuestId),
      fromState: e.fromState as ReviewState,
      toState: e.toState as ReviewState,
      versionNumber: e.versionNumber,
      note: e.note,
      overridden: (e.overridden as string[] | null) ?? [],
      createdAt: e.createdAt,
    })),
    routing: await routingView(db, documentId, viewer, owner, cipher),
    can: {
      submit: (owner || (viewer.kind === "agent" && atLeast("document", access, "write"))) && SUBMITTABLE.has(state),
      review: canReview,
      force:
        FORCEABLE.has(state) &&
        (owner ||
          (principalId !== null && principalId === doc.finalApproverId && atLeast("document", access, "comment"))),
      reopen: principalId !== null && REOPENABLE.has(state) && atLeast("document", access, "write"),
      reject: canReject,
      choose: canReject && (state === "approved" || canReview),
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
