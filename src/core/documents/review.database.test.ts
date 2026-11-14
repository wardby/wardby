/**
 * Document review states against real PostgreSQL: who may act, the state rule applied after each
 * action, concurrency, stale verdicts, force, reopen, archive, events and note redaction.
 * Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { attachSecret, createSecret } from "../secrets.js";
import type { Viewer } from "./access.js";
import { createDocumentEventBus, type DocumentEvent } from "./events.js";
import { createDocument, publishVersion } from "./service.js";
import { createShareLink, registerGuest } from "./share-links.js";
import {
  forceApprove,
  getReviewView,
  reopenDocument,
  reviewCandidates,
  reviewDocument,
  ReviewVersionConflictError,
  setArchived,
  submitForReview,
} from "./review.js";

const SECRET = "s3cret-review-456";

describe.skipIf(!process.env.DATABASE_URL)("document review (database)", { timeout: 30_000 }, () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  let owner: Principal;
  let ann: Principal;
  let ben: Principal;
  let cat: Principal;
  let outsider: Principal;
  const agentId = `review-agent-${s}`;
  const as = (p: Principal): Viewer => ({ kind: "principal", principalId: p.id });

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `rv-owner-${s}` } });
    ann = await db.principal.create({ data: { subject: `rv-ann-${s}` } });
    ben = await db.principal.create({ data: { subject: `rv-ben-${s}` } });
    cat = await db.principal.create({ data: { subject: `rv-cat-${s}` } });
    outsider = await db.principal.create({ data: { subject: `rv-out-${s}` } });
    for (const [p, name] of [
      [owner, "Olive Owner"],
      [ann, "Ann Reviewer"],
      [ben, "Ben Reviewer"],
      [cat, "Cat Approver"],
    ] as const) {
      await db.principalProfile.create({ data: { principalId: p.id, displayName: name, source: "oidc" } });
    }
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner.id },
    });
    await createSecret(`RV_KEY_${s.slice(0, 8)}`, SECRET, owner.id, cipher, db);
    await attachSecret(agentId, `RV_KEY_${s.slice(0, 8)}`, owner.id, db);
  });
  afterAll(async () => {
    const ids = [owner.id, ann.id, ben.id, cat.id, outsider.id];
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.resourceGrant.deleteMany({ where: { granteePrincipalId: { in: ids } } });
    await db.agentSecret.deleteMany({ where: { agentId } });
    await db.secret.deleteMany({ where: { ownerId: owner.id } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principalProfile.deleteMany({ where: { principalId: { in: ids } } });
    await db.principal.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  const doc = async (agent = false) =>
    (
      await createDocument(db, cipher, {
        ownerId: owner.id,
        title: "Plan",
        markdown: "# Plan\n\nhello",
        ...(agent ? { agentId } : {}),
      })
    ).id;
  const stateOf = async (id: string) =>
    (await db.document.findUniqueOrThrow({ where: { id }, select: { reviewState: true } })).reviewState;
  const eventsOf = (id: string) =>
    db.documentReviewEvent.findMany({ where: { documentId: id }, orderBy: { createdAt: "asc" } });

  it("new documents are drafts; only the owner submits, with at least one reviewer", async () => {
    const id = await doc();
    expect(await stateOf(id)).toBe("draft");
    await expect(submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [] })).rejects.toThrow(
      "document_review_state_invalid",
    );
    await expect(submitForReview(db, { documentId: id, viewer: as(ann), reviewers: [ann.id] })).rejects.toThrow(
      "document_not_found",
    );
    const view = await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id, ben.id] });
    expect(view.state).toBe("in_review");
    expect(view.progress).toEqual({ approved: 0, total: 2 });
    expect(view.reviewers.map((r) => [r.name, r.verdict])).toEqual([
      ["Ann Reviewer", "none"],
      ["Ben Reviewer", "none"],
    ]);
    expect((await eventsOf(id)).map((e) => [e.kind, e.fromState, e.toState, e.versionNumber])).toEqual([
      ["submitted", "draft", "in_review", 1],
    ]);
  });

  it("naming a reviewer grants comment access when they lack it, and never lowers a grant", async () => {
    const id = await doc();
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: id,
        granteeKind: "principal",
        granteePrincipalId: ben.id,
        granteeKey: `principal:${ben.id}`,
        level: "write",
      },
    });
    await submitForReview(db, {
      documentId: id,
      viewer: as(owner),
      reviewers: [ann.id, ben.id],
      finalApproverId: cat.id,
    });
    const grants = await db.resourceGrant.findMany({ where: { resourceType: "document", resourceId: id } });
    const level = (p: Principal) => grants.find((g) => g.granteePrincipalId === p.id)?.level;
    expect([level(ann), level(ben), level(cat)]).toEqual(["comment", "write", "comment"]);
    expect(grants.find((g) => g.granteePrincipalId === ann.id)?.source).toBe("document_review");
  });

  it("refuses an unknown reviewer, a guest of another document, a view-link guest and a too-long list", async () => {
    const id = await doc();
    const other = await doc();
    const otherLink = await createShareLink(db, { documentId: other, viewer: as(owner), permission: "comment" });
    const stranger = await registerGuest(db, { shareLinkId: otherLink.id, name: "Stranger" });
    const viewLink = await createShareLink(db, { documentId: id, viewer: as(owner), permission: "view" });
    const viewer = await registerGuest(db, { shareLinkId: viewLink.id, name: "Viewer" });
    for (const reviewers of [
      ["no-such-principal"],
      [`guest:${stranger.guestId}`],
      [`guest:${viewer.guestId}`],
      Array.from({ length: 51 }, (_, i) => `p${i}`),
    ]) {
      await expect(submitForReview(db, { documentId: id, viewer: as(owner), reviewers })).rejects.toThrow(
        "document_review_state_invalid",
      );
    }
  });

  it("approves once every reviewer approved the current version; changes requested wins", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id, ben.id] });
    let v = await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    expect([v.state, v.progress.approved]).toEqual(["in_review", 1]);
    v = await reviewDocument(db, cipher, {
      documentId: id,
      viewer: as(ben),
      verdict: "request_changes",
      versionNumber: 1,
      note: "Tighten it",
    });
    expect(v.state).toBe("changes_requested");
    v = await reviewDocument(db, cipher, { documentId: id, viewer: as(ben), verdict: "approve", versionNumber: 1 });
    expect(v.state).toBe("approved");
    expect((await eventsOf(id)).map((e) => e.toState)).toEqual([
      "in_review",
      "in_review",
      "changes_requested",
      "approved",
    ]);
  });

  it("only a named reviewer gives a verdict, only on the current version, never on a draft", async () => {
    const id = await doc();
    await expect(
      reviewDocument(db, cipher, { documentId: id, viewer: as(owner), verdict: "approve", versionNumber: 1 }),
    ).rejects.toThrow("document_review_forbidden");
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await expect(
      reviewDocument(db, cipher, { documentId: id, viewer: as(owner), verdict: "approve", versionNumber: 1 }),
    ).rejects.toThrow("document_review_forbidden");
    await publishVersion(db, cipher, { documentId: id, markdown: "v2", via: "mcp" });
    const stale = reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    await expect(stale).rejects.toBeInstanceOf(ReviewVersionConflictError);
    await expect(stale).rejects.toMatchObject({ message: "document_version_conflict", currentVersion: 2 });
    const draft = await doc();
    await db.documentReviewer.create({ data: { documentId: draft, principalId: ann.id } });
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: draft,
        granteeKind: "principal",
        granteePrincipalId: ann.id,
        granteeKey: `principal:${ann.id}`,
        level: "comment",
      },
    });
    await expect(
      reviewDocument(db, cipher, { documentId: draft, viewer: as(ann), verdict: "approve", versionNumber: 1 }),
    ).rejects.toThrow("document_review_state_invalid");
  });

  it("a reviewer who lost access cannot act until the grant is back", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await db.resourceGrant.deleteMany({ where: { resourceId: id, granteePrincipalId: ann.id } });
    await expect(
      reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 }),
    ).rejects.toThrow("document_not_found");
    expect((await getReviewView(db, id, as(owner))).reviewers).toHaveLength(1);
  });

  it("a guest reviewer on a comment link approves; a revoked link stops them", async () => {
    const id = await doc();
    const link = await createShareLink(db, { documentId: id, viewer: as(owner), permission: "comment" });
    const { guestId } = await registerGuest(db, { shareLinkId: link.id, name: "Gail" });
    const guest: Viewer = { kind: "guest", guestId, shareLinkId: link.id, permission: "comment" };
    const cands = await reviewCandidates(db, id, as(owner));
    expect(cands.guests).toEqual([{ guestId, name: "Gail" }]);
    await expect(reviewCandidates(db, id, as(ann))).rejects.toThrow();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [`guest:${guestId}`] });
    const v = await reviewDocument(db, cipher, { documentId: id, viewer: guest, verdict: "approve", versionNumber: 1 });
    expect(v.state).toBe("approved");
    expect(v.reviewers[0]).toMatchObject({ kind: "guest", name: "Gail (guest)", ref: `guest:${guestId}`, me: true });
    await reopenDocument(db, { documentId: id, viewer: as(owner) });
    await db.documentShareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
    await expect(
      reviewDocument(db, cipher, { documentId: id, viewer: guest, verdict: "approve", versionNumber: 1 }),
    ).rejects.toThrow("document_not_found");
  });

  it("a guest on a revoked or expired comment link is neither a candidate nor a reviewer", async () => {
    const id = await doc();
    const revoked = await createShareLink(db, { documentId: id, viewer: as(owner), permission: "comment" });
    const gone = await registerGuest(db, { shareLinkId: revoked.id, name: "Gone" });
    const expired = await createShareLink(db, { documentId: id, viewer: as(owner), permission: "comment" });
    const late = await registerGuest(db, { shareLinkId: expired.id, name: "Late" });
    await db.documentShareLink.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
    await db.documentShareLink.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await reviewCandidates(db, id, as(owner))).guests).toEqual([]);
    for (const guestId of [gone.guestId, late.guestId]) {
      await expect(
        submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [`guest:${guestId}`] }),
      ).rejects.toThrow("document_review_state_invalid");
    }
    expect(await stateOf(id)).toBe("draft");
  });

  it("access revoked after the early check but before the transaction stops the verdict and the force", async () => {
    // A cipher that revokes a grant while the note is being redacted (between the early check and the transaction).
    const revokingCipher = (principalId: string, documentId: string) => {
      let done = false;
      return {
        ...cipher,
        decrypt: async (v: string) => {
          if (!done) {
            done = true;
            await db.resourceGrant.deleteMany({ where: { resourceId: documentId, granteePrincipalId: principalId } });
          }
          return v;
        },
      };
    };
    const id = await doc(true);
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id], finalApproverId: cat.id });
    await expect(
      reviewDocument(db, revokingCipher(ann.id, id), {
        documentId: id,
        viewer: as(ann),
        verdict: "approve",
        versionNumber: 1,
        note: "looks fine",
      }),
    ).rejects.toThrow("document_not_found");
    // Refused, not committed: the read-back view after a commit would also fail with document_not_found.
    expect(await stateOf(id)).toBe("in_review");
    expect((await db.documentReviewer.findFirstOrThrow({ where: { documentId: id } })).verdict).toBe("none");
    await expect(
      forceApprove(db, revokingCipher(cat.id, id), { documentId: id, viewer: as(cat), note: "Deadline" }),
    ).rejects.toThrow("document_not_found");
    expect(await stateOf(id)).toBe("in_review");
    expect((await eventsOf(id)).map((e) => e.kind)).toEqual(["submitted"]);
  });

  it("two concurrent approvals move the document to approved exactly once", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id, ben.id] });
    await Promise.all([
      reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 }),
      reviewDocument(db, cipher, { documentId: id, viewer: as(ben), verdict: "approve", versionNumber: 1 }),
    ]);
    expect(await stateOf(id)).toBe("approved");
    const into = (await eventsOf(id)).filter((e) => e.toState === "approved" && e.fromState !== "approved");
    expect(into).toHaveLength(1);
  });

  it("force approves over missing and changes-requested verdicts, with a required note, and records who it overrode", async () => {
    const id = await doc();
    await submitForReview(db, {
      documentId: id,
      viewer: as(owner),
      reviewers: [ann.id, ben.id],
      finalApproverId: cat.id,
    });
    await expect(forceApprove(db, cipher, { documentId: id, viewer: as(owner), note: "  " })).rejects.toThrow(
      "document_review_state_invalid",
    );
    await expect(forceApprove(db, cipher, { documentId: id, viewer: as(ann), note: "ship" })).rejects.toThrow(
      "document_review_forbidden",
    );
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "request_changes", versionNumber: 1 });
    const { view, overridden } = await forceApprove(db, cipher, { documentId: id, viewer: as(cat), note: "Deadline" });
    expect(view.state).toBe("approved");
    const rows = await db.documentReviewer.findMany({ where: { documentId: id } });
    expect(new Set(overridden)).toEqual(new Set(rows.map((r) => r.id)));
    expect(view.forced).toEqual({
      byName: "Cat Approver",
      versionNumber: 1,
      notes: expect.arrayContaining(["Ann Reviewer had requested changes on v1", "Ben Reviewer had not reviewed v1"]),
    });
    const force = (await eventsOf(id)).at(-1)!;
    expect(force).toMatchObject({ kind: "force_approved", note: "Deadline", actorPrincipalId: cat.id });
    expect(force.overridden).toEqual(overridden);
    // Force on a draft or an approved document is refused.
    await expect(forceApprove(db, cipher, { documentId: id, viewer: as(owner), note: "again" })).rejects.toThrow(
      "document_review_state_invalid",
    );
  });

  it("a removed reviewer is recomputed out: the rest decide", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id, ben.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    const v = await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    expect(v.state).toBe("approved");
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      kind: "reviewers_changed",
      fromState: "in_review",
      toState: "approved",
    });
  });

  it("reopen (writers only, approved only) then publish and re-approve", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await expect(reopenDocument(db, { documentId: id, viewer: as(owner) })).rejects.toThrow(
      "document_review_state_invalid",
    );
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    await expect(reopenDocument(db, { documentId: id, viewer: as(ann) })).rejects.toThrow("document_access_denied");
    expect((await reopenDocument(db, { documentId: id, viewer: as(owner) })).state).toBe("in_review");
    // The approval before the reopen does not count any more, even on the same version.
    const view = await getReviewView(db, id, as(owner));
    expect(view.reviewers[0]).toMatchObject({ verdict: "approved", versionNumber: 1, current: false });
    await publishVersion(db, cipher, { documentId: id, markdown: "v2", via: "mcp" });
    const v = await reviewDocument(db, cipher, {
      documentId: id,
      viewer: as(ann),
      verdict: "approve",
      versionNumber: 2,
    });
    expect(v.state).toBe("approved");
  });

  it("a verdict on the same version after a reopen counts; one before it does not", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    await reopenDocument(db, { documentId: id, viewer: as(owner) });
    const v = await reviewDocument(db, cipher, {
      documentId: id,
      viewer: as(ann),
      verdict: "approve",
      versionNumber: 1,
    });
    expect(v.state).toBe("approved");
    expect(v.reviewers[0]).toMatchObject({ verdict: "approved", versionNumber: 1, current: true });
    // The verdict and its event share one timestamp, after the reopen.
    const [row] = await db.documentReviewer.findMany({ where: { documentId: id } });
    const events = await eventsOf(id);
    const reopen = events.find((e) => e.kind === "reopened")!;
    expect(row.verdictAt?.getTime()).toBe(events.at(-1)!.createdAt.getTime());
    expect(row.verdictAt!.getTime()).toBeGreaterThan(reopen.createdAt.getTime());
  });

  it("the force banner does not report changes requested before a reopen as an overridden objection", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "request_changes", versionNumber: 1 });
    await forceApprove(db, cipher, { documentId: id, viewer: as(owner), note: "First" });
    await reopenDocument(db, { documentId: id, viewer: as(owner) });
    const { view } = await forceApprove(db, cipher, { documentId: id, viewer: as(owner), note: "Second" });
    expect(view.forced?.notes).toEqual(["Ann Reviewer had not reviewed v1"]);
  });

  it("archive and unarchive (owner only) return to the state before", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "request_changes", versionNumber: 1 });
    await expect(setArchived(db, { documentId: id, viewer: as(ann), archived: true })).rejects.toThrow(
      "document_access_denied",
    );
    expect((await setArchived(db, { documentId: id, viewer: as(owner), archived: true })).state).toBe("archived");
    await expect(
      reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 }),
    ).rejects.toThrow("document_review_state_invalid");
    await expect(setArchived(db, { documentId: id, viewer: as(owner), archived: true })).rejects.toThrow(
      "document_review_state_invalid",
    );
    expect((await setArchived(db, { documentId: id, viewer: as(owner), archived: false })).state).toBe(
      "changes_requested",
    );
    expect((await eventsOf(id)).slice(-2).map((e) => e.kind)).toEqual(["archived", "unarchived"]);
  });

  it("a view's permissions follow the viewer", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id], finalApproverId: cat.id });
    expect((await getReviewView(db, id, as(owner))).can).toEqual({
      submit: true,
      review: false,
      force: true,
      reopen: false,
      archive: true,
      unarchive: false,
    });
    expect((await getReviewView(db, id, as(ann))).can).toEqual({
      submit: false,
      review: true,
      force: false,
      reopen: false,
      archive: false,
      unarchive: false,
    });
    expect((await getReviewView(db, id, as(cat))).can.force).toBe(true);
    await expect(getReviewView(db, id, as(outsider))).rejects.toThrow("document_not_found");
  });

  it("redacts the agent's secret values from notes before they are stored; events carry no content", async () => {
    const id = await doc(true);
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id, ben.id] });
    await reviewDocument(db, cipher, {
      documentId: id,
      viewer: as(ann),
      verdict: "request_changes",
      versionNumber: 1,
      note: `key ${SECRET} leaks`,
    });
    await forceApprove(db, cipher, { documentId: id, viewer: as(owner), note: `ok ${SECRET}` });
    const rows = await db.documentReviewer.findMany({ where: { documentId: id } });
    const events = await eventsOf(id);
    const stored = JSON.stringify([rows, events]);
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("[REDACTED]");
    expect(stored).not.toContain("# Plan");
    expect(JSON.stringify(await getReviewView(db, id, as(owner)))).not.toContain(SECRET);
  });

  it("tells live pages about each review change (ids and kind only)", async () => {
    const id = await doc();
    const bus = createDocumentEventBus({ connectionString: process.env.DATABASE_URL! });
    const seen: DocumentEvent[] = [];
    const live = new Promise<void>((resolve) => bus.onState((up) => up && resolve()));
    const off = bus.subscribe((e) => {
      if (e.documentId === id) seen.push(e);
    });
    try {
      await live;
      await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
      await expect.poll(() => seen.map((e) => e.kind)).toContain("review");
    } finally {
      off();
      await bus.close();
    }
  });
});
