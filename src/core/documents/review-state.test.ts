import { describe, expect, it } from "vitest";
import {
  approvedCount,
  computeReviewState,
  forceCounts,
  isLocked,
  overriddenReviewerIds,
  overrideSentence,
  type RuleInput,
  type RuleReviewer,
} from "./review-state.js";

const t = (s: number) => new Date(Date.UTC(2026, 10, 14, 12, 0, s));
const r = (id: string, verdict: RuleReviewer["verdict"], versionNumber: number | null, at = 1): RuleReviewer => ({
  id,
  verdict,
  versionNumber,
  verdictAt: verdict === "none" ? null : t(at),
});
const input = (over: Partial<RuleInput>): RuleInput => ({
  currentVersion: 4,
  reviewers: [],
  force: null,
  ...over,
});

describe("review state rule", () => {
  it("locks approved, rejected and archived only", () => {
    expect(["draft", "in_review", "changes_requested", "approved", "rejected", "archived"].map(isLocked)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it("is in_review until every reviewer approved the current version", () => {
    expect(computeReviewState(input({ reviewers: [r("a", "none", null), r("b", "approved", 4)] }))).toBe("in_review");
    expect(computeReviewState(input({ reviewers: [r("a", "approved", 4), r("b", "approved", 4)] }))).toBe("approved");
  });

  it("counts verdicts on the current version only: an approval on v3 is waiting on v4", () => {
    const i = input({ reviewers: [r("a", "approved", 3), r("b", "approved", 4)] });
    expect(computeReviewState(i)).toBe("in_review");
    expect(approvedCount(i)).toBe(1);
  });

  it("changes requested on the current version wins over approvals; on an older version it does not count", () => {
    expect(computeReviewState(input({ reviewers: [r("a", "changes_requested", 4), r("b", "approved", 4)] }))).toBe(
      "changes_requested",
    );
    expect(computeReviewState(input({ reviewers: [r("a", "changes_requested", 3), r("b", "approved", 4)] }))).toBe(
      "in_review",
    );
  });

  it("a force on the current version approves over anything; a force on an older version does not", () => {
    const reviewers = [r("a", "changes_requested", 4), r("b", "none", null)];
    expect(computeReviewState(input({ reviewers, force: { versionNumber: 4, at: t(5) } }))).toBe("approved");
    expect(computeReviewState(input({ reviewers, force: { versionNumber: 3, at: t(5) } }))).toBe("changes_requested");
  });

  it("a removed reviewer no longer counts: the rest decide", () => {
    expect(computeReviewState(input({ reviewers: [r("b", "approved", 4)] }))).toBe("approved");
  });

  it("no reviewers is in_review (submit refuses an empty list before this)", () => {
    expect(computeReviewState(input({ reviewers: [] }))).toBe("in_review");
  });

  it("after a reopen (a new version), the approvals and force on the approved version stop counting", () => {
    const approved = input({
      reviewers: [r("a", "approved", 4), r("b", "approved", 4)],
      force: { versionNumber: 4, at: t(5) },
    });
    expect(computeReviewState(approved)).toBe("approved");
    const reopened = { ...approved, currentVersion: 5 };
    expect(computeReviewState(reopened)).toBe("in_review");
    expect(forceCounts(reopened)).toBe(false);
  });

  it("lists who a force overrides: missing, older and changes-requested verdicts", () => {
    const i = input({
      reviewers: [r("a", "approved", 4), r("b", "none", null), r("c", "approved", 3), r("d", "changes_requested", 4)],
    });
    expect(overriddenReviewerIds(i)).toEqual(["b", "c", "d"]);
  });

  it("words each override for the banner", () => {
    expect(overrideSentence("Sam", { verdict: "none", versionNumber: null }, 4)).toBe("Sam had not reviewed v4");
    expect(overrideSentence("Sam", { verdict: "approved", versionNumber: 3 }, 4)).toBe("Sam had not reviewed v4");
    expect(overrideSentence("Sam", { verdict: "changes_requested", versionNumber: 4 }, 4)).toBe(
      "Sam had requested changes on v4",
    );
    expect(overrideSentence(null, null, 4)).toBe("A removed reviewer had not reviewed v4");
  });
});
