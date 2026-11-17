import type { PrismaClient, Document } from "#prisma";
import { accessRank, atLeast, effectiveAccess } from "../grants.js";

/**
 * Who is asking. A principal who opened the document through a share link
 * carries that link's id: they get the higher of their own access and the
 * link's, and only on the link's document while the link is live.
 */
export type Viewer =
  | { kind: "principal"; principalId: string; operator?: boolean; shareLinkId?: string }
  | { kind: "guest"; guestId: string; shareLinkId: string; permission: "view" | "comment" };

export type DocumentAccess = "none" | "read" | "comment" | "write" | "owner";
export type DocumentDb = Pick<PrismaClient, "document" | "documentShareLink" | "resourceGrant">;

export async function documentAccess(db: DocumentDb, documentId: string, viewer: Viewer): Promise<DocumentAccess> {
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, ownerId: true, planSetId: true },
  });
  if (!doc) return "none";
  return accessTo(db, doc, viewer);
}

/** What a share link confers on this document: the stored link decides, never what the caller carries. */
async function linkAccess(
  db: DocumentDb,
  doc: { id: string },
  shareLinkId: string,
): Promise<"none" | "read" | "comment"> {
  const link = await db.documentShareLink.findUnique({ where: { id: shareLinkId } });
  if (!link || link.documentId !== doc.id || link.revokedAt !== null || link.expiresAt.getTime() <= Date.now()) {
    return "none";
  }
  return link.permission === "comment" ? "comment" : link.permission === "view" ? "read" : "none";
}

type AccessDoc = { id: string; ownerId: string; planSetId: string | null };

function higher(a: DocumentAccess, b: DocumentAccess): DocumentAccess {
  return accessRank("document", a) >= accessRank("document", b) ? a : b;
}

/**
 * A plan document is open to comment for the people of the agent that was triggered (PlanSet.accessAgentId,
 * docs/private spec §6): its owner and anyone with any grant on it, everyone grants included. Live, never
 * copied: losing the agent loses the plan. Never more than comment. A removed access agent (SetNull) or a
 * document outside a plan set gives nothing here.
 */
async function planAccess(db: DocumentDb, doc: AccessDoc, principalId: string): Promise<"none" | "comment"> {
  if (!doc.planSetId) return "none";
  const plan = await db.document.findUnique({
    where: { id: doc.id },
    select: { planSet: { select: { accessAgent: { select: { id: true, ownerId: true } } } } },
  });
  const agent = plan?.planSet?.accessAgent;
  if (!agent) return "none";
  return atLeast("agent", await effectiveAccess(db, "agent", agent, principalId), "read") ? "comment" : "none";
}

async function accessTo(db: DocumentDb, doc: AccessDoc, viewer: Viewer): Promise<DocumentAccess> {
  if (viewer.kind !== "principal") return linkAccess(db, doc, viewer.shareLinkId);
  let best: DocumentAccess = await effectiveAccess(db, "document", doc, viewer.principalId, {
    operator: viewer.operator,
  });
  if (viewer.shareLinkId) best = higher(best, await linkAccess(db, doc, viewer.shareLinkId));
  // The plan lookup runs only for plan documents, and only when the cheaper checks gave less than comment.
  if (accessRank("document", best) < accessRank("document", "comment")) {
    best = higher(best, await planAccess(db, doc, viewer.principalId));
  }
  return best;
}

export async function requireDocumentAccess(
  db: DocumentDb,
  documentId: string,
  viewer: Viewer,
  need: "read" | "comment" | "write" | "owner",
): Promise<Document> {
  const doc = await db.document.findUnique({ where: { id: documentId } });
  if (!doc) throw new Error("document_not_found");
  const access = await accessTo(db, doc, viewer);
  if (access === "none") throw new Error("document_not_found");
  if (!atLeast("document", access, need)) throw new Error("document_access_denied");
  return doc;
}
