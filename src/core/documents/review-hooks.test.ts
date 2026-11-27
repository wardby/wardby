import { afterEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "#prisma";
import { setPlanReviewHook } from "../plans/approval.js";
import { runReviewHooks, setReviewActionHook } from "./review-hooks.js";

const db = {} as PrismaClient;

describe("runReviewHooks", () => {
  afterEach(() => {
    setPlanReviewHook(undefined);
    setReviewActionHook(undefined);
  });

  it("calls the plan hook, then the action hook, with the action's arguments", async () => {
    const calls: unknown[][] = [];
    setPlanReviewHook(async (_db, documentId, actorId) => void calls.push(["plan", documentId, actorId]));
    setReviewActionHook(async (_db, action) => void calls.push(["action", action]));
    await runReviewHooks(db, { documentId: "d1", eventIds: ["e1", "e2"], actorId: "p1" });
    expect(calls).toEqual([
      ["plan", "d1", "p1"],
      ["action", { documentId: "d1", eventIds: ["e1", "e2"], actorId: "p1" }],
    ]);
  });

  it("tells the action hook when the plan hook claimed the plan set's approval for this action", async () => {
    const seen: unknown[] = [];
    setReviewActionHook(async (_db, action) => void seen.push(action.planApprovalClaimed));
    for (const approvalClaimed of [true, false]) {
      setPlanReviewHook(async () => ({ approvalClaimed }));
      await runReviewHooks(db, { documentId: "d1", eventIds: ["e1"], actorId: null });
    }
    expect(seen).toEqual([true, undefined]);
  });

  it("does not throw when the action hook throws", async () => {
    setReviewActionHook(async () => {
      throw new Error("boom");
    });
    await expect(runReviewHooks(db, { documentId: "d1", eventIds: [], actorId: null })).resolves.toBeUndefined();
  });
});
