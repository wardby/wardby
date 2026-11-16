/**
 * Publishing a planner run's plan files as a reviewed plan set (docs/private spec §4). Runs in the
 * run-end path (plans/hooks.ts), never as a model step. Documents are owned by the planner agent's
 * owner and redacted with the agent's secret values by the document service; the stored files were
 * already redacted when they were recorded. Nothing here logs or returns file content: results
 * carry ids, paths, states and version numbers only.
 */
import type { PrismaClient } from "#prisma";
import { readPlanDocument } from "../../coding/profile.js";
import { loadPlanFiles } from "../../coding/plan-files/store.js";
import { contentHash, type VersionContent } from "../documents/content.js";
import { formatFor } from "../documents/formats/index.js";
import { documentSecretValues } from "../documents/redact.js";
import { submitForReview } from "../documents/review.js";
import { createDocument, publishVersion } from "../documents/service.js";
import { atLeast, effectiveAccess } from "../grants.js";
import type { loadAgentSecretValues } from "../secret-guard.js";
import { parsePlanLayout, type PlanLayoutDocument } from "./layout.js";

export type SecretCipher = Parameters<typeof loadAgentSecretValues>[1];

export type PlanPublishError = "plan_too_large" | "plan_empty" | "plan_files_unsupported" | "plan_not_stored";
export type PlanDocumentChange =
  "created" | "updated" | "unchanged" | "removed" | "approved_unchanged" | "archived_unchanged";

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
export interface PlanPublishDeps {
  cipher: SecretCipher;
  origin: string | null;
}

const TERMINAL = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);

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
    const access = await effectiveAccess(db, "agent", agent, id);
    (atLeast("agent", access, "read") ? reviewers : skippedReviewers).push(id);
  }
  return { reviewers, skippedReviewers };
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

/** Whether the file, prepared as a publish would prepare it, is the document's current content. */
function sameContent(
  kind: "document" | "design",
  current: { contentHash: string } | null,
  content: VersionContent,
  secrets: string[],
): boolean {
  if (!current) return false;
  return contentHash(formatFor(kind).prepare(content, secrets).content) === current.contentHash;
}

const asKind = (kind: string): "document" | "design" => (kind === "design" ? "design" : "document");

/**
 * Publishes a succeeded planner run's stored plan files as its plan set: creates the set and its
 * documents on the first run, the next version of each changed document on a later one. null: the
 * run is not a planner run (or did not succeed).
 */
