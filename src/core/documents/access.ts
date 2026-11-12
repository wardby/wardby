import type { PrismaClient, Document } from "#prisma";
import { atLeast, effectiveAccess } from "../grants.js";

export type Viewer =
  | { kind: "principal"; principalId: string; operator?: boolean }
  | { kind: "guest"; guestId: string; shareLinkId: string; permission: "view" | "comment" };

export type DocumentAccess = "none" | "read" | "comment" | "write" | "owner";
export type DocumentDb = Pick<PrismaClient, "document" | "documentShareLink" | "resourceGrant">;

export async function documentAccess(db: DocumentDb, documentId: string, viewer: Viewer): Promise<DocumentAccess> {
  const doc = await db.document.findUnique({ where: { id: documentId }, select: { id: true, ownerId: true } });
  if (!doc) return "none";
  return accessTo(db, doc, viewer);
}

async function accessTo(db: DocumentDb, doc: { id: string; ownerId: string }, viewer: Viewer): Promise<DocumentAccess> {
  if (viewer.kind === "principal") {
    return effectiveAccess(db, "document", doc, viewer.principalId, { operator: viewer.operator });
  }
  // The stored link decides, never the permission the caller carries.
  const link = await db.documentShareLink.findUnique({ where: { id: viewer.shareLinkId } });
  if (!link || link.documentId !== doc.id || link.revokedAt !== null || link.expiresAt.getTime() <= Date.now()) {
    return "none";
  }
  return link.permission === "comment" ? "comment" : link.permission === "view" ? "read" : "none";
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
