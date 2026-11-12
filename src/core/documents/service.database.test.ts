import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { attachSecret, createSecret } from "../secrets.js";
import { documentAccess, requireDocumentAccess } from "./access.js";
import { MAX_MARKDOWN_BYTES } from "./limits.js";
import { createDocument, getDocument, publishVersion } from "./service.js";

const SECRET = "s3cret-value-123";

describe.skipIf(!process.env.DATABASE_URL)("document service (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  let owner: Principal;
  let other: Principal;
  const agent = `docsvc-agent-${s}`;

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `docsvc-owner-${s}` } });
    other = await db.principal.create({ data: { subject: `docsvc-other-${s}` } });
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner.id },
    });
    await createSecret(`DOC_KEY_${s.slice(0, 8)}`, SECRET, owner.id, cipher, db);
    await attachSecret(agent, `DOC_KEY_${s.slice(0, 8)}`, owner.id, db);
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.$disconnect();
  });

  it("creates version 1, sets currentVersionId, and increments on publish", async () => {
    const { id, versionId } = await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "hello" });
    const got = await getDocument(db, id);
    expect(got.document.currentVersionId).toBe(versionId);
    expect(got.version.number).toBe(1);
    const v2 = await publishVersion(db, cipher, { documentId: id, markdown: "hello 2", via: "editor" });
    expect(v2.number).toBe(2);
    expect((await getDocument(db, id)).version.markdown).toBe("hello 2");
  });

  it("refuses oversize markdown and non-document kinds", async () => {
    await expect(
      createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "x".repeat(MAX_MARKDOWN_BYTES + 1) }),
    ).rejects.toThrow("document_too_large");
    await expect(
      createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "T", markdown: "x" }),
    ).rejects.toThrow("document_kind_unsupported");
  });

  it("redacts the owner agent's secret values in versions", async () => {
    const { id } = await createDocument(db, cipher, {
      ownerId: owner.id,
      title: "T",
      agentId: agent,
      markdown: `key ${SECRET} end`,
    });
    expect((await getDocument(db, id)).version.markdown).not.toContain(SECRET);
    expect((await getDocument(db, id)).version.markdown).toContain("[REDACTED]");
    await publishVersion(db, cipher, { documentId: id, markdown: `again ${SECRET}`, via: "mcp", summary: SECRET });
    const v = (await getDocument(db, id)).version;
    expect(v.markdown).not.toContain(SECRET);
    expect(v.summary).not.toContain(SECRET);
  });

  it("computes access for principals and guests", async () => {
    const { id } = await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "x" });
    expect(await documentAccess(db, id, { kind: "principal", principalId: owner.id })).toBe("owner");
    expect(await documentAccess(db, id, { kind: "principal", principalId: other.id })).toBe("none");
    await expect(requireDocumentAccess(db, id, { kind: "principal", principalId: other.id }, "read")).rejects.toThrow(
      "document_not_found",
    );
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: id,
        granteeKind: "principal",
        granteePrincipalId: other.id,
        granteeKey: `principal:${other.id}`,
        level: "comment",
        source: "test",
      },
    });
    const viewer = { kind: "principal", principalId: other.id } as const;
    expect(await documentAccess(db, id, viewer)).toBe("comment");
    await expect(requireDocumentAccess(db, id, viewer, "write")).rejects.toThrow("document_access_denied");
    await requireDocumentAccess(db, id, viewer, "comment");

    const mk = (permission: string, extra: object = {}) =>
      db.documentShareLink.create({
        data: {
          documentId: id,
          tokenHash: randomUUID(),
          permission,
          expiresAt: new Date(Date.now() + 3_600_000),
          createdById: owner.id,
          ...extra,
        },
      });
    const g = (l: { id: string }, permission: "view" | "comment") =>
      ({ kind: "guest", guestId: "g", shareLinkId: l.id, permission }) as const;
    const view = await mk("view");
    const comment = await mk("comment");
    const revoked = await mk("comment", { revokedAt: new Date() });
    const expired = await mk("view", { expiresAt: new Date(Date.now() - 1000) });
    expect(await documentAccess(db, id, g(view, "view"))).toBe("read");
    expect(await documentAccess(db, id, g(comment, "comment"))).toBe("comment");
    expect(await documentAccess(db, id, g(revoked, "comment"))).toBe("none");
    expect(await documentAccess(db, id, g(expired, "view"))).toBe("none");
  });

  it("re-anchors open threads on publish", async () => {
    const { id, versionId } = await createDocument(db, cipher, {
      ownerId: owner.id,
      title: "T",
      markdown: "# Head\n\nKeep **this phrase** here.\n\nDrop this sentence.",
    });
    const mk = (number: number, quote: string) =>
      db.commentThread.create({
        data: { documentId: id, number, versionId, anchor: { type: "text", quote, prefix: "", suffix: "" } },
      });
    const keep = await mk(1, "this phrase");
    const drop = await mk(2, "Drop this sentence");
    const r = await publishVersion(db, cipher, {
      documentId: id,
      markdown: "# Head\n\nKeep **this phrase** here, edited.",
      via: "editor",
    });
    expect(r.reanchored).toEqual({ kept: 1, outdated: 1 });
    expect((await db.commentThread.findUniqueOrThrow({ where: { id: keep.id } })).status).toBe("open");
    expect((await db.commentThread.findUniqueOrThrow({ where: { id: drop.id } })).status).toBe("outdated");
  });

  it("keeps a thread anchored on code-block text open after re-publish", async () => {
    const md = "Intro\n\n```js\n# not a heading\nconst a_b = 1;\n```\n\nOutro";
    const { id, versionId } = await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: md });
    const t = await db.commentThread.create({
      data: {
        documentId: id,
        number: 1,
        versionId,
        anchor: { type: "text", quote: "# not a heading\nconst a_b = 1;", prefix: "", suffix: "" },
      },
    });
    const r = await publishVersion(db, cipher, { documentId: id, markdown: md + "\n\nMore.", via: "editor" });
    expect(r.reanchored).toEqual({ kept: 1, outdated: 0 });
    expect((await db.commentThread.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("open");
  });

  it("stores the given via on createDocument", async () => {
    const { id } = await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "x", via: "mcp" });
    expect((await getDocument(db, id)).version.via).toBe("mcp");
  });
});
