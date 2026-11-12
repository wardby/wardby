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
  const doc = await db.document.findUnique({ where: { id: documentId }, select: { id: true, ownerId: true } });
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

async function accessTo(db: DocumentDb, doc: { id: string; ownerId: string }, viewer: Viewer): Promise<DocumentAccess> {
  if (viewer.kind === "principal") {
    const own = await effectiveAccess(db, "document", doc, viewer.principalId, { operator: viewer.operator });
    if (!viewer.shareLinkId) return own;
    const viaLink = await linkAccess(db, doc, viewer.shareLinkId);
    return accessRank("document", viaLink) > accessRank("document", own) ? viaLink : own;
  }
  return linkAccess(db, doc, viewer.shareLinkId);
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
