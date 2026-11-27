/**
 * Publishing a planner run's plan files as a reviewed plan set (docs/private spec §4). Runs in the
 * run-end path (plans/hooks.ts), never as a model step. Documents are owned by the planner agent's
 * owner and redacted with the agent's secret values by the document service; the stored files were
 * already redacted when they were recorded. Nothing here logs or returns file content: results
 * carry ids, paths, states and version numbers only.
 */
import { Prisma, type PrismaClient } from "#prisma";
import { readPlanDocument } from "../../coding/profile.js";
import { loadPlanFiles } from "../../coding/plan-files/store.js";
import { contentHash, type VersionContent } from "../documents/content.js";
import { loadContent } from "../documents/files.js";
import { formatFor } from "../documents/formats/index.js";
import { documentSecretValues } from "../documents/redact.js";
import { submitForReview } from "../documents/review.js";
import { createDocument, publishVersion } from "../documents/service.js";
import { atLeast, accessFor } from "../grants.js";
import { TERMINAL_RUN_STATUSES } from "../host-status.js";
import type { loadAgentSecretValues } from "../secret-guard.js";
import { planSetChanged } from "./approval.js";
import { parsePlanLayout, type PlanLayoutDocument } from "./layout.js";

export type SecretCipher = Parameters<typeof loadAgentSecretValues>[1];

/**
 * plan_publish_failed: the publish threw partway; plan_publish_busy: another publish held the set past the
 * wait bound, or took it over (CodingRun.planPublishStatus). Fixed codes, never an error's text.
 */
export type PlanPublishError =
  | "plan_too_large"
  | "plan_empty"
  | "plan_files_unsupported"
  | "plan_not_stored"
  | "plan_publish_failed"
  | "plan_publish_busy";
export type PlanDocumentChange =
  "created" | "updated" | "unchanged" | "removed" | "approved_unchanged" | "rejected_unchanged" | "archived_unchanged";

/** pagePath is always "/d/<id>"; url only when the server's public origin is known (R10c). */
export interface PublishedPlanDocument {
  id: string;
  pagePath: string;
  url?: string;
  kind: "document" | "design";
  path: string;
  reviewState: string;
  versionNumber: number;
  change: PlanDocumentChange;
}
export interface PublishedPlan {
  number: number;
  planSetId: string;
  documents: PublishedPlanDocument[];
  ignored: string[];
  withheld: string[];
  /** Reviewer ids left out because they no longer have read access to the planner (R10b). Ids only. */
  skippedReviewers: string[];
}
export interface PlanPublishFailure {
  number: number;
  error: PlanPublishError;
}
export interface PlanPending {
  number: number;
  documents: [];
  pending: true;
}
export type PlanSummary = PublishedPlan | PlanPublishFailure | PlanPending;
/** The clock the set's publish lease uses; a test seam (the default is the real one). */
export interface PlanPublishClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface PlanPublishDeps {
  cipher: SecretCipher;
  origin: string | null;
  clock?: PlanPublishClock;
  /**
   * A revision's own document (B8: the one its threads are on), published by the caller. It is never
   * marked removed here, and with `skip` (its edit was not applied) it gets no write at all.
   */
  threadsDocument?: { id: string; skip: boolean };
}

const TERMINAL = new Set<string>(TERMINAL_RUN_STATUSES);

/** CodingRun.planPublishStatus once a publish finished, or once one stopped (a fixed code, never error text). */
export const PLAN_PUBLISHED = "published";
export const PLAN_PUBLISH_FAILED = "plan_publish_failed";
export const PLAN_PUBLISH_BUSY = "plan_publish_busy";

/**
 * One publish per set at a time: a lease on the PlanSet row (publishLeaseRunId, publishLeaseUntil), taken
 * by one conditional update and renewed before every step. Nothing holds a connection while it waits or
 * works. A lease not renewed within PLAN_PUBLISH_LEASE_MS (a publisher that died or stalled) may be taken
 * over; the old publisher then sees it lost at its next step and stops. A waiter gives up after
 * PLAN_PUBLISH_WAIT_MS with plan_publish_busy.
 */
