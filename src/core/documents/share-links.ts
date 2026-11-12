import { createHash, randomBytes } from "node:crypto";
import type { Document, DocumentShareLink, PrismaClient } from "#prisma";
import { requireDocumentAccess, type Viewer } from "./access.js";
import { principalNames } from "./comments.js";
import { validateGuestName } from "./names.js";

export type SharePermission = "view" | "comment";
export const DEFAULT_SHARE_DAYS = 14;
export const MAX_SHARE_DAYS = 90;
const MAX_EMAIL_CHARS = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The slice of the client these helpers use; revocation needs a transaction. */
export type ShareDb = PrismaClient;

/** sha256 hex of a share token. Only this digest is ever stored. */
export const hashShareToken = (token: string) => createHash("sha256").update(token).digest("hex");

function isLive(link: Pick<DocumentShareLink, "revokedAt" | "expiresAt">): boolean {
  return link.revokedAt === null && link.expiresAt.getTime() > Date.now();
}

/**
 * Creates a link for a document the viewer owns. The token (32 random bytes,
 * base64url) is returned here once and never stored or listed again; `url` is
 * `<origin>/s/<token>` when `origin` is given.
 */
export async function createShareLink(
  db: ShareDb,
  input: {
    documentId: string;
    viewer: Viewer;
    permission: SharePermission;
    expiresInDays?: number;
    origin?: string;
  },
): Promise<{ id: string; token: string; url: string; expiresAt: Date }> {
  if (input.permission !== "view" && input.permission !== "comment") throw new Error("share_permission_invalid");
  const days = input.expiresInDays ?? DEFAULT_SHARE_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_SHARE_DAYS) throw new Error("share_expiry_invalid");
  await requireDocumentAccess(db, input.documentId, input.viewer, "owner");
  if (input.viewer.kind !== "principal") throw new Error("document_access_denied");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + days * DAY_MS);
  const link = await db.documentShareLink.create({
    data: {
      documentId: input.documentId,
      tokenHash: hashShareToken(token),
      permission: input.permission,
      expiresAt,
      createdById: input.viewer.principalId,
    },
  });
  return { id: link.id, token, url: `${input.origin ?? ""}/s/${token}`, expiresAt };
}

/** The live link and its document for a token, or null (unknown, revoked or expired). */
export async function resolveShareToken(
  db: ShareDb,
  token: string,
): Promise<{ link: DocumentShareLink; document: Document } | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 200) return null;
  const link = await db.documentShareLink.findUnique({
    where: { tokenHash: hashShareToken(token) },
    include: { document: true },
  });
  if (!link || !isLive(link)) return null;
  const { document, ...rest } = link;
  return { link: rest, document };
}

/** Result of {@link validateSessionLink}: no link involved, a live link, or a dead one. */
export type SessionLinkState =
  | { kind: "none" }
  | { kind: "link"; link: DocumentShareLink; document: Document; documentId: string; permission: string }
  | { kind: "dead" };

/**
 * Revalidates, on every request, the share link behind a web session (R9a).
 * Applies to any session carrying a shareLinkId: guest sessions and signed-in
 * members who entered via /s/<token>.
 * - `none`: the session has no shareLinkId; this helper is not concerned.
 * - `dead`: the link is revoked, expired or gone, its document is gone, or a
 *   guestId is present and that guest is missing or belongs to another link.
 * - `link`: the live link, its document, document id and permission.
 */
export async function validateSessionLink(
  db: ShareDb,
  session: { guestId?: string | null; shareLinkId?: string | null },
): Promise<SessionLinkState> {
  if (!session.shareLinkId) return { kind: "none" };
  if (session.guestId) {
    const guest = await db.documentGuest.findUnique({ where: { id: session.guestId } });
    if (!guest || guest.shareLinkId !== session.shareLinkId) return { kind: "dead" };
  }
  const link = await db.documentShareLink.findUnique({
    where: { id: session.shareLinkId },
    include: { document: true },
  });
  if (!link || !link.document || !isLive(link)) return { kind: "dead" };
  const { document, ...rest } = link;
  return { kind: "link", link: rest, document, documentId: document.id, permission: link.permission };
}

/** Display names of the document's members (owner and principal grantees), for the guest-name rule. */
async function memberNames(db: ShareDb, doc: { id: string; ownerId: string }): Promise<string[]> {
  const grants = await db.resourceGrant.findMany({
    where: { resourceType: "document", resourceId: doc.id, granteeKind: "principal" },
    select: { granteePrincipalId: true },
  });
  const ids = [doc.ownerId, ...grants.flatMap((g) => (g.granteePrincipalId ? [g.granteePrincipalId] : []))];
  return [...(await principalNames(db, ids)).values()];
}

/** Registers a guest on a live link. The name is normalized (NFKC) and checked against the document's members. */
export async function registerGuest(
  db: ShareDb,
  input: { shareLinkId: string; name: string; email?: string },
): Promise<{ guestId: string }> {
  const link = await db.documentShareLink.findUnique({
    where: { id: input.shareLinkId },
    include: { document: { select: { id: true, ownerId: true } } },
  });
  if (!link || !isLive(link)) throw new Error("share_link_invalid");
  const name = validateGuestName(input.name, await memberNames(db, link.document));
  let email: string | null = null;
  if (input.email !== undefined && input.email.trim() !== "") {
    email = input.email.trim();
    if (email.length > MAX_EMAIL_CHARS || !EMAIL_SHAPE.test(email)) throw new Error("guest_email_invalid");
  }
  const guest = await db.documentGuest.create({ data: { shareLinkId: link.id, name, email } });
  return { guestId: guest.id };
}

export interface ShareLinkView {
  id: string;
  permission: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  guestCount: number;
}

/** Owner-only listing. Tokens are not stored, so they cannot appear here. */
export async function listShareLinks(
  db: ShareDb,
  input: { documentId: string; viewer: Viewer },
): Promise<ShareLinkView[]> {
  await requireDocumentAccess(db, input.documentId, input.viewer, "owner");
  const rows = await db.documentShareLink.findMany({
    where: { documentId: input.documentId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { guests: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    permission: r.permission,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
    guestCount: r._count.guests,
  }));
}

/** Owner-only. Marks the link revoked and deletes every browser session that came through it, in one transaction. */
export async function revokeShareLink(db: ShareDb, input: { shareLinkId: string; viewer: Viewer }): Promise<void> {
  const link = await db.documentShareLink.findUnique({ where: { id: input.shareLinkId } });
  if (!link) throw new Error("share_link_not_found");
  try {
    await requireDocumentAccess(db, link.documentId, input.viewer, "owner");
  } catch {
    // Do not reveal links on documents the caller cannot manage.
    throw new Error("share_link_not_found");
  }
  await db.$transaction(async (tx) => {
    await tx.documentShareLink.updateMany({
      where: { id: link.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.webSession.deleteMany({
      where: { OR: [{ shareLinkId: link.id }, { guest: { shareLinkId: link.id } }] },
    });
  });
}
