/**
 * A plan set as one viewer sees it: its number and the documents of the set that viewer can read
 * (documentAccess per document, so a share-link guest sees only the document their link opens).
 * get_document (MCP) and the page's plan bar both read it; the MCP result leaves titles out, since
 * people wrote them and they belong in each document's own wrapped text.
 */
import type { PrismaClient } from "#prisma";
import { documentAccess, type Viewer } from "../documents/access.js";

export interface PlanSetDocumentView {
  id: string;
  title: string;
  kind: "document" | "design";
  path: string;
  reviewState: string;
  versionNumber: number;
  removed: boolean;
}

export async function readablePlanSet(
  db: PrismaClient,
  planSetId: string,
  viewer: Viewer,
): Promise<{ number: number; documents: PlanSetDocumentView[] } | null> {
  const set = await db.planSet.findUnique({
    where: { id: planSetId },
    select: {
      number: true,
      documents: {
        orderBy: { planPath: "asc" },
        select: {
          id: true,
          title: true,
          kind: true,
          planPath: true,
          reviewState: true,
          removedFromPlan: true,
          currentVersion: { select: { number: true } },
        },
      },
    },
  });
  if (!set) return null;
  const documents: PlanSetDocumentView[] = [];
  for (const d of set.documents) {
    if ((await documentAccess(db, d.id, viewer)) === "none") continue;
    documents.push({
      id: d.id,
      title: d.title,
      kind: d.kind === "design" ? "design" : "document",
      path: d.planPath ?? "",
      reviewState: d.reviewState,
      versionNumber: d.currentVersion?.number ?? 0,
      removed: d.removedFromPlan,
    });
  }
  return { number: set.number, documents };
}