export const PLAN_PUBLISH_LEASE_MS = 60_000;
export const PLAN_PUBLISH_WAIT_MS = 120_000;
const PLAN_PUBLISH_BACKOFF_MS = [50, 100, 250, 500, 1_000, 2_000] as const;

const realClock: PlanPublishClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The set's lease was taken over by another publish: this one stops and writes no "published". */
class PlanLeaseLost extends Error {
  override name = "PlanLeaseLost";
}

/** Takes or renews the lease for runId: free, expired, or already this run's. */
async function takeLease(db: PrismaClient, clock: PlanPublishClock, setId: string, runId: string): Promise<boolean> {
  const now = clock.now();
  const { count } = await db.planSet.updateMany({
    where: {
      id: setId,
      OR: [{ publishLeaseRunId: null }, { publishLeaseUntil: { lt: new Date(now) } }, { publishLeaseRunId: runId }],
    },
    data: { publishLeaseRunId: runId, publishLeaseUntil: new Date(now + PLAN_PUBLISH_LEASE_MS) },
  });
  return count === 1;
}

/** Waits for the lease with backoff, holding no connection in between; false once the wait bound passes. */
async function acquireLease(db: PrismaClient, clock: PlanPublishClock, setId: string, runId: string) {
  const deadline = clock.now() + PLAN_PUBLISH_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    if (await takeLease(db, clock, setId, runId)) return true;
    if (clock.now() >= deadline) return false;
    await clock.sleep(PLAN_PUBLISH_BACKOFF_MS[Math.min(attempt, PLAN_PUBLISH_BACKOFF_MS.length - 1)]);
  }
}

/** Extends the lease only while it is still this run's; throws PlanLeaseLost otherwise. */
async function renewLease(db: PrismaClient, clock: PlanPublishClock, setId: string, runId: string): Promise<void> {
  const { count } = await db.planSet.updateMany({
    where: { id: setId, publishLeaseRunId: runId },
    data: { publishLeaseUntil: new Date(clock.now() + PLAN_PUBLISH_LEASE_MS) },
  });
  if (count !== 1) throw new PlanLeaseLost();
}

/** Frees the lease, only if it is still this run's. */
async function releaseLease(db: PrismaClient, setId: string, runId: string): Promise<void> {
  await db.planSet.updateMany({
    where: { id: setId, publishLeaseRunId: runId },
    data: { publishLeaseRunId: null, publishLeaseUntil: null },
  });
}

/**
 * Runs `work` while holding the set's publish lease for runId (one publish per set at a time), so a
 * revision's own publish (B8, agent-loop.ts) cannot interleave with a set publish. "busy": the lease
 * was not free within PLAN_PUBLISH_WAIT_MS; nothing ran. The lease is released after `work`.
 */
export async function withPlanSetLease<T>(
  db: PrismaClient,
  setId: string,
  runId: string,
  work: () => Promise<T>,
  clock: PlanPublishClock = realClock,
): Promise<T | "busy"> {
  if (!(await acquireLease(db, clock, setId, runId))) return "busy";
  try {
    return await work();
  } finally {
    await releaseLease(db, setId, runId).catch(() => undefined);
  }
}

async function markPublish(db: PrismaClient, runId: string, status: string | null): Promise<void> {
  await db.codingRun.update({ where: { runId }, data: { planPublishStatus: status } });
}

/** CodingRun.planFilesStatus (anything but "stored") as a publish error. */
function publishErrorOf(status: string | null): PlanPublishError {
  if (status === "plan_files_unsupported") return "plan_files_unsupported";
  if (status === "plan_too_large") return "plan_too_large";
  return "plan_not_stored";
}

/** The paths of CodingRun.planFilesWithheld ({ paths, unnamed }); never content. */
function withheldPaths(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("paths" in value) || !Array.isArray(value.paths)) return [];
  return value.paths.filter((p): p is string => typeof p === "string");
}

