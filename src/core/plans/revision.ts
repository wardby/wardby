/**
 * A revision of a "wardby" plan from comments (docs/private spec §5): the planner starts with every
 * counted document of the set in the plan folder, as its current version. The files go into the run
 * record, so each is redacted by exact value against the planner's secret values at send time (a
 * value that became a secret after the version was published never reaches the run). Nothing here
 * logs or returns file content beyond the files themselves.
 */
import type { PrismaClient } from "#prisma";
import type { PlanFile } from "../../coding/plan-files/store.js";
import { loadContent } from "../documents/files.js";
import { redactExactSecretValues } from "../secret-spans.js";

/** Every counted document's current version as plan files: Markdown at planPath, a design's files under it. */
export async function planSetInputFiles(
  db: PrismaClient,
  planSetId: string,
  secretValues: readonly string[],
): Promise<PlanFile[]> {
  const documents = await db.document.findMany({
    where: { planSetId, removedFromPlan: false, planPath: { not: null } },
    orderBy: { planPath: "asc" },
    include: { currentVersion: true },
  });
  const redact = (text: string) => redactExactSecretValues(text, secretValues);
  const files: PlanFile[] = [];
  for (const doc of documents) {
    if (!doc.currentVersion || !doc.planPath) continue;
    files.push(...(await versionPlanFiles(db, doc.planPath, doc.currentVersion, redact)).files);
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * One document version as plan files, the way a builder gets them: Markdown at `path`, a design's files under it
 * (`path` ends with "/"), each redacted with `redact`. Also returns the redacted Markdown (null for a design).
 * Shared by the build gate (build.ts), a plan revision (above) and a routed coding run (review-routing/files.ts).
 */
export async function versionPlanFiles(
  db: Pick<PrismaClient, "documentFile">,
  path: string,
  version: { id: string; format: string; markdown: string | null },
  redact: (text: string) => string,
): Promise<{ files: PlanFile[]; markdown: string | null }> {
  const content = await loadContent(db, version);
  if (content.format === "markdown") {
    const markdown = redact(content.markdown);
    return { files: [{ path, content: markdown }], markdown };
  }
  return {
    files: Object.entries(content.files).map(([inner, text]) => ({ path: `${path}${inner}`, content: redact(text) })),
    markdown: null,
  };
}
