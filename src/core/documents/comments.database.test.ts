import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { attachSecret, createSecret } from "../secrets.js";
import type { Viewer } from "./access.js";
import {
  createThread,
  deleteComment,
  editComment,
  guestMentionCandidates,
  listThreads,
  MAX_MENTIONS_CHECKED,
  mentionCandidates,
  mentionedGuestNames,
  reply,
  setThreadStatus,
} from "./comments.js";
import { MAX_COMMENT_CHARS } from "./limits.js";
import { createDocument } from "./service.js";

const SECRET = "s3cret-comment-456";
const anchor = { type: "text", quote: "hello", prefix: "", suffix: " world" };

describe.skipIf(!process.env.DATABASE_URL)("comment service (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  const agent = `cmt-agent-${s}`;
  let owner: Principal;
  let member: Principal;
  let outsider: Principal;
  let docId: string;
  let guestComment: Viewer;
  let guestView: Viewer;
  let guestId: string;
  const asOwner = (): Viewer => ({ kind: "principal", principalId: owner.id });
  const asMember = (): Viewer => ({ kind: "principal", principalId: member.id });

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `cmt-owner-${s}` } });
    member = await db.principal.create({ data: { subject: `oidc|cmt-member-${s}` } });
    outsider = await db.principal.create({ data: { subject: `cmt-out-${s}` } });
    await db.principalProfile.create({ data: { principalId: owner.id, displayName: "Olive Owner", source: "oidc" } });
    await db.hostIdentity.create({
      data: { principalId: member.id, provider: "github", hostUserId: `h${s}`, login: `memb-${s.slice(0, 6)}` },
    });
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner.id },
    });
    await createSecret(`CMT_KEY_${s.slice(0, 8)}`, SECRET, owner.id, cipher, db);
    await attachSecret(agent, `CMT_KEY_${s.slice(0, 8)}`, owner.id, db);
    docId = (
      await createDocument(db, cipher, { ownerId: owner.id, title: "D", markdown: "hello world", agentId: agent })
    ).id;
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: docId,
        granteeKind: "principal",
        granteePrincipalId: member.id,
        granteeKey: `principal:${member.id}`,
        level: "comment",
      },
    });
    const mk = async (permission: string, name: string): Promise<{ viewer: Viewer; id: string }> => {
      const link = await db.documentShareLink.create({
        data: {
          documentId: docId,
          tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
          permission,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdById: owner.id,
        },
      });
      const g = await db.documentGuest.create({ data: { shareLinkId: link.id, name } });
      return {
        viewer: { kind: "guest", guestId: g.id, shareLinkId: link.id, permission: permission as "view" | "comment" },
        id: g.id,
      };
    };
    const gc = await mk("comment", "Gus");
    guestComment = gc.viewer;
    guestId = gc.id;
    guestView = (await mk("view", "Vic")).viewer;
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.$disconnect();
  });

  it("guest with comment link creates thread #1 and #2, and replies", async () => {
    const t1 = await createThread(db, cipher, { documentId: docId, viewer: guestComment, anchor, body: "first" });
    expect(t1.number).toBe(1);
    const t2 = await createThread(db, cipher, { documentId: docId, viewer: asOwner(), anchor, body: "second" });
    expect(t2.number).toBe(2);
    const r = await reply(db, cipher, { threadId: t1.threadId, viewer: asOwner(), body: "answer" });
    expect(r.commentId).toBeTruthy();
  });

  it("refuses view-only guests, bad anchors and oversize bodies", async () => {
    await expect(createThread(db, cipher, { documentId: docId, viewer: guestView, anchor, body: "x" })).rejects.toThrow(
      "document_access_denied",
    );
    await expect(
      createThread(db, cipher, { documentId: docId, viewer: asOwner(), anchor: { nope: 1 }, body: "x" }),
    ).rejects.toThrow("comment_anchor_invalid");
    await expect(
      createThread(db, cipher, {
        documentId: docId,
        viewer: asOwner(),
        anchor,
        body: "x".repeat(MAX_COMMENT_CHARS + 1),
      }),
    ).rejects.toThrow("comment_too_long");
  });

  it("stores bodies with the agent's secret values redacted", async () => {
    const t = await createThread(db, cipher, { documentId: docId, viewer: asOwner(), anchor, body: `key ${SECRET}!` });
    const rows = await db.comment.findMany({ where: { threadId: t.threadId } });
    expect(rows[0].body).not.toContain(SECRET);
    const r = await reply(db, cipher, { threadId: t.threadId, viewer: asOwner(), body: `again ${SECRET}` });
    expect((await db.comment.findUniqueOrThrow({ where: { id: r.commentId } })).body).not.toContain(SECRET);
  });

  it("returns mentions without access, deduped, and keeps the body", async () => {
    const body = `hi @[${outsider.id}] and @[${outsider.id}] and @[${member.id}]`;
    const t = await createThread(db, cipher, { documentId: docId, viewer: asOwner(), anchor, body });
    expect(t.mentionsWithoutAccess).toEqual([outsider.id]);
    expect((await db.comment.findFirstOrThrow({ where: { threadId: t.threadId } })).body).toBe(body);
    const r = await reply(db, cipher, { threadId: t.threadId, viewer: asOwner(), body: `@[${outsider.id}]` });
    expect(r.mentionsWithoutAccess).toEqual([outsider.id]);
  });

  it("checks at most MAX_MENTIONS_CHECKED distinct mentions per comment", async () => {
    const many = Array.from({ length: MAX_MENTIONS_CHECKED + 30 }, (_, i) => `@[nobody-${i}-${s.slice(0, 8)}]`);
    const t = await createThread(db, cipher, { documentId: docId, viewer: asOwner(), anchor, body: many.join(" ") });
    expect(t.mentionsWithoutAccess).toHaveLength(MAX_MENTIONS_CHECKED);
  });

  it("edits and deletes only own comments; guests by guestId", async () => {
    const t = await createThread(db, cipher, { documentId: docId, viewer: guestComment, anchor, body: "mine" });
    const c = await db.comment.findFirstOrThrow({ where: { threadId: t.threadId } });
    await expect(editComment(db, cipher, { commentId: c.id, viewer: asOwner(), body: "hijack" })).rejects.toThrow(
      "comment_edit_forbidden",
    );
    await expect(deleteComment(db, { commentId: c.id, viewer: asOwner() })).rejects.toThrow("comment_edit_forbidden");
    await editComment(db, cipher, { commentId: c.id, viewer: guestComment, body: "edited" });
    const after = await db.comment.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.body).toBe("edited");
    expect(after.editedAt).not.toBeNull();
    await deleteComment(db, { commentId: c.id, viewer: guestComment });
    expect((await db.comment.findUniqueOrThrow({ where: { id: c.id } })).deletedAt).not.toBeNull();
    await expect(deleteComment(db, { commentId: "nope", viewer: guestComment })).rejects.toThrow("comment_not_found");
  });

  it("resolve blocks replies; author, writer or owner may change status", async () => {
    const t = await createThread(db, cipher, { documentId: docId, viewer: asMember(), anchor, body: "q" });
    await expect(
      setThreadStatus(db, { threadId: t.threadId, viewer: guestComment, status: "resolved" }),
    ).rejects.toThrow("document_access_denied");
    await setThreadStatus(db, { threadId: t.threadId, viewer: asMember(), status: "resolved" });
    await expect(reply(db, cipher, { threadId: t.threadId, viewer: asOwner(), body: "late" })).rejects.toThrow(
      "comment_thread_closed",
    );
    await setThreadStatus(db, { threadId: t.threadId, viewer: asOwner(), status: "open" });
    await reply(db, cipher, { threadId: t.threadId, viewer: asOwner(), body: "now ok" });
    const other = await createThread(db, cipher, { documentId: docId, viewer: asOwner(), anchor, body: "o" });
    await expect(
      setThreadStatus(db, { threadId: other.threadId, viewer: asMember(), status: "resolved" }),
    ).rejects.toThrow("document_access_denied");
    await expect(setThreadStatus(db, { threadId: "nope", viewer: asOwner(), status: "open" })).rejects.toThrow(
      "comment_not_found",
    );
  });

  it("lists with names, mine flag and filters", async () => {
    const d = (await createDocument(db, cipher, { ownerId: owner.id, title: "L", markdown: "hello world" })).id;
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: d,
        granteeKind: "principal",
        granteePrincipalId: member.id,
        granteeKey: `principal:${member.id}`,
        level: "comment",
      },
    });
    const ghost = await db.principal.create({ data: { subject: `cmt-ghost-${s}` } });
    const tOwner = await createThread(db, cipher, { documentId: d, viewer: asOwner(), anchor, body: "from owner" });
    await reply(db, cipher, { threadId: tOwner.threadId, viewer: asMember(), body: "from member" });
    const tm = await createThread(db, cipher, { documentId: d, viewer: asMember(), anchor, body: "member thread" });
    await db.comment.create({ data: { threadId: tm.threadId, authorId: ghost.id, body: "ghost" } });
    await db.principal.delete({ where: { id: ghost.id } });
    await db.comment.create({
      data: { threadId: tm.threadId, authorId: owner.id, runId: "run1", viaId: member.id, body: "agent says" },
    });
    await db.comment.create({ data: { threadId: tm.threadId, guestId, body: "guest says" } });
    await setThreadStatus(db, { threadId: tm.threadId, viewer: asMember(), status: "resolved" });
    await db.commentThread.update({ where: { id: tOwner.threadId }, data: { sentAt: new Date() } });

    const all = await listThreads(db, { documentId: d, viewer: asOwner(), filter: "all" });
    expect(all.map((t) => t.number)).toEqual([1, 2]);
    const c0 = all[0].comments;
    expect(c0[0]).toMatchObject({ author: { kind: "member", name: "Olive Owner" }, mine: true });
    expect(c0[1].author).toEqual({ kind: "member", name: `@memb-${s.slice(0, 6)}` });
    expect(c0[1].mine).toBe(false);
    const c1 = all[1].comments;
    expect(c1[1].author).toEqual({ kind: "member", name: "Former member" });
    expect(c1[2].author).toEqual({ kind: "agent", name: "Agent", viaName: `@memb-${s.slice(0, 6)}` });
    expect(c1[3].author).toEqual({ kind: "guest", name: "Gus (guest)" });

    const names = (f: "open" | "resolved" | "sent" | "mine") =>
      listThreads(db, { documentId: d, viewer: asOwner(), filter: f }).then((r) => r.map((t) => t.number));
    expect(await names("open")).toEqual([1]);
    expect(await names("resolved")).toEqual([2]);
    expect(await names("sent")).toEqual([1]);
    expect(await names("mine")).toEqual([1]); // agent replies are not the viewer's own
    const memberMine = await listThreads(db, { documentId: d, viewer: asMember(), filter: "mine" });
    expect(memberMine.map((t) => t.number)).toEqual([1, 2]);
    expect(memberMine[0].comments.map((c) => c.mine)).toEqual([false, true]);
    await expect(
      listThreads(db, { documentId: d, viewer: { kind: "principal", principalId: outsider.id }, filter: "all" }),
    ).rejects.toThrow("document_not_found");
  });

  it("lists mention candidates: owner, grantees, and profiles for everyone grants", async () => {
    const d = (await createDocument(db, cipher, { ownerId: owner.id, title: "M", markdown: "x" })).id;
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: d,
        granteeKind: "principal",
        granteePrincipalId: member.id,
        granteeKey: `principal:${member.id}`,
        level: "read",
      },
    });
    let cands = await mentionCandidates(db, d);
    expect(cands.map((c) => c.principalId).sort()).toEqual([owner.id, member.id].sort());
    expect(cands.find((c) => c.principalId === owner.id)?.name).toBe("Olive Owner");
    await db.principalProfile.create({ data: { principalId: outsider.id, displayName: "Otto", source: "oidc" } });
    await db.resourceGrant.create({
      data: { resourceType: "document", resourceId: d, granteeKind: "everyone", granteeKey: "everyone", level: "read" },
    });
    cands = await mentionCandidates(db, d);
    expect(cands.map((c) => c.principalId)).toContain(outsider.id);
    await db.principalProfile.delete({ where: { principalId: outsider.id } });
  });
  it("guest mentions: members may mention guests who commented here; names resolve only on this document", async () => {
    const d = (await createDocument(db, cipher, { ownerId: owner.id, title: "G", markdown: "hello world" })).id;
    const link = async (documentId: string) =>
      db.documentShareLink.create({
        data: {
          documentId,
          tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
          permission: "comment",
          expiresAt: new Date(Date.now() + 86_400_000),
          createdById: owner.id,
        },
      });
    const here = await link(d);
    const talker = await db.documentGuest.create({ data: { shareLinkId: here.id, name: "Tess" } });
    const silent = await db.documentGuest.create({ data: { shareLinkId: here.id, name: "Sid" } });
    const talkerViewer: Viewer = { kind: "guest", guestId: talker.id, shareLinkId: here.id, permission: "comment" };
    await createThread(db, cipher, { documentId: d, viewer: talkerViewer, anchor, body: "a guest comment" });
    await createThread(db, cipher, { documentId: d, viewer: asOwner(), anchor, body: "a member comment" });

    // Only guests who commented on this document; never members, never the silent guest.
    const cands = await guestMentionCandidates(db, d);
    expect(cands).toEqual([{ guestId: talker.id, name: "Tess" }]);
    expect(cands.some((c) => c.guestId === owner.id)).toBe(false);
    // A guest who commented on another document (docId's Gus) is not offered here.
    expect(cands.some((c) => c.guestId === guestId)).toBe(false);

    // @[guest:...] for this document's guest resolves; one from another document does not.
    const body = `ping @[guest:${talker.id}] and @[guest:${guestId}] and @[${member.id}]`;
    const t = await createThread(db, cipher, { documentId: d, viewer: asOwner(), anchor, body });
    expect(t.mentionsWithoutAccess).toEqual([member.id]);
    expect(await mentionedGuestNames(db, d, [body])).toEqual([{ guestId: talker.id, name: "Tess" }]);
    // On Gus's own document it is the other way round.
    expect(await mentionedGuestNames(db, docId, [body])).toEqual([{ guestId, name: "Gus" }]);
    expect(await mentionedGuestNames(db, d, ["no mentions"])).toEqual([]);
    void silent;
  });

  it("the mention cap counts guest mentions too", async () => {
    const guests = Array.from({ length: MAX_MENTIONS_CHECKED }, (_, i) => `@[guest:g${i}]`);
    const body = `${guests.join(" ")} @[nobody-after-cap-${s.slice(0, 8)}]`;
    const t = await createThread(db, cipher, { documentId: docId, viewer: asOwner(), anchor, body });
    expect(t.mentionsWithoutAccess).toEqual([]);
  });
});