/** The planner run and its setting, or null when the run is not a planner run. */
async function readPlannerRun(db: PrismaClient, runId: string) {
  const coding = await db.codingRun.findUnique({
    where: { runId },
    include: {
      run: {
        select: {
          status: true,
          agentId: true,
          parentRunId: true,
          agent: { select: { ownerId: true, codingProfile: { select: { planDocument: true } } } },
        },
      },
    },
  });
  if (!coding || coding.planNumber === null || !coding.run.agent.ownerId) return null;
  let setting: ReturnType<typeof readPlanDocument>;
  try {
    setting = readPlanDocument(coding.run.agent.codingProfile?.planDocument, coding.run.agent.ownerId);
  } catch {
    // A malformed stored setting reads as no plan setting, as dispatch reads it.
    return null;
  }
  if (!setting) return null;
  return { coding, setting, number: coding.planNumber, ownerId: coding.run.agent.ownerId };
}

/** The agent of the top run of the tree a run belongs to, or undefined without a parent. */
async function topRunAgent(db: PrismaClient, parentRunId: string | null): Promise<string | undefined> {
  let agentId: string | undefined;
  let next = parentRunId;
  const seen = new Set<string>();
  while (next && !seen.has(next)) {
    seen.add(next);
    const run = await db.run.findUnique({ where: { id: next }, select: { agentId: true, parentRunId: true } });
    if (!run) break;
    agentId = run.agentId;
    next = run.parentRunId;
  }
  return agentId;
}

/** Reviewers that still have at least read on the planner (spec §1: checked again when a plan is made). */
export async function reviewersWithAccess(
  db: PrismaClient,
  agent: { id: string; ownerId: string },
  ids: readonly string[],
): Promise<{ reviewers: string[]; skippedReviewers: string[] }> {
  const reviewers: string[] = [];
  const skippedReviewers: string[] = [];
  for (const id of new Set(ids)) {
    const access = await accessFor(db, "agent", agent, id);
    (atLeast("agent", access, "read") ? reviewers : skippedReviewers).push(id);
  }
  return { reviewers, skippedReviewers };
}

/** Whether a final approver still exists and has at least read on the agent (the set's access agent). */
async function approverHasAccess(db: PrismaClient, agentId: string, principalId: string): Promise<boolean> {
  const [principal, agent] = await Promise.all([
    db.principal.findUnique({ where: { id: principalId }, select: { id: true } }),
    db.agent.findUnique({ where: { id: agentId }, select: { id: true, ownerId: true } }),
  ]);
  if (!principal || !agent) return false;
  return atLeast("agent", await accessFor(db, "agent", agent, principalId), "read");
}

/**
 * Who a plan document is submitted to: reviewers with read on the planner (R10b), and the final approver
 * when it still exists and has read on the set's access agent. Anyone left out is in skippedReviewers
 * (ids only); a dropped final approver never fails the publish.
 */
async function planReviewers(
  db: PrismaClient,
  planner: { id: string; ownerId: string },
  accessAgentId: string,
  setting: { reviewers: readonly string[]; finalApproverId?: string },
): Promise<{ reviewers: string[]; skippedReviewers: string[]; finalApproverId?: string }> {
  const checked = await reviewersWithAccess(db, planner, setting.reviewers);
  const approver = setting.finalApproverId;
  if (!approver) return checked;
  if (await approverHasAccess(db, accessAgentId, approver)) return { ...checked, finalApproverId: approver };
  return {
    ...checked,
    skippedReviewers: checked.skippedReviewers.includes(approver)
      ? checked.skippedReviewers
      : [...checked.skippedReviewers, approver],
  };
}

function documentLink(origin: string | null, id: string): { pagePath: string; url?: string } {
  const pagePath = `/d/${id}`;
  return origin === null ? { pagePath } : { pagePath, url: `${origin}${pagePath}` };
}

