import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { createWebSession } from "../../web/session.js";
import { upsertProfile } from "./profiles.js";
import { createDocument } from "./service.js";
import {
  createShareLink,
  hashShareToken,
  listShareLinks,
  registerGuest,
  resolveShareToken,
  revokeShareLink,
  validateSessionLink,
} from "./share-links.js";

describe.skipIf(!process.env.DATABASE_URL)("share links (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  let owner: Principal;
  let other: Principal;
  let docId: string;
  const view = (p: Principal) => ({ kind: "principal" as const, principalId: p.id });

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `sl-owner-${s}` } });
    other = await db.principal.create({ data: { subject: `sl-other-${s}` } });
    await upsertProfile(db, owner.id, { displayName: "Olive Owner", source: "operator" });
    await upsertProfile(db, other.id, { displayName: "Grace Grantee", source: "operator" });
    docId = (await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "x" })).id;
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: docId,
        granteeKind: "principal",
        granteePrincipalId: other.id,
        granteeKey: `principal:${other.id}`,
        level: "read",
      },
    });
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.principal.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    await db.$disconnect();
  });

  it("only the owner can create, list or revoke", async () => {
    await expect(createShareLink(db, { documentId: docId, viewer: view(other), permission: "view" })).rejects.toThrow(
      "document_access_denied",
    );
    const stranger = await db.principal.create({ data: { subject: `sl-stranger-${s}` } });
    await expect(
      createShareLink(db, { documentId: docId, viewer: view(stranger), permission: "view" }),
    ).rejects.toThrow("document_not_found");
    const link = await createShareLink(db, { documentId: docId, viewer: view(owner), permission: "view" });
    await expect(listShareLinks(db, { documentId: docId, viewer: view(other) })).rejects.toThrow();
    await expect(revokeShareLink(db, { shareLinkId: link.id, viewer: view(other) })).rejects.toThrow(
      "share_link_not_found",
    );
    await db.principal.delete({ where: { id: stranger.id } });
  });

  it("stores only the hash, never lists the token, and builds /s/<token>", async () => {
    const link = await createShareLink(db, {
      documentId: docId,
      viewer: view(owner),
      permission: "comment",
      origin: "https://wardby.example",
    });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.url).toBe(`https://wardby.example/s/${link.token}`);
    const row = await db.documentShareLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(row.tokenHash).toBe(hashShareToken(link.token));
    expect(JSON.stringify(row)).not.toContain(link.token);
    const listed = await listShareLinks(db, { documentId: docId, viewer: view(owner) });
    expect(JSON.stringify(listed)).not.toContain(link.token);
    expect(listed.find((l) => l.id === link.id)?.guestCount).toBe(0);
  });

  it("limits permission and expiry", async () => {
    const bad = (p: unknown, d?: number) =>
      createShareLink(db, { documentId: docId, viewer: view(owner), permission: p as "view", expiresInDays: d });
    await expect(bad("everyone")).rejects.toThrow("share_permission_invalid");
    await expect(bad("write")).rejects.toThrow("share_permission_invalid");
    await expect(bad("view", 0)).rejects.toThrow("share_expiry_invalid");
    await expect(bad("view", 91)).rejects.toThrow("share_expiry_invalid");
    await expect(bad("view", 1.5)).rejects.toThrow("share_expiry_invalid");
    const ok = await bad("view", 90);
    expect(ok.expiresAt.getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
  });

  it("resolves live tokens; revoked, expired and unknown resolve to null", async () => {
    const live = await createShareLink(db, { documentId: docId, viewer: view(owner), permission: "view" });
    expect((await resolveShareToken(db, live.token))?.document.id).toBe(docId);
    expect(await resolveShareToken(db, "nope")).toBeNull();
    await db.documentShareLink.update({ where: { id: live.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveShareToken(db, live.token)).toBeNull();
    const rev = await createShareLink(db, { documentId: docId, viewer: view(owner), permission: "view" });
    await revokeShareLink(db, { shareLinkId: rev.id, viewer: view(owner) });
    expect(await resolveShareToken(db, rev.token)).toBeNull();
  });

  it("enforces guest name and email rules", async () => {
    const link = await createShareLink(db, { documentId: docId, viewer: view(owner), permission: "comment" });
    const reg = (name: string, email?: string) => registerGuest(db, { shareLinkId: link.id, name, email });
    for (const n of ["", "Agent 7", "Dan via Bot", "olive owner", "Grace Grantee", "Ｇrace Grantee", "x".repeat(41)]) {
      await expect(reg(n)).rejects.toThrow("guest_name_invalid");
    }
    await expect(reg("Dana", "not-an-email")).rejects.toThrow("guest_email_invalid");
    await expect(reg("Dana", `${"a".repeat(250)}@b.co`)).rejects.toThrow("guest_email_invalid");
    const { guestId } = await reg("  Ｄana  ", "dana@example.com");
    const guest = await db.documentGuest.findUniqueOrThrow({ where: { id: guestId } });
    expect(guest.name).toBe("Dana");
    expect(guest.email).toBe("dana@example.com");
    expect(
      (await listShareLinks(db, { documentId: docId, viewer: view(owner) })).find((l) => l.id === link.id)?.guestCount,
    ).toBe(1);
  });

  it("refuses to register a guest on a revoked or expired link", async () => {
    const link = await createShareLink(db, { documentId: docId, viewer: view(owner), permission: "view" });
    await revokeShareLink(db, { shareLinkId: link.id, viewer: view(owner) });
    await expect(registerGuest(db, { shareLinkId: link.id, name: "Late" })).rejects.toThrow("share_link_invalid");
  });

  it("revoking deletes the guests' web sessions and validateSessionLink turns null", async () => {
    const link = await createShareLink(db, { documentId: docId, viewer: view(owner), permission: "comment" });
    const { guestId } = await registerGuest(db, { shareLinkId: link.id, name: "Sess Guest" });
    const guestSession = await createWebSession(db, { guestId, shareLinkId: link.id });
    const ownerSession = await createWebSession(db, { principalId: owner.id });
    expect((await validateSessionLink(db, { guestId, shareLinkId: link.id }))?.document.id).toBe(docId);
    expect(await validateSessionLink(db, { guestId: "other", shareLinkId: link.id })).toBeNull();
    expect(await validateSessionLink(db, {})).toBeNull();
    await revokeShareLink(db, { shareLinkId: link.id, viewer: view(owner) });
    expect(await validateSessionLink(db, { guestId, shareLinkId: link.id })).toBeNull();
    expect(await db.webSession.count({ where: { guestId } })).toBe(0);
    expect(await db.webSession.count({ where: { principalId: owner.id } })).toBe(1);
    expect(guestSession.token).not.toBe(ownerSession.token);
    // idempotent
    await revokeShareLink(db, { shareLinkId: link.id, viewer: view(owner) });
  });

  it("validateSessionLink is null once the link expires", async () => {
    const link = await createShareLink(db, { documentId: docId, viewer: view(owner), permission: "view" });
    const { guestId } = await registerGuest(db, { shareLinkId: link.id, name: "Exp Guest" });
    await db.documentShareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await validateSessionLink(db, { guestId, shareLinkId: link.id })).toBeNull();
  });
});
