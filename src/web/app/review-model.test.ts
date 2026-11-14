import { describe, expect, it } from "vitest";
import type { ReviewPayload, ReviewerPayload } from "./api.js";
import { bannerText, newerNote, pendingLines, raceNote, reviewerChip, verdictLabels } from "./review-model.js";

const rv = (over: Partial<ReviewerPayload>): ReviewerPayload => ({
  id: "r",
  kind: "member",
  name: "Sam",
  verdict: "none",
  versionNumber: null,
  note: null,
  current: false,
  me: false,
  ...over,
});
const review = (over: Partial<ReviewPayload>): ReviewPayload => ({
  state: "in_review",
  currentVersion: 4,
  progress: { approved: 1, total: 2 },
  reviewers: [],
  finalApprover: null,
  forced: null,
  events: [],
  can: { submit: false, review: false, force: false, reopen: false, archive: false, unarchive: false },
  ...over,
});

describe("review model", () => {
  it("words the banner: state, version, progress; forced; draft and archived", () => {
    expect(bannerText(review({}))).toBe("In review · v4 · 1 of 2 approved");
    expect(bannerText(review({ state: "changes_requested" }))).toBe("Changes requested · v4 · 1 of 2 approved");
    expect(bannerText(review({ state: "draft", progress: { approved: 0, total: 0 } }))).toBe("Draft · v4");
    expect(bannerText(review({ state: "archived" }))).toBe("Archived · v4");
    expect(
      bannerText(
        review({
          state: "approved",
          forced: { byName: "Chris", versionNumber: 4, notes: ["Sam had not reviewed v4"] },
        }),
      ),
    ).toBe("Approved (forced by Chris) · Sam had not reviewed v4");
    expect(bannerText(review({ state: "approved", progress: { approved: 2, total: 2 } }))).toBe(
      "Approved · v4 · 2 of 2 approved",
    );
  });

  it("words each reviewer's chip", () => {
    expect(reviewerChip(rv({ verdict: "approved", versionNumber: 4, current: true }), 4)).toBe("Approved v4");
    expect(reviewerChip(rv({ verdict: "changes_requested", versionNumber: 3 }), 4)).toBe(
      "Changes requested v3 · older version",
    );
    expect(reviewerChip(rv({}), 4)).toBe("Waiting");
    expect(reviewerChip(rv({ verdict: "approved", versionNumber: 4, current: false }), 4)).toBe(
      "Approved v4 · before reopening",
    );
  });

  it("words the newer-version flow", () => {
    expect(newerNote(4, 5)).toBe("v5 was published while you were reviewing v4");
    expect(raceNote("approve", 5)).toBe(
      "v5 was published just before your approval, so it wasn't recorded. Here's what changed.",
    );
    expect(raceNote("request_changes", 5)).toBe(
      "v5 was published just before your request for changes, so it wasn't recorded. Here's what changed.",
    );
    expect(verdictLabels(5, false)).toEqual({ approve: "Approve", changes: "Request changes" });
    expect(verdictLabels(5, true)).toEqual({ approve: "Approve v5", changes: "Request changes on v5" });
  });

  it("lists who a force would override", () => {
    const r = review({
      reviewers: [
        rv({ name: "Ann", verdict: "approved", versionNumber: 4, current: true }),
        rv({ name: "Ben" }),
        rv({ name: "Cy", verdict: "changes_requested", versionNumber: 4, current: true }),
      ],
    });
    expect(pendingLines(r)).toEqual(["Ben has not reviewed v4", "Cy has requested changes on v4"]);
  });
});