async function describePlanDocument(
  db: PrismaClient,
  origin: string | null,
  id: string,
  doc: { kind: "document" | "design"; path: string },
  change: PlanDocumentChange,
): Promise<PublishedPlanDocument> {
  const row = await db.document.findUniqueOrThrow({
    where: { id },
    select: { reviewState: true, currentVersion: { select: { number: true } } },
  });
  return {
    id,
    ...documentLink(origin, id),
    kind: doc.kind,
    path: doc.path,
    reviewState: row.reviewState,
    versionNumber: row.currentVersion?.number ?? 0,
    change,
  };
}

/** The repository file (or design folder, ending in "/") a document of a repository-stored plan is linked to. */
function joinPlanPath(folder: string, path: string): string {
  return `${folder}${path}`;
}

function contentOf(doc: PlanLayoutDocument): VersionContent {
  return doc.kind === "document"
    ? { format: "markdown", markdown: doc.markdown! }
    : { format: "boards-v1", files: doc.files! };
}

/**
 * Whether the file, prepared as a publish would prepare it, is the document's current content.
 * Preparing is not idempotent on a stored design (a second pass can add a line break), so the stored
 * content is also compared prepared once more: a file handed back untouched (already prepared once
 * when it was stored) matches it, as does a raw file that matches the stored one.
 */
async function sameContent(
  db: PrismaClient,
  kind: "document" | "design",
  current: { id: string; contentHash: string; format: string; markdown: string | null } | null,
  content: VersionContent,
  secrets: string[],
): Promise<boolean> {
  if (!current) return false;
  const fmt = formatFor(kind);
  const ours = contentHash(fmt.prepare(content, secrets).content);
  if (ours === current.contentHash) return true;
  try {
    return ours === contentHash(fmt.prepare(await loadContent(db, current), secrets).content);
  } catch {
    return false;
  }
}

/** The change a document this publish does not write is reported with (R21: archived never reads as approved). */
function keptChange(reviewState: string): PlanDocumentChange {
  return reviewState === "approved"
    ? "approved_unchanged"
    : reviewState === "rejected"
      ? "rejected_unchanged"
      : reviewState === "archived"
        ? "archived_unchanged"
        : "unchanged";
}

const asKind = (kind: string): "document" | "design" => (kind === "design" ? "design" : "document");

type PlannerRun = NonNullable<Awaited<ReturnType<typeof readPlannerRun>>>;
type PlanSetRef = { id: string; accessAgentId: string | null };

