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
  return {
    number: set.number,
    documents: await readableMembers(
      db,
      set.documents.map((d) => ({ ...d, path: d.planPath ?? "" })),
      viewer,
    ),
  };
}

/**
 * A native option set as one viewer sees it: its name and the members that viewer can read, each with its
 * option label as its path (the title when it has none), in label order.
 */
export async function readableOptionSet(
  db: PrismaClient,
  setId: string,
  viewer: Viewer,
): Promise<{ name: string | null; documents: PlanSetDocumentView[] } | null> {
  const set = await db.documentSet.findUnique({
    where: { id: setId },
    select: {
      name: true,
      documents: {
        orderBy: [{ option: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          kind: true,
          option: true,
          reviewState: true,
          removedFromPlan: true,
          currentVersion: { select: { number: true } },
        },
      },
    },
  });
  if (!set) return null;
  return {
    name: set.name,
    documents: await readableMembers(
      db,
      set.documents.map((d) => ({ ...d, path: d.option ?? d.title })),
      viewer,
    ),
  };
}

/** The members `viewer` can read (documentAccess per document), as the set views list them. */
async function readableMembers(
  db: PrismaClient,
  members: Array<{
    id: string;
    title: string;
    kind: string;
    path: string;
    reviewState: string;
    removedFromPlan: boolean;
    currentVersion: { number: number } | null;
  }>,
  viewer: Viewer,
): Promise<PlanSetDocumentView[]> {
  const documents: PlanSetDocumentView[] = [];
  for (const d of members) {
    if ((await documentAccess(db, d.id, viewer)) === "none") continue;
    documents.push({
      id: d.id,
      title: d.title,
      kind: d.kind === "design" ? "design" : "document",
      path: d.path,
      reviewState: d.reviewState,
      versionNumber: d.currentVersion?.number ?? 0,
      removed: d.removedFromPlan,
    });
  }
  return documents;
}