export async function publishPlanFromRun(
  db: PrismaClient,
  deps: PlanPublishDeps,
  runId: string,
): Promise<PublishedPlan | PlanPublishFailure | null> {
  const planner = await readPlannerRun(db, runId);
  if (!planner || planner.coding.run.status !== "succeeded") return null;
  const { coding, setting, number, ownerId } = planner;
  if (coding.planFilesStatus !== "stored") return { number, error: publishErrorOf(coding.planFilesStatus) };
  const layout = parsePlanLayout(await loadPlanFiles(db, runId, "output"));
  if (!layout.ok) return { number, error: layout.error };
  const agentId = coding.run.agentId;
  // The store this run wrote to (B4 sets planRepositoryPath only for store "repository").
  const repositoryPath = coding.planRepositoryPath;
  const accessAgentId = (await topRunAgent(db, coding.run.parentRunId)) ?? agentId;
  const set = await db.planSet.upsert({
    where: { agentId_repository_number: { agentId, repository: coding.repository, number } },
    create: {
      agentId,
      repository: coding.repository,
      number,
      store: repositoryPath ? "repository" : "wardby",
      accessAgentId,
      createdByRunId: runId,
      issueProvider: coding.issueProvider,
      issueKey: coding.issueKey,
    },
    update: {},
    include: {
      documents: {
        orderBy: { planPath: "asc" },
        include: { currentVersion: { select: { number: true, contentHash: true } } },
      },
    },
  });
  const checked = await reviewersWithAccess(db, { id: agentId, ownerId }, setting.reviewers);
  const reviewers = checked.reviewers.length ? checked.reviewers : [ownerId];
  const secrets = await documentSecretValues(db, deps.cipher, agentId);
  const byPath = new Map(set.documents.flatMap((d) => (d.planPath ? [[d.planPath, d] as const] : [])));
  const results: PublishedPlanDocument[] = [];
  const report = async (id: string, doc: { kind: "document" | "design"; path: string }, change: PlanDocumentChange) =>
    results.push(await describePlanDocument(db, deps.origin, id, doc, change));

  for (const doc of layout.documents) {
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
      await submitForReview(db, {
        documentId: created.id,
        viewer: { kind: "principal", principalId: ownerId },
        reviewers,
        ...(setting.finalApproverId ? { finalApproverId: setting.finalApproverId } : {}),
      });
      await report(created.id, doc, "created");
      continue;
    }
    if (existing.removedFromPlan) {
      await db.document.update({ where: { id: existing.id }, data: { removedFromPlan: false } });
    }
    // R11: one writer per version. A version this run already wrote (B8's revision publish) is left alone.
    const own = await db.documentVersion.findFirst({
      where: { documentId: existing.id, runId },
      select: { number: true },
    });
    if (own) {
      await report(existing.id, doc, own.number === 1 ? "created" : "updated");
      continue;
    }
    // R21: an archived document is never reported as approved.
    if (existing.reviewState === "approved") {
      await report(existing.id, doc, "approved_unchanged");
      continue;
    }
    if (existing.reviewState === "archived") {
      await report(existing.id, doc, "archived_unchanged");
      continue;
    }
    if (sameContent(doc.kind, existing.currentVersion, content, secrets)) {
      await report(existing.id, doc, "unchanged");
      continue;
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
        continue;
      }
      // Approved or archived since it was read.
      if (err instanceof Error && err.message === "document_locked") {
        const now = await db.document.findUnique({ where: { id: existing.id }, select: { reviewState: true } });
        await report(existing.id, doc, now?.reviewState === "archived" ? "archived_unchanged" : "approved_unchanged");
        continue;
      }
      throw err;
    }
    await report(existing.id, doc, "updated");
  }
  for (const gone of byPath.values()) {
    if (!gone.removedFromPlan) {
      await db.document.update({ where: { id: gone.id }, data: { removedFromPlan: true } });
    }
    await report(gone.id, { kind: asKind(gone.kind), path: gone.planPath! }, "removed");
  }
  return {
    number,
    planSetId: set.id,
    documents: results,
    ignored: layout.ignored,
    withheld: withheldPaths(coding.planFilesWithheld),
    skippedReviewers: checked.skippedReviewers,
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
  const agentId = coding.run.agentId;
  const set = await db.planSet.findUnique({
    where: { agentId_repository_number: { agentId, repository: coding.repository, number } },
    include: { documents: { orderBy: { planPath: "asc" }, include: { currentVersion: { select: { number: true } } } } },
  });
  if (!set) return pending;
  const byPath = new Map(set.documents.flatMap((d) => (d.planPath ? [[d.planPath, d] as const] : [])));
  // The set exists but this run's documents are not all in it yet: the publish is still writing.
  if (layout.documents.some((doc) => !byPath.has(doc.path))) return pending;
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
    const row = byPath.get(doc.path)!;
    byPath.delete(doc.path);
    const mine = ownNumber.get(row.id);
    const change: PlanDocumentChange =
      mine !== undefined
        ? mine === 1
          ? "created"
          : "updated"
        : row.removedFromPlan
          ? "removed"
          : row.reviewState === "approved"
            ? "approved_unchanged"
            : row.reviewState === "archived"
              ? "archived_unchanged"
              : "unchanged";
    documents.push(describeRow(row, doc, change));
  }
  for (const row of byPath.values()) {
    documents.push(describeRow(row, { kind: asKind(row.kind), path: row.planPath! }, "removed"));
  }
  const { skippedReviewers } = await reviewersWithAccess(db, { id: agentId, ownerId }, setting.reviewers);
  return {
    number,
    planSetId: set.id,
    documents,
    ignored: layout.ignored,
    withheld: withheldPaths(coding.planFilesWithheld),
    skippedReviewers,
  };
}
