/**
 * A routed coding run's documents (#646, spec §4): the documents granted to the job's router run, as their current
 * versions, given to a coding child as plan files the way a builder gets an approved plan (versionPlanFiles:
 * Markdown at its path, a design's files under it). Every file and path is redacted by exact value against the
 * child's own secret values at send time, as buildFromPlan redacts against the builder's; without them nothing is
 * built (null), so no unchecked text reaches the run record.
 */
import type { PrismaClient } from "#prisma";
import { isSafePlanPath } from "../../coding/protocol.js";
import type { PlanFile } from "../../coding/plan-files/store.js";
import { withHtmlEscapedForms } from "../documents/formats/boards.js";
import type { SecretCipher } from "../plans/publish.js";
import { versionPlanFiles } from "../plans/revision.js";
import { loadAgentSecretValues } from "../secret-guard.js";
import { redactExactSecretValues } from "../secret-spans.js";
import type { JobRef } from "./jobs.js";

/**
 * The plan files for a coding child of a routed run, in grant order; [] when the job has no router run or no
 * granted document has a version. Null when the child's secret values cannot be read (the caller refuses).
 * A document is named by its plan path, else its repository path (a design's ending in "/"), else by its id;
 * a name that is not a safe plan path, or one already used, falls back to the id.
 */
export async function routedInputFiles(
  db: PrismaClient,
  cipher: SecretCipher | undefined,
  job: Pick<JobRef, "routerRunId">,
  childAgentId: string,
): Promise<PlanFile[] | null> {
  if (!job.routerRunId) return [];
  const grants = await db.runDocumentGrant.findMany({
    where: { runId: job.routerRunId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { documentId: true },
  });
  if (grants.length === 0) return [];
  if (!cipher) return null;
  let secrets: string[];
  try {
    // JSON- and HTML-escaped forms too: a design's manifest is JSON and its boards are HTML (as build.ts).
    secrets = withHtmlEscapedForms((await loadAgentSecretValues(db, cipher, childAgentId)).flatMap((e) => e.values));
  } catch {
    return null;
  }
  const redact = (text: string) => redactExactSecretValues(text, secrets);
  const documents = await db.document.findMany({
    where: { id: { in: grants.map((g) => g.documentId) } },
    select: {
      id: true,
      planPath: true,
      path: true,
      currentVersion: { select: { id: true, format: true, markdown: true } },
    },
  });
  const byId = new Map(documents.map((d) => [d.id, d]));
  const used = new Set<string>();
  const files: PlanFile[] = [];
  for (const { documentId } of grants) {
    const doc = byId.get(documentId);
    if (!doc?.currentVersion) continue;
    const design = doc.currentVersion.format !== "markdown";
    const named = doc.planPath ?? doc.path;
    const candidate = named === null ? null : design && !named.endsWith("/") ? `${named}/` : named;
    const fallback = design ? `${doc.id}/` : `${doc.id}.md`;
    const fits = (list: PlanFile[]) => list.every((f) => isSafePlanPath(f.path) && !used.has(f.path));
    let built =
      candidate === null ? null : (await versionPlanFiles(db, redact(candidate), doc.currentVersion, redact)).files;
    if (!built || !fits(built)) built = (await versionPlanFiles(db, fallback, doc.currentVersion, redact)).files;
    if (!fits(built)) continue;
    for (const file of built) used.add(file.path);
    files.push(...built);
  }
  return files;
}