/** The run's plan set, made on the first run; a concurrent first publish's set is used when it won the insert. */
async function findOrCreateSet(db: PrismaClient, runId: string, planner: PlannerRun): Promise<PlanSetRef> {
  const { coding, number } = planner;
  const agentId = coding.run.agentId;
  const where = { agentId_repository_number: { agentId, repository: coding.repository, number } };
  const select = { id: true, accessAgentId: true } as const;
  const existing = await db.planSet.findUnique({ where, select });
  if (existing) return existing;
  const accessAgentId = (await topRunAgent(db, coding.run.parentRunId)) ?? agentId;
  try {
    return await db.planSet.create({
      data: {
        agentId,
        repository: coding.repository,
        number,
        // The store this run wrote to (B4 sets planRepositoryPath only for store "repository").
        store: coding.planRepositoryPath ? "repository" : "wardby",
        accessAgentId,
        createdByRunId: runId,
        issueProvider: coding.issueProvider,
        issueKey: coding.issueKey,
      },
      select,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return db.planSet.findUniqueOrThrow({ where, select });
    }
    throw err;
  }
}

/**
 * Publishes a succeeded planner run's stored plan files as its plan set: creates the set and its
 * documents on the first run, the next version of each changed document on a later one. null: the
 * run is not a planner run (or did not succeed). One publish per set at a time (a lease on the set):
 * a publish that cannot get it within PLAN_PUBLISH_WAIT_MS, or loses it to a takeover, stops with
 * plan_publish_busy and writes no "published". When a step throws, the other documents are still
 * published, CodingRun.planPublishStatus records plan_publish_failed, and the first error is thrown;
 * a retry of the same run finishes the set.
 */
export async function publishPlanFromRun(
  db: PrismaClient,
  deps: PlanPublishDeps,
  runId: string,
): Promise<PublishedPlan | PlanPublishFailure | null> {
  const planner = await readPlannerRun(db, runId);
  if (!planner || planner.coding.run.status !== "succeeded") return null;
  const { coding, number } = planner;
  if (coding.planFilesStatus !== "stored") return { number, error: publishErrorOf(coding.planFilesStatus) };
  const layout = parsePlanLayout(await loadPlanFiles(db, runId, "output"));
  if (!layout.ok) return { number, error: layout.error };
  const given = await givenDocuments(db, runId);
  const clock = deps.clock ?? realClock;
  let set: PlanSetRef | undefined;
  let held = false;
  try {
    set = await findOrCreateSet(db, runId, planner);
    if (!(await acquireLease(db, clock, set.id, runId))) {
      await markPublish(db, runId, PLAN_PUBLISH_BUSY);
      return { number, error: "plan_publish_busy" };
    }
    held = true;
    return await publishSet(db, deps, clock, runId, planner, set, layout.documents, layout.ignored, given);
  } catch (err) {
    if (err instanceof PlanLeaseLost && set) {
      held = false;
      // The new holder owns the set. This run's marker says busy, unless the holder is this same run
      // (another publish of it), which writes the marker itself.
      const holder = await db.planSet
        .findUnique({ where: { id: set.id }, select: { publishLeaseRunId: true } })
        .catch(() => null);
      if (holder?.publishLeaseRunId !== runId) await markPublish(db, runId, PLAN_PUBLISH_BUSY).catch(() => undefined);
      return { number, error: "plan_publish_busy" };
    }
    // Best effort: the marker must not hide the publish's own error.
    await markPublish(db, runId, PLAN_PUBLISH_FAILED).catch(() => undefined);
    throw err;
  } finally {
    if (held && set) {
      await releaseLease(db, set.id, runId).catch(() => undefined);
      // Spec §7b: a removal that leaves only approved documents approves the set; a new waiting
      // document ends its approval. After the lease, since a build start may take a while. Never throws.
      await planSetChanged(db, set.id);
    }
  }
}

/** A revision run whose input files no longer pass the layout: what it was given is unknown. */
const GIVEN_UNREADABLE = "unreadable";

/**
 * A revision run's input (B8: the set's documents it was given in the plan folder) by path; null for a
 * run that was given none (a planner run writing the plan); GIVEN_UNREADABLE when its input files do
 * not pass the layout, so every existing document is treated as moved on (never written or removed).
 */
async function givenDocuments(
  db: PrismaClient,
  runId: string,
): Promise<Map<string, PlanLayoutDocument> | typeof GIVEN_UNREADABLE | null> {
  const inputs = await loadPlanFiles(db, runId, "input");
  if (inputs.length === 0) return null;
  const layout = parsePlanLayout(inputs);
  return layout.ok ? new Map(layout.documents.map((d) => [d.path, d] as const)) : GIVEN_UNREADABLE;
}

async function publishSet(
  db: PrismaClient,
  deps: PlanPublishDeps,
  clock: PlanPublishClock,
  runId: string,
  planner: PlannerRun,
  set: PlanSetRef,
  layoutDocuments: readonly PlanLayoutDocument[],
  ignored: string[],
  given: Map<string, PlanLayoutDocument> | typeof GIVEN_UNREADABLE | null,
): Promise<PublishedPlan> {
  const { coding, setting, number, ownerId } = planner;
  // Renewed before every step and before the marker: a lost lease stops the publish (PlanLeaseLost).
  const hold = () => renewLease(db, clock, set.id, runId);
  await markPublish(db, runId, null);
  const agentId = coding.run.agentId;
  // The store this run wrote to (B4 sets planRepositoryPath only for store "repository").
  const repositoryPath = coding.planRepositoryPath;
  // Read under the lease, so an earlier publish's documents are seen.
  const documents = await db.document.findMany({
    where: { planSetId: set.id },
    orderBy: { planPath: "asc" },
    include: {
      currentVersion: { select: { id: true, number: true, contentHash: true, format: true, markdown: true } },
    },
  });
  const review = await planReviewers(db, { id: agentId, ownerId }, set.accessAgentId ?? agentId, setting);
  const submit = (documentId: string) =>
    submitForReview(db, {
      documentId,
      viewer: { kind: "principal", principalId: ownerId },
      reviewers: review.reviewers.length ? review.reviewers : [ownerId],
      ...(review.finalApproverId ? { finalApproverId: review.finalApproverId } : {}),
    });
  // Store repository: a document that gets a version from this run links to this run's plan folder and branch.
  const linkToRun = async (documentId: string, path: string) => {
    if (!repositoryPath) return;
    await db.document.update({
      where: { id: documentId },
      data: { repository: coding.repository, path: joinPlanPath(repositoryPath, path), baseRef: coding.headRef },
    });
  };
  const secrets = await documentSecretValues(db, deps.cipher, agentId);
  const byPath = new Map(documents.flatMap((d) => (d.planPath ? [[d.planPath, d] as const] : [])));
  const results: PublishedPlanDocument[] = [];
  let failure: Error | undefined;
  const asError = (err: unknown) => (err instanceof Error ? err : new Error(PLAN_PUBLISH_FAILED));
  const report = async (id: string, doc: { kind: "document" | "design"; path: string }, change: PlanDocumentChange) =>
    results.push(await describePlanDocument(db, deps.origin, id, doc, change));

  const publishOne = async (doc: PlanLayoutDocument): Promise<void> => {
    const existing = byPath.get(doc.path);
    byPath.delete(doc.path);
    const content = contentOf(doc);
    if (!existing) {
      const created = await createDocument(db, deps.cipher, {
        kind: doc.kind,
        ownerId,
        title: doc.title,
        ...(content.format === "markdown" ? { markdown: content.markdown } : { files: content.files }),
        agentId,
        via: "agent",
        ...(repositoryPath
          ? { repository: coding.repository, path: joinPlanPath(repositoryPath, doc.path), baseRef: coding.headRef }
          : {}),
      });
      await db.$transaction([
        db.document.update({ where: { id: created.id }, data: { planSetId: set.id, planPath: doc.path } }),
        // Version 1 records the run that wrote it, like every later version (R11, planSummaryForRun).
        db.documentVersion.update({ where: { id: created.versionId }, data: { runId } }),
      ]);
      await submit(created.id);
      await report(created.id, doc, "created");
      return;
    }
    // R11: one writer per version. A version this run already wrote (B8's revision publish, or an
    // earlier attempt of this publish) is left alone; a document still in draft is submitted now.
    const own = await db.documentVersion.findFirst({
      where: { documentId: existing.id, runId },
      select: { number: true },
    });
    // A revision whose input is unreadable treats every document as moved on; the threads' document
    // whose edit was not applied is the caller's (B8) and gets no write here.
    const kept = given === GIVEN_UNREADABLE || (deps.threadsDocument?.skip && existing.id === deps.threadsDocument.id);
    if (kept && !own) {
      await report(existing.id, doc, keptChange(existing.reviewState));
      return;
    }
    // A rejected document stays out of the plan, whatever the run wrote: a person reopens it to bring it back.
    if (existing.reviewState === "rejected") {
      await report(existing.id, doc, "rejected_unchanged");
      return;
    }
    // An archived document that had left the plan (rejected, or removed by an earlier run, then archived) stays out:
    // bringing it back would put an archived document in the plan, which then never counts as approved.
    if (existing.removedFromPlan && existing.reviewState === "archived") {
      await report(existing.id, doc, "archived_unchanged");
      return;
    }
    if (existing.removedFromPlan) {
      await db.document.update({ where: { id: existing.id }, data: { removedFromPlan: false } });
    }
    if (own) {
      if (existing.reviewState === "draft") await submit(existing.id);
      await linkToRun(existing.id, doc.path);
      await report(existing.id, doc, own.number === 1 ? "created" : "updated");
      return;
    }
    // R21: an archived document is never reported as approved.
    if (existing.reviewState === "approved") {
      await report(existing.id, doc, "approved_unchanged");
      return;
    }
    if (existing.reviewState === "archived") {
      await report(existing.id, doc, "archived_unchanged");
      return;
    }
    if (await sameContent(db, doc.kind, existing.currentVersion, content, secrets)) {
      await report(existing.id, doc, "unchanged");
      return;
    }
    // A revision (spec §5): only a file the run changed becomes a version, and only onto the version it
    // was given; a document a person moved on meanwhile is never overwritten (reported as not updated).
    // Every side is prepared with the same secret values, so a value that became a secret since the
    // version was published (redacted in what the run was given) does not read as a change.
    const sent = given instanceof Map ? given.get(doc.path) : undefined;
    if (sent && existing.currentVersion) {
      const prepared = (c: VersionContent): string => {
        try {
          return contentHash(formatFor(doc.kind).prepare(c, secrets).content);
        } catch {
          return contentHash(c);
        }
      };
      const sentHash = prepared(contentOf(sent));
      const movedOn = prepared(await loadContent(db, existing.currentVersion)) !== sentHash;
      if (movedOn || prepared(content) === sentHash) {
        await report(existing.id, doc, "unchanged");
        return;
      }
    }
    try {
      await publishVersion(db, deps.cipher, {
        documentId: existing.id,
        ...(content.format === "markdown" ? { markdown: content.markdown } : { files: content.files }),
        via: "agent",
        runId,
        summary: `Plan ${number}: updated by run ${runId}`,
        expectedNumber: existing.currentVersion?.number ?? 0,
      });
    } catch (err) {
      // A newer version (a person's edit) is never overwritten: reported as not updated.
      if (err instanceof Error && err.message === "document_version_conflict") {
        await report(existing.id, doc, "unchanged");
        return;
      }
      // Approved, rejected or archived since it was read.
      if (err instanceof Error && err.message === "document_locked") {
        const now = await db.document.findUnique({ where: { id: existing.id }, select: { reviewState: true } });
        await report(existing.id, doc, keptChange(now?.reviewState ?? "approved"));
        return;
      }
      throw err;
    }
    await linkToRun(existing.id, doc.path);
    await report(existing.id, doc, "updated");
  };

  // A step that throws does not abandon the rest of the set: the first error is thrown at the end.
  for (const doc of layoutDocuments) {
    await hold();
    try {
      await publishOne(doc);
    } catch (err) {
      failure ??= asError(err);
    }
  }
  for (const gone of byPath.values()) {
    // A revision removes only a document it was given; one added after it started is not its to remove,
    // and with an unreadable input it removes none.
    if (given !== null && (given === GIVEN_UNREADABLE || !given.has(gone.planPath!))) continue;
    await hold();
    try {
      // Never removed: an approved, rejected or archived document (read-only), or a revision's threads' document.
      if (
        gone.reviewState === "approved" ||
        gone.reviewState === "rejected" ||
        gone.reviewState === "archived" ||
        gone.id === deps.threadsDocument?.id
      ) {
        await report(gone.id, { kind: asKind(gone.kind), path: gone.planPath! }, keptChange(gone.reviewState));
        continue;
      }
      if (!gone.removedFromPlan) {
        await db.document.update({ where: { id: gone.id }, data: { removedFromPlan: true } });
      }
      await report(gone.id, { kind: asKind(gone.kind), path: gone.planPath! }, "removed");
    } catch (err) {
      failure ??= asError(err);
    }
  }
  if (failure) throw failure;
  await hold();
  await markPublish(db, runId, PLAN_PUBLISHED);
  return {
    number,
    planSetId: set.id,
    documents: results,
    ignored,
    withheld: withheldPaths(coding.planFilesWithheld),
    skippedReviewers: review.skippedReviewers,
  };
}

/**
 * Read-only, for replies (R10a): null = not a planner run (or one that did not succeed);
 * PlanPending = files not recorded or set not published yet.
 */
export async function planSummaryForRun(
  db: PrismaClient,
  runId: string,
  origin: string | null,
): Promise<PlanSummary | null> {
  const planner = await readPlannerRun(db, runId);
  if (!planner) return null;
  const { coding, setting, number, ownerId } = planner;
  const pending: PlanPending = { number, documents: [], pending: true };
  if (!TERMINAL.has(coding.run.status)) return pending;
  if (coding.run.status !== "succeeded") return null;
  if (coding.planFilesStatus === null) return pending;
  if (coding.planFilesStatus !== "stored") return { number, error: publishErrorOf(coding.planFilesStatus) };
  const layout = parsePlanLayout(await loadPlanFiles(db, runId, "output"));
  if (!layout.ok) return { number, error: layout.error };
  // This run's publish has not finished (or not started): pending, never an earlier run's states.
  if (coding.planPublishStatus === null) return pending;
  if (coding.planPublishStatus === PLAN_PUBLISH_BUSY) return { number, error: "plan_publish_busy" };
  if (coding.planPublishStatus !== PLAN_PUBLISHED) return { number, error: "plan_publish_failed" };
  const agentId = coding.run.agentId;
  const set = await db.planSet.findUnique({
    where: { agentId_repository_number: { agentId, repository: coding.repository, number } },
    include: { documents: { orderBy: { planPath: "asc" }, include: { currentVersion: { select: { number: true } } } } },
  });
  if (!set) return pending;
  const byPath = new Map(set.documents.flatMap((d) => (d.planPath ? [[d.planPath, d] as const] : [])));
  const own = await db.documentVersion.findMany({
    where: { documentId: { in: set.documents.map((d) => d.id) }, runId },
    select: { documentId: true, number: true },
  });
  const ownNumber = new Map(own.map((v) => [v.documentId, v.number]));
  const describeRow = (
    row: (typeof set.documents)[number],
    doc: { kind: "document" | "design"; path: string },
    change: PlanDocumentChange,
  ): PublishedPlanDocument => ({
    id: row.id,
    ...documentLink(origin, row.id),
    kind: doc.kind,
    path: doc.path,
    reviewState: row.reviewState,
    versionNumber: row.currentVersion?.number ?? 0,
    change,
  });
  const documents: PublishedPlanDocument[] = [];
  for (const doc of layout.documents) {
    const row = byPath.get(doc.path);
    // Deleted since the publish finished.
    if (!row) continue;
    byPath.delete(doc.path);
    const mine = ownNumber.get(row.id);
    const change: PlanDocumentChange =
      mine !== undefined
        ? mine === 1
          ? "created"
          : "updated"
        : row.reviewState === "rejected"
          ? "rejected_unchanged"
          : row.removedFromPlan
            ? "removed"
            : keptChange(row.reviewState);
    documents.push(describeRow(row, doc, change));
  }
  // Not in this run's files: removed, unless the publish kept it (approved, rejected or archived, never removed).
  for (const row of byPath.values()) {
    const change =
      row.reviewState === "rejected"
        ? "rejected_unchanged"
        : row.removedFromPlan
          ? "removed"
          : keptChange(row.reviewState);
    documents.push(describeRow(row, { kind: asKind(row.kind), path: row.planPath! }, change));
  }
  const { skippedReviewers } = await planReviewers(db, { id: agentId, ownerId }, set.accessAgentId ?? agentId, setting);
  return {
    number,
    planSetId: set.id,
    documents,
    ignored: layout.ignored,
    withheld: withheldPaths(coding.planFilesWithheld),
    skippedReviewers,
  };
}
