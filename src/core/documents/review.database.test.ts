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
import { restoreVersion } from "./versions.js";
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

  it("a repeat of the verdict that counts now changes nothing and writes no event", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id, ben.id] });
    const approve = (p: Principal, note?: string) =>
      reviewDocument(db, cipher, {
        documentId: id,
        viewer: as(p),
        verdict: "approve",
        versionNumber: 1,
        ...(note ? { note } : {}),
      });
    await approve(ann, "First");
    const [before] = await db.documentReviewer.findMany({ where: { documentId: id, principalId: ann.id } });
    const v = await approve(ann, "Second");
    expect(v.reviewers.find((r) => r.me)).toMatchObject({ verdict: "approved", versionNumber: 1, note: "First" });
    const [after] = await db.documentReviewer.findMany({ where: { documentId: id, principalId: ann.id } });
    expect(after.verdictAt?.getTime()).toBe(before.verdictAt?.getTime());
    expect((await eventsOf(id)).map((e) => e.kind)).toEqual(["submitted", "approved"]);
    // Approved: the approval that made it so, repeated, still changes nothing.
    await approve(ben);
    await approve(ben);
    expect(await stateOf(id)).toBe("approved");
    expect((await eventsOf(id)).map((e) => e.kind)).toEqual(["submitted", "approved", "approved"]);
    // Request changes twice: one event.
    const changes = () =>
      reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "request_changes", versionNumber: 1 });
    await changes();
    await changes();
    expect((await eventsOf(id)).map((e) => e.kind)).toEqual(["submitted", "approved", "approved", "changes_requested"]);
    // A reopen starts a new version, so the same verdict after it (on that version) is recorded.
    const id2 = await doc();
    await submitForReview(db, { documentId: id2, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id2, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    await reopenDocument(db, cipher, { documentId: id2, viewer: as(owner) });
    await reviewDocument(db, cipher, { documentId: id2, viewer: as(ann), verdict: "approve", versionNumber: 2 });
    expect((await eventsOf(id2)).map((e) => e.kind)).toEqual(["submitted", "approved", "reopened", "approved"]);
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
    await reopenDocument(db, cipher, { documentId: id, viewer: as(owner) });
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

  it("force rights follow the current owner, read inside the transaction", async () => {
    // A cipher that hands the document to Ben while the note is being redacted (after the early check).
    const transferringCipher = (documentId: string) => {
      let done = false;
      return {
        ...cipher,
        decrypt: async (v: string) => {
          if (!done) {
            done = true;
            await db.document.update({ where: { id: documentId }, data: { ownerId: ben.id } });
          }
          return v;
        },
      };
    };
    const id = await doc(true);
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await expect(
      forceApprove(db, transferringCipher(id), { documentId: id, viewer: as(owner), note: "Deadline" }),
    ).rejects.toThrow("document_not_found");
    expect(await stateOf(id)).toBe("in_review");
    // The new owner can force; the old one cannot.
    const { view } = await forceApprove(db, cipher, { documentId: id, viewer: as(ben), note: "Ship it" });
    expect(view.state).toBe("approved");
    expect((await eventsOf(id)).at(-1)).toMatchObject({ kind: "force_approved", actorPrincipalId: ben.id });
    await db.document.delete({ where: { id } });
  });

  it("force approve on a document deleted after the access check says document_not_found", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    // Deletes the document just before force approve reads its final approver (after the access check).
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "document") return Reflect.get(target, prop, receiver);
        return new Proxy(target.document, {
          get(model, name, r) {
            const real = Reflect.get(model, name, r) as (...a: unknown[]) => Promise<unknown>;
            if (name !== "findUnique" && name !== "findUniqueOrThrow") return real;
            return async (args: { select?: Record<string, boolean> }) => {
              if (args?.select?.finalApproverId && args.select.agentId) await target.document.delete({ where: { id } });
              return real.call(model, args);
            };
          },
        });
      },
    });
    await expect(forceApprove(racing, cipher, { documentId: id, viewer: as(owner), note: "Go" })).rejects.toThrow(
      /^document_not_found$/,
    );
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
    await expect(reopenDocument(db, cipher, { documentId: id, viewer: as(owner) })).rejects.toThrow(
      "document_review_state_invalid",
    );
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    // A reviewer without write access, and a guest, are told to ask a writer: a review refusal, not "no access".
    await expect(reopenDocument(db, cipher, { documentId: id, viewer: as(ann) })).rejects.toThrow(
      "document_review_forbidden",
    );
    const link = await createShareLink(db, { documentId: id, viewer: as(owner), permission: "comment" });
    const { guestId } = await registerGuest(db, { shareLinkId: link.id, name: "Gail" });
    const guest: Viewer = { kind: "guest", guestId, shareLinkId: link.id, permission: "comment" };
    await expect(reopenDocument(db, cipher, { documentId: id, viewer: guest })).rejects.toThrow(
      "document_review_forbidden",
    );
    expect(await db.documentVersion.count({ where: { documentId: id } })).toBe(1);
    const reopened = await reopenDocument(db, cipher, { documentId: id, viewer: as(owner) });
    expect([reopened.state, reopened.currentVersion]).toEqual(["in_review", 2]);
    // The approval of v1 is on an older version now.
    expect(reopened.reviewers[0]).toMatchObject({ verdict: "approved", versionNumber: 1, current: false });
    // A refused reopen wrote no version.
    await expect(reopenDocument(db, cipher, { documentId: id, viewer: as(owner) })).rejects.toThrow(
      "document_review_state_invalid",
    );
    expect(await db.documentVersion.count({ where: { documentId: id } })).toBe(2);
    await publishVersion(db, cipher, { documentId: id, markdown: "v3", via: "mcp" });
    const v = await reviewDocument(db, cipher, {
      documentId: id,
      viewer: as(ann),
      verdict: "approve",
      versionNumber: 3,
    });
    expect(v.state).toBe("approved");
  });

  it("reopen creates the next version, a copy of the approved one, and puts it in review", async () => {
    const id = await doc();
    await publishVersion(db, cipher, { documentId: id, markdown: "# Plan\n\nsecond", via: "mcp" });
    const { createThread } = await import("./comments.js");
    await createThread(db, cipher, {
      documentId: id,
      viewer: as(owner),
      anchor: { type: "text", quote: "second", prefix: "", suffix: "" },
      body: "Still open",
    });
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id, ben.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 2 });
    await forceApprove(db, cipher, { documentId: id, viewer: as(owner), note: "Ship" });
    const view = await reopenDocument(db, cipher, { documentId: id, viewer: as(owner) });
    expect([view.state, view.currentVersion, view.forced]).toEqual(["in_review", 3, null]);
    expect(view.progress).toEqual({ approved: 0, total: 2 });
    expect(view.can.review).toBe(false);
    const versions = await db.documentVersion.findMany({ where: { documentId: id }, orderBy: { number: "asc" } });
    expect(versions.map((v) => v.number)).toEqual([1, 2, 3]);
    const [v2, v3] = versions.slice(1);
    expect(v3).toMatchObject({
      markdown: v2.markdown,
      contentHash: v2.contentHash,
      format: "markdown",
      via: "review",
      summary: "Reopened for review from v2",
      createdById: owner.id,
      runId: null,
    });
    const docRow = await db.document.findUniqueOrThrow({ where: { id } });
    expect([docRow.currentVersionId, docRow.reviewState]).toEqual([v3.id, "in_review"]);
    // The content is the same, so every open thread keeps its anchor.
    expect((await db.commentThread.findMany({ where: { documentId: id } })).map((t) => t.status)).toEqual(["open"]);
    // v2 stays the approved record: its verdict and force events; the reopen is on v3.
    const events = await eventsOf(id);
    expect(events.map((e) => [e.kind, e.versionNumber, e.fromState, e.toState])).toEqual([
      ["submitted", 2, "draft", "in_review"],
      ["approved", 2, "in_review", "in_review"],
      ["force_approved", 2, "in_review", "approved"],
      ["reopened", 3, "approved", "in_review"],
    ]);
    // The next review action recomputes on v3: nothing given on v2 counts, so it stays in review.
    const after = await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id, ben.id] });
    expect(after.state).toBe("in_review");
  });

  it("reopening a design copies its files to the next version", async () => {
    const { readFileSync } = await import("node:fs");
    const coffee = (p: string) => readFileSync(new URL(`./boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
    const files = {
      "manifest.json": coffee("manifest.json"),
      ...Object.fromEntries(
        ["home", "menu", "about", "visit"].map((b) => [`boards/${b}.html`, coffee(`boards/${b}.html`)]),
      ),
    };
    const design = await createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "Coffee", files });
    await submitForReview(db, { documentId: design.id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: design.id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    const texts = await db.documentContent.count({ where: { documentId: design.id } });
    const { getDocument } = await import("./service.js");
    const approved = (await getDocument(db, design.id)).content;
    const view = await reopenDocument(db, cipher, { documentId: design.id, viewer: as(owner) });
    expect([view.state, view.currentVersion]).toEqual(["in_review", 2]);
    const current = await getDocument(db, design.id);
    expect(current.version).toMatchObject({ number: 2, via: "review", summary: "Reopened for review from v1" });
    expect(current.content).toEqual(approved);
    expect(Object.keys(approved.format === "boards-v1" ? approved.files : {}).sort()).toEqual(
      Object.keys(files).sort(),
    );
    const [v1, v2] = await db.documentVersion.findMany({
      where: { documentId: design.id },
      orderBy: { number: "asc" },
    });
    expect(v2.contentHash).toBe(v1.contentHash);
    // The text is shared, not stored again.
    expect(await db.documentContent.count({ where: { documentId: design.id } })).toBe(texts);
  });

  it("a publish racing a reopen never lands on the approved version", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    const [reopen, publish] = await Promise.allSettled([
      reopenDocument(db, cipher, { documentId: id, viewer: as(owner) }),
      publishVersion(db, cipher, { documentId: id, markdown: "racing", via: "editor", expectedNumber: 1 }),
    ]);
    expect(reopen.status).toBe("fulfilled");
    // Refused as locked (before the reopen) or as stale (after it: v2 is the reopen's copy).
    expect(publish.status).toBe("rejected");
    expect(String((publish as PromiseRejectedResult).reason)).toMatch(/document_locked|document_version_conflict/);
    const versions = await db.documentVersion.findMany({ where: { documentId: id }, orderBy: { number: "asc" } });
    expect(versions.map((v) => [v.number, v.via])).toEqual([
      [1, "editor"],
      [2, "review"],
    ]);
  });

  it("a verdict on the approved version after a reopen is stale; one on the new version counts", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    await reopenDocument(db, cipher, { documentId: id, viewer: as(owner) });
    await expect(
      reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 }),
    ).rejects.toThrow(ReviewVersionConflictError);
    const v = await reviewDocument(db, cipher, {
      documentId: id,
      viewer: as(ann),
      verdict: "approve",
      versionNumber: 2,
    });
    expect(v.state).toBe("approved");
    expect(v.reviewers[0]).toMatchObject({ verdict: "approved", versionNumber: 2, current: true });
  });

  it("the force banner does not report changes requested before a reopen as an overridden objection", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "request_changes", versionNumber: 1 });
    await forceApprove(db, cipher, { documentId: id, viewer: as(owner), note: "First" });
    await reopenDocument(db, cipher, { documentId: id, viewer: as(owner) });
    const { view } = await forceApprove(db, cipher, { documentId: id, viewer: as(owner), note: "Second" });
    expect(view.forced?.notes).toEqual(["Ann Reviewer had not reviewed v2"]);
  });

  it("a force approval is final: a reviewer cannot request changes, and can.review is false", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id, ben.id] });
    await forceApprove(db, cipher, { documentId: id, viewer: as(owner), note: "Ship" });
    await expect(
      reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "request_changes", versionNumber: 1 }),
    ).rejects.toThrow("document_review_state_invalid");
    expect(await stateOf(id)).toBe("approved");
    expect((await getReviewView(db, id, as(ann))).can.review).toBe(false);
    // A writer reopens it for review.
    expect((await reopenDocument(db, cipher, { documentId: id, viewer: as(owner) })).state).toBe("in_review");
  });

  it("an approval by every reviewer is not final: a reviewer may still request changes, which unlocks it", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    expect(await stateOf(id)).toBe("approved");
    expect((await getReviewView(db, id, as(ann))).can.review).toBe(true);
    const view = await reviewDocument(db, cipher, {
      documentId: id,
      viewer: as(ann),
      verdict: "request_changes",
      versionNumber: 1,
    });
    expect(view.state).toBe("changes_requested");
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
    // Archive and unarchive write no version.
    expect(await db.documentVersion.count({ where: { documentId: id } })).toBe(1);
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

  it("reopen redacts a value that became an agent secret after the approved version was published", async () => {
    const id = (
      await createDocument(db, cipher, { ownerId: owner.id, title: "Plan", markdown: `# Plan\n\nkey ${SECRET} end` })
    ).id;
    await db.document.update({ where: { id }, data: { agentId } });
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    await reopenDocument(db, cipher, { documentId: id, viewer: as(owner) });
    const versions = await db.documentVersion.findMany({ where: { documentId: id }, orderBy: { number: "asc" } });
    expect(versions.map((v) => v.number)).toEqual([1, 2]);
    expect(versions[0].markdown).toContain(SECRET);
    expect(versions[1].markdown).not.toContain(SECRET);
    expect(versions[1].markdown).toContain("[REDACTED]");
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
      // A reopen writes a version too: open pages load it.
      await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
      seen.length = 0;
      await reopenDocument(db, cipher, { documentId: id, viewer: as(owner) });
      await expect.poll(() => [...new Set(seen.map((e) => e.kind))].sort()).toEqual(["review", "version"]);
      expect(seen.every((e) => Object.keys(e).sort().join() === "documentId,kind")).toBe(true);
    } finally {
      off();
      await bus.close();
    }
  });

  it("an approved or archived document takes no new version: publish and restore are refused", async () => {
    const id = await doc();
    await publishVersion(db, cipher, { documentId: id, markdown: "v2", via: "mcp" });
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 2 });
    for (const attempt of [
      () => publishVersion(db, cipher, { documentId: id, markdown: "v3", via: "editor", expectedNumber: 2 }),
      () => publishVersion(db, cipher, { documentId: id, markdown: "v3", via: "mcp" }),
      () => publishVersion(db, cipher, { documentId: id, markdown: "v3", via: "agent", runId: "r", expectedNumber: 2 }),
      () => restoreVersion(db, cipher, { documentId: id, viewer: as(owner), number: 1, baseNumber: 2, via: "editor" }),
    ]) {
      await expect(attempt()).rejects.toThrow("document_locked");
    }
    await setArchived(db, { documentId: id, viewer: as(owner), archived: true });
    await expect(publishVersion(db, cipher, { documentId: id, markdown: "v3", via: "mcp" })).rejects.toThrow(
      "document_locked",
    );
    expect(await db.documentVersion.count({ where: { documentId: id } })).toBe(2);
    // Comments stay open in every state.
    const { createThread } = await import("./comments.js");
    await expect(
      createThread(db, cipher, {
        documentId: id,
        viewer: as(owner),
        anchor: { type: "text", quote: "v2", prefix: "", suffix: "" },
        body: "still commentable",
      }),
    ).resolves.toBeTruthy();
  });

  it("a design's board save is refused on an approved design before any file text is stored", async () => {
    const { readFileSync } = await import("node:fs");
    const coffee = (p: string) => readFileSync(new URL(`./boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
    const all = () => ({
      "manifest.json": coffee("manifest.json"),
      ...Object.fromEntries(
        ["home", "menu", "about", "visit"].map((b) => [`boards/${b}.html`, coffee(`boards/${b}.html`)]),
      ),
    });
    const design = await createDocument(db, cipher, {
      kind: "design",
      ownerId: owner.id,
      title: "Coffee",
      files: all(),
    });
    await submitForReview(db, { documentId: design.id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: design.id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
    const before = await db.documentContent.count({ where: { documentId: design.id } });
    await expect(
      publishVersion(db, cipher, {
        documentId: design.id,
        files: { ...all(), "boards/home.html": coffee("boards/home.html").replace("</body>", "<p>new</p></body>") },
        via: "editor",
        expectedNumber: 1,
      }),
    ).rejects.toThrow("document_locked");
    expect(await db.documentContent.count({ where: { documentId: design.id } })).toBe(before);
  });

  it("a publish while in review recomputes: changes requested on v1 becomes in_review on v2", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "request_changes", versionNumber: 1 });
    expect(await stateOf(id)).toBe("changes_requested");
    await publishVersion(db, cipher, { documentId: id, markdown: "fixed", via: "mcp" });
    expect(await stateOf(id)).toBe("in_review");
    const v = await getReviewView(db, id, as(owner));
    expect(v.reviewers[0]).toMatchObject({ verdict: "changes_requested", versionNumber: 1, current: false });
  });

  it("a document approved after publish's early check is refused inside the transaction", async () => {
    // A cipher that approves while the agent's secret values are read (after the early check, before
    // the transaction), so only the check inside the transaction can refuse the publish.
    const id = await doc(true);
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    let approved = false;
    const approvingCipher = {
      ...cipher,
      decrypt: async (v: string) => {
        if (!approved) {
          approved = true;
          await reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 });
        }
        return v;
      },
    };
    await expect(
      publishVersion(db, approvingCipher, { documentId: id, markdown: "late", via: "mcp", expectedNumber: 1 }),
    ).rejects.toThrow("document_locked");
    expect(approved).toBe(true);
    expect(await stateOf(id)).toBe("approved");
    expect(await db.documentVersion.count({ where: { documentId: id } })).toBe(1);
  });

  it("an approval racing a publish: exactly one wins", async () => {
    const id = await doc();
    await submitForReview(db, { documentId: id, viewer: as(owner), reviewers: [ann.id] });
    const results = await Promise.allSettled([
      reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber: 1 }),
      publishVersion(db, cipher, { documentId: id, markdown: "racing", via: "mcp", expectedNumber: 1 }),
    ]);
    const versions = await db.documentVersion.count({ where: { documentId: id } });
    const state = await stateOf(id);
    // Either the approval landed first (approved, publish refused) or the publish did (v2, approval stale).
    expect([state, versions]).toEqual(results[0].status === "fulfilled" ? ["approved", 1] : ["in_review", 2]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
