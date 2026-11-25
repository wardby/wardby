/**
 * Rejecting a document of a plan set (review.ts rejectDocument) against real PostgreSQL: the document
 * leaves the plan (it stops counting and is not built from), only plan documents other than plan.md can
 * be rejected, a note is required, and reopen brings it back. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { setPlanReviewHook } from "../plans/approval.js";
import { resolveBuildPlan } from "../plans/build.js";
import { createPlanSetFixture } from "../plans/build.test-support.js";
import {
  chooseOption,
  getReviewView,
  rejectDocument,
  reopenDocument,
  ReviewVersionConflictError,
  reviewDocument,
  submitForReview,
} from "./review.js";

const PLAN_MD = "# Plan\n\n## Tickets\n### Ticket 1: Build it\n\nScope.\n";
const design = (title: string) => ({
  "manifest.json": JSON.stringify({ title, boards: [{ id: "home", name: "Home", file: "boards/home.html" }] }),
  "boards/home.html": `<main>${title}</main>`,
});

describe.skipIf(!process.env.DATABASE_URL)("rejectDocument (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID().slice(0, 8);
  const repository = `o/reject-${s}`;
  const owner = `reject-owner-${s}`;
  const outsider = `reject-outsider-${s}`;
  const reviewer = `reject-reviewer-${s}`;
  const approver = `reject-approver-${s}`;
  const commenter = `reject-commenter-${s}`;
  const as = (principalId: string) => ({ kind: "principal" as const, principalId });
  const agents: string[] = [];
  let planner: string;
  let builder: string;
  let nextNumber = 500;
  const asOwner = { kind: "principal" as const, principalId: owner };

  /** plan.md and two approved design options, plus a third option still in review. */
  async function planSet() {
    const number = ++nextNumber;
    const fixture = await createPlanSetFixture(db, {
      plannerId: planner,
      ownerId: owner,
      repository,
      number,
      documents: [
        { path: "plan.md", content: PLAN_MD, version: 1 },
        { path: "option-a/", content: design("A"), version: 1 },
        { path: "option-b/", content: design("B"), version: 1 },
        { path: "option-c/", content: design("C"), version: 1, reviewState: "in_review" },
      ],
    });
    return { ...fixture, number };
  }
  const resolve = (number: number) =>
    resolveBuildPlan(db, cipher, { builderAgentId: builder, builderOwnerId: owner, repository, number });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    for (const id of [outsider, reviewer, approver, commenter])
      await db.principal.create({ data: { id, subject: id } });
    for (const profile of [{ planDocument: { store: "wardby", reviewers: [owner] } }, { buildFromPlan: true }]) {
      const agent = await db.agent.create({
        data: {
          name: `reject-${s}-${agents.length}`,
          systemPrompt: "p",
          model: "m",
          budgetUsd: 1,
          ownerId: owner,
          kind: "coding",
          codingProfile: { create: { repository, protectedPaths: [], ...profile } },
        },
      });
      agents.push(agent.id);
    }
    [planner, builder] = agents;
  });
  afterEach(() => setPlanReviewHook(undefined));
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner } });
    await db.planSet.deleteMany({ where: { agentId: { in: agents } } });
    await db.agent.deleteMany({ where: { id: { in: agents } } });
    await db.resourceGrant.deleteMany({ where: { granteePrincipalId: { in: [reviewer, approver, commenter] } } });
    await db.principal.deleteMany({ where: { id: { in: [owner, outsider, reviewer, approver, commenter] } } });
    await db.$disconnect();
  });

  it("takes an approved option out of the plan: rejected, locked, a `rejected` event with the note", async () => {
    const { documentIds } = await planSet();
    const view = await rejectDocument(db, cipher, {
      documentId: documentIds["option-a/"],
      viewer: asOwner,
      note: "Option B was chosen",
    });
    expect(view.state).toBe("rejected");
    expect(view.events[0]).toMatchObject({ kind: "rejected", fromState: "approved", toState: "rejected" });
    expect(view.events[0].note).toBe("Option B was chosen");
    expect(view.can).toMatchObject({ reject: false, reopen: true });
    const row = await db.document.findUniqueOrThrow({ where: { id: documentIds["option-a/"] } });
    expect(row).toMatchObject({ reviewState: "rejected", removedFromPlan: true });
  });

  it("never gives a rejected option to the builder, and its rejection lets the plan be built", async () => {
    const { number, documentIds } = await planSet();
    // option-c is still in review: the gate refuses.
    await expect(resolve(number)).rejects.toThrow(/^plan_not_approved: .*option-c/);
    await rejectDocument(db, cipher, { documentId: documentIds["option-c/"], viewer: asOwner, note: "not chosen" });
    await rejectDocument(db, cipher, { documentId: documentIds["option-a/"], viewer: asOwner, note: "not chosen" });
    const plan = await resolve(number);
    expect(plan?.versions.map((v) => v.path)).toEqual(["plan.md", "option-b/"]);
    expect(plan?.planInputFiles.map((f) => f.path).sort()).toEqual([
      "option-b/boards/home.html",
      "option-b/manifest.json",
      "plan.md",
    ]);
  });

  it("calls the plan review hook, so rejecting the last waiting document completes the approval", async () => {
    const { documentIds } = await planSet();
    const calls: Array<[string, string | null]> = [];
    setPlanReviewHook(async (_db, documentId, actor) => {
      calls.push([documentId, actor]);
    });
    await rejectDocument(db, cipher, { documentId: documentIds["option-c/"], viewer: asOwner, note: "not chosen" });
    expect(calls).toEqual([[documentIds["option-c/"], owner]]);
  });

  it("refuses plan.md, a document outside a plan, and a document already out of the plan", async () => {
    const { documentIds } = await planSet();
    await expect(
      rejectDocument(db, cipher, { documentId: documentIds["plan.md"], viewer: asOwner, note: "no" }),
    ).rejects.toThrow("document_reject_not_plan_document");
    const loose = await db.document.create({ data: { title: "loose", ownerId: owner, reviewState: "in_review" } });
    await expect(rejectDocument(db, cipher, { documentId: loose.id, viewer: asOwner, note: "no" })).rejects.toThrow(
      "document_reject_not_plan_document",
    );
    await rejectDocument(db, cipher, { documentId: documentIds["option-a/"], viewer: asOwner, note: "no" });
    await expect(
      rejectDocument(db, cipher, { documentId: documentIds["option-a/"], viewer: asOwner, note: "again" }),
    ).rejects.toThrow("document_reject_not_plan_document");
  });

  it("needs a note, and refuses someone who can't see the document", async () => {
    const { documentIds } = await planSet();
    await expect(
      rejectDocument(db, cipher, { documentId: documentIds["option-a/"], viewer: asOwner, note: "  " }),
    ).rejects.toThrow("document_review_state_invalid");
    await expect(
      rejectDocument(db, cipher, {
        documentId: documentIds["option-a/"],
        viewer: { kind: "principal", principalId: outsider },
        note: "no",
      }),
    ).rejects.toThrow("document_not_found");
  });

  it("offers Reject on a plan option, never on plan.md", async () => {
    const { documentIds } = await planSet();
    expect((await getReviewView(db, documentIds["option-a/"], asOwner)).can.reject).toBe(true);
    expect((await getReviewView(db, documentIds["plan.md"], asOwner)).can.reject).toBe(false);
  });

  it("reopen brings a rejected document back into the plan, on a new version, in review", async () => {
    const { number, documentIds } = await planSet();
    await rejectDocument(db, cipher, { documentId: documentIds["option-c/"], viewer: asOwner, note: "not chosen" });
    const view = await reopenDocument(db, cipher, { documentId: documentIds["option-c/"], viewer: asOwner });
    expect(view.state).toBe("in_review");
    expect(view.currentVersion).toBe(2);
    expect(view.events[0]).toMatchObject({ kind: "reopened", fromState: "rejected", toState: "in_review" });
    const row = await db.document.findUniqueOrThrow({ where: { id: documentIds["option-c/"] } });
    expect(row.removedFromPlan).toBe(false);
    // Back in the plan and waiting again: the builder's gate refuses.
    await expect(resolve(number)).rejects.toThrow(/^plan_not_approved: .*option-c/);
  });

  /** option-c in review with a named reviewer and a final approver, and a plain commenter who is neither. */
  async function reviewedOption() {
    const set = await planSet();
    const id = set.documentIds["option-c/"];
    await submitForReview(db, { documentId: id, viewer: asOwner, reviewers: [reviewer], finalApproverId: approver });
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: id,
        granteeKind: "principal",
        granteePrincipalId: commenter,
        granteeKey: `principal:${commenter}`,
        level: "comment",
      },
    });
    return { ...set, id };
  }

  it("a named member reviewer may reject, and is offered Reject", async () => {
    const { id } = await reviewedOption();
    expect((await getReviewView(db, id, as(reviewer))).can.reject).toBe(true);
    const view = await rejectDocument(db, cipher, { documentId: id, viewer: as(reviewer), note: "B chosen" });
    expect(view.state).toBe("rejected");
  });

  it("the final approver may reject even when not a reviewer", async () => {
    const { id } = await reviewedOption();
    expect((await getReviewView(db, id, as(approver))).can.reject).toBe(true);
    const view = await rejectDocument(db, cipher, { documentId: id, viewer: as(approver), note: "B chosen" });
    expect(view.state).toBe("rejected");
  });

  it("a commenter who is neither reviewer nor final approver is refused, and not offered Reject", async () => {
    const { id } = await reviewedOption();
    expect((await getReviewView(db, id, as(commenter))).can.reject).toBe(false);
    await expect(rejectDocument(db, cipher, { documentId: id, viewer: as(commenter), note: "no" })).rejects.toThrow(
      "document_review_forbidden",
    );
  });

  it("rejects from changes requested", async () => {
    const { id } = await reviewedOption();
    await reviewDocument(db, cipher, {
      documentId: id,
      viewer: as(reviewer),
      verdict: "request_changes",
      versionNumber: 1,
    });
    expect((await getReviewView(db, id, asOwner)).state).toBe("changes_requested");
    const view = await rejectDocument(db, cipher, { documentId: id, viewer: asOwner, note: "dropped" });
    expect(view.events[0]).toMatchObject({ kind: "rejected", fromState: "changes_requested", toState: "rejected" });
  });

  it("rejecting an option of an already approved plan leaves the plan approved and buildable", async () => {
    const { number, documentIds } = await planSet();
    await rejectDocument(db, cipher, { documentId: documentIds["option-c/"], viewer: asOwner, note: "dropped" });
    expect((await resolve(number))?.versions.map((v) => v.path)).toEqual(["plan.md", "option-a/", "option-b/"]);
    await rejectDocument(db, cipher, { documentId: documentIds["option-a/"], viewer: asOwner, note: "dropped" });
    expect((await resolve(number))?.versions.map((v) => v.path)).toEqual(["plan.md", "option-b/"]);
  });

  describe("chooseOption", () => {
    /** plan.md approved; options a, b and c in review with the owner as their reviewer. */
    async function optionsInReview() {
      const number = ++nextNumber;
      const fixture = await createPlanSetFixture(db, {
        plannerId: planner,
        ownerId: owner,
        repository,
        number,
        documents: [
          { path: "plan.md", content: PLAN_MD, version: 1 },
          { path: "option-a/", content: design("A"), version: 1, reviewState: "draft" },
          { path: "option-b/", content: design("B"), version: 1, reviewState: "draft" },
          { path: "option-c/", content: design("C"), version: 1, reviewState: "draft" },
        ],
      });
      for (const path of ["option-a/", "option-b/", "option-c/"]) {
        await submitForReview(db, { documentId: fixture.documentIds[path], viewer: asOwner, reviewers: [owner] });
      }
      return { ...fixture, number, ids: fixture.documentIds };
    }
    const state = async (id: string) =>
      db.document.findUniqueOrThrow({ where: { id }, select: { reviewState: true, removedFromPlan: true } });

    it("approves the chosen option and rejects the others in one go, so the plan can be built", async () => {
      const { number, ids } = await optionsInReview();
      const calls: string[] = [];
      setPlanReviewHook(async (_db, documentId) => {
        calls.push(documentId);
      });
      expect((await getReviewView(db, ids["option-a/"], asOwner)).can.choose).toBe(true);
      const out = await chooseOption(db, cipher, {
        documentId: ids["option-a/"],
        viewer: asOwner,
        versionNumber: 1,
        reject: [ids["option-b/"], ids["option-c/"]],
      });
      expect(out.view.state).toBe("approved");
      expect(out.rejected).toEqual([ids["option-b/"], ids["option-c/"]]);
      for (const path of ["option-b/", "option-c/"]) {
        expect(await state(ids[path])).toEqual({ reviewState: "rejected", removedFromPlan: true });
        const v = await getReviewView(db, ids[path], asOwner);
        expect(v.events[0]).toMatchObject({ kind: "rejected", note: "Chose option-a/" });
      }
      // The hook runs once, after everything is committed.
      expect(calls).toEqual([ids["option-a/"]]);
      expect((await resolve(number))?.versions.map((v) => v.path)).toEqual(["plan.md", "option-a/"]);
    });

    it("adds the viewer's note, and keeps an already approved choice as it is", async () => {
      const { ids } = await optionsInReview();
      await reviewDocument(db, cipher, {
        documentId: ids["option-a/"],
        viewer: asOwner,
        verdict: "approve",
        versionNumber: 1,
      });
      const before = (await getReviewView(db, ids["option-a/"], asOwner)).events.length;
      const out = await chooseOption(db, cipher, {
        documentId: ids["option-a/"],
        viewer: asOwner,
        versionNumber: 1,
        reject: [ids["option-c/"]],
        note: "simplest on a phone",
      });
      expect(out.view.events).toHaveLength(before);
      expect((await getReviewView(db, ids["option-c/"], asOwner)).events[0].note).toBe(
        "Chose option-a/: simplest on a phone",
      );
      expect((await state(ids["option-b/"])).reviewState).toBe("in_review");
    });

    it("changes nothing when any part is refused: plan.md, another plan's document, a stale version", async () => {
      const { ids } = await optionsInReview();
      const other = await optionsInReview();
      const attempts: Array<[string[], number, string | RegExp | typeof ReviewVersionConflictError]> = [
        [[ids["option-b/"], ids["plan.md"]], 1, "document_reject_not_plan_document"],
        [[ids["option-b/"], other.ids["option-b/"]], 1, "document_reject_not_plan_document"],
        [[ids["option-b/"]], 2, ReviewVersionConflictError],
      ];
      for (const [reject, versionNumber, error] of attempts) {
        await expect(
          chooseOption(db, cipher, { documentId: ids["option-a/"], viewer: asOwner, versionNumber, reject }),
        ).rejects.toThrow(error);
      }
      for (const path of ["option-a/", "option-b/", "option-c/"]) {
        expect(await state(ids[path])).toEqual({ reviewState: "in_review", removedFromPlan: false });
      }
      expect((await state(other.ids["option-b/"])).reviewState).toBe("in_review");
    });

    it("refuses an empty list, the chosen document in its own list, and plan.md as the choice", async () => {
      const { ids } = await optionsInReview();
      const choose = (documentId: string, reject: string[]) =>
        chooseOption(db, cipher, { documentId, viewer: asOwner, versionNumber: 1, reject });
      await expect(choose(ids["option-a/"], [])).rejects.toThrow("document_review_state_invalid");
      await expect(choose(ids["option-a/"], [ids["option-a/"]])).rejects.toThrow("document_review_state_invalid");
      await expect(choose(ids["plan.md"], [ids["option-b/"]])).rejects.toThrow("document_reject_not_plan_document");
      expect((await getReviewView(db, ids["plan.md"], asOwner)).can.choose).toBe(false);
    });

    it("needs the right to approve the choice: a commenter is refused and not offered it", async () => {
      const { id } = await reviewedOption();
      const set = await db.document.findUniqueOrThrow({ where: { id }, select: { planSetId: true } });
      const b = await db.document.findFirstOrThrow({ where: { planSetId: set.planSetId, planPath: "option-b/" } });
      expect((await getReviewView(db, id, as(commenter))).can.choose).toBe(false);
      await expect(
        chooseOption(db, cipher, { documentId: id, viewer: as(commenter), versionNumber: 1, reject: [b.id] }),
      ).rejects.toThrow("document_review_forbidden");
      // The named reviewer of option-c is offered it, but cannot reject option-b, which they cannot see: the
      // whole choice is refused, and option-c is not approved either.
      expect((await getReviewView(db, id, as(reviewer))).can.choose).toBe(true);
      const choose = () =>
        chooseOption(db, cipher, { documentId: id, viewer: as(reviewer), versionNumber: 1, reject: [b.id] });
      await expect(choose()).rejects.toThrow("document_not_found");
      expect((await state(id)).reviewState).toBe("in_review");
      // Once they review option-b too (back in review, with them as its reviewer), the choice goes through.
      await db.document.update({ where: { id: b.id }, data: { reviewState: "in_review" } });
      await submitForReview(db, { documentId: b.id, viewer: asOwner, reviewers: [reviewer] });
      await choose();
      expect((await state(id)).reviewState).toBe("approved");
      expect((await state(b.id)).reviewState).toBe("rejected");
    });
  });
});
