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
import { getReviewView, rejectDocument, reopenDocument } from "./review.js";

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
    await db.principal.create({ data: { id: outsider, subject: outsider } });
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
    await db.principal.deleteMany({ where: { id: { in: [owner, outsider] } } });
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
});
