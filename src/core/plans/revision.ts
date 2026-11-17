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
    const content = await loadContent(db, doc.currentVersion);
    if (content.format === "markdown") {
      files.push({ path: doc.planPath, content: redact(content.markdown) });
      continue;
    }
    for (const [path, text] of Object.entries(content.files)) {
      files.push({ path: `${doc.planPath}${path}`, content: redact(text) });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
