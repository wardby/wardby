import { describe, expect, it } from "vitest";
import type { ReviewPayload, ReviewerPayload } from "./api.js";
import {
  bannerText,
  isReopenCopy,
  myCurrentVerdict,
  newerNote,
  pendingLines,
  raceNote,
  reviewerChip,
  verdictControls,
  verdictLabels,
  EVENT_LABEL,
  isLockedState,
  STATE_LABEL,
  chooseCandidates,
  optionFamily,
  optionSets,
  optionSetWords,
  planAlternatives,
} from "./review-model.js";

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
  it("knows a reopen's copy: the version right after the shown one, named by a reopened event", () => {
    const ev = (kind: string, versionNumber: number) => ({
      id: kind,
      kind,
      actorName: "Chris",
      fromState: "approved" as const,
      toState: "in_review" as const,
      versionNumber,
      note: null,
      createdAt: "2026-11-14T00:00:00Z",
    });
    const reopened = review({ currentVersion: 5, events: [ev("reopened", 5), ev("approved", 4)] });
    expect(isReopenCopy(reopened, 4, 5)).toBe(true);
    // Not right after the shown version, or no reopen names it: a real newer version.
    expect(isReopenCopy(reopened, 3, 5)).toBe(false);
    expect(isReopenCopy(review({ events: [ev("approved", 5)] }), 4, 5)).toBe(false);
    expect(isReopenCopy(review({ events: [ev("reopened", 4)] }), 4, 5)).toBe(false);
  });

  it("words the banner: state, version, progress; forced; draft and archived", () => {
    expect(bannerText(review({}))).toBe("In review · v4 · 1 of 2 approved");
    expect(bannerText(review({ state: "changes_requested" }))).toBe("Changes requested · v4 · 1 of 2 approved");
    expect(bannerText(review({ state: "draft", progress: { approved: 0, total: 0 } }))).toBe("Draft · v4");
    expect(bannerText(review({ state: "archived" }))).toBe("Archived · v4");
    // Rejected: the state and version only; the reviewers' progress no longer means anything.
    expect(bannerText(review({ state: "rejected" }))).toBe("Rejected · v4");
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

  it("names the rejected state and event, and counts it as locked", () => {
    expect(STATE_LABEL.rejected).toBe("Rejected");
    expect(EVENT_LABEL.rejected).toBe("rejected");
    expect(isLockedState("rejected")).toBe(true);
    expect(isLockedState("in_review")).toBe(false);
  });

  it("words each reviewer's chip", () => {
    expect(reviewerChip(rv({ verdict: "approved", versionNumber: 4, current: true }))).toBe("Approved v4");
    expect(reviewerChip(rv({ verdict: "changes_requested", versionNumber: 3 }))).toBe(
      "Changes requested v3 · older version",
    );
    expect(reviewerChip(rv({}))).toBe("Waiting");
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

  it("finds the viewer's own verdict only while it counts", () => {
    expect(
      myCurrentVerdict(review({ reviewers: [rv({ me: true, verdict: "approved", versionNumber: 4, current: true })] })),
    ).toBe("approved");
    // Before a reopen, or on an older version: does not count.
    expect(myCurrentVerdict(review({ reviewers: [rv({ me: true, verdict: "approved", versionNumber: 4 })] }))).toBe(
      "none",
    );
    expect(
      myCurrentVerdict(review({ reviewers: [rv({ verdict: "approved", versionNumber: 4, current: true })] })),
    ).toBe("none");
  });

  describe("verdict controls for every state and verdict", () => {
    const none = { review: null, status: null, approve: null, changes: null };
    const at = (state: ReviewPayload["state"], mine: "none" | "approved" | "changes_requested", raced = false) =>
      verdictControls({ state, mine, read: 4, current: 4, raced });

    it("in review and changes requested", () => {
      for (const state of ["in_review", "changes_requested"] as const) {
        expect(at(state, "none")).toEqual({ ...none, approve: "Approve", changes: "Request changes" });
        expect(at(state, "approved")).toEqual({ ...none, status: "You approved v4", changes: "Request changes" });
        expect(at(state, "changes_requested")).toEqual({
          ...none,
          status: "You requested changes on v4",
          approve: "Approve",
        });
        // A lost race names the version on the buttons.
        expect(at(state, "none", true)).toEqual({ ...none, approve: "Approve v4", changes: "Request changes on v4" });
        expect(at(state, "approved", true)).toEqual({
          ...none,
          status: "You approved v4",
          changes: "Request changes on v4",
        });
        expect(at(state, "changes_requested", true)).toEqual({
          ...none,
          status: "You requested changes on v4",
          approve: "Approve v4",
        });
      }
    });

    it("approved: only Request changes on vN, never Approve", () => {
      expect(at("approved", "none")).toEqual({ ...none, changes: "Request changes on v4" });
      expect(at("approved", "approved")).toEqual({
        ...none,
        status: "You approved v4",
        changes: "Request changes on v4",
      });
      expect(at("approved", "none", true)).toEqual({ ...none, changes: "Request changes on v4" });
      // Forced over this reviewer's request for changes: repeating it changes nothing, Approve is not offered.
      expect(at("approved", "changes_requested")).toEqual({ ...none, status: "You requested changes on v4" });
    });

    it("a forced approval is final: no buttons, the status line stays", () => {
      const forced = (mine: "none" | "approved" | "changes_requested") =>
        verdictControls({ state: "approved", mine, read: 4, current: 4, raced: false, forced: true });
      expect(forced("none")).toEqual(none);
      expect(forced("approved")).toEqual({ ...none, status: "You approved v4" });
      expect(forced("changes_requested")).toEqual({ ...none, status: "You requested changes on v4" });
    });

    it("draft and archived take no verdict", () => {
      for (const state of ["draft", "archived"] as const) {
        for (const mine of ["none", "approved", "changes_requested"] as const) expect(at(state, mine)).toEqual(none);
      }
    });

    it("a newer version than the one read: only Review vN, whatever the state and verdict", () => {
      for (const state of ["in_review", "changes_requested", "approved"] as const) {
        for (const mine of ["none", "approved", "changes_requested"] as const) {
          expect(verdictControls({ state, mine, read: 4, current: 5, raced: false })).toEqual({
            ...none,
            review: "Review v5",
          });
        }
      }
    });
  });
});

describe("optionFamily", () => {
  it("names the family of a one-letter or one-digit variant, and nothing for a word after the dash", () => {
    expect(["option-a/", "option-b-cards/", "Option-C.md", "design-2.md", "option-a"].map(optionFamily)).toEqual([
      "option-",
      "option-",
      "option-",
      "design-",
      "option-",
    ]);
    expect(["api-spec.md", "api-client.md", "screens/", "plan.md", "-a/"].map(optionFamily)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("pre-ticks only the chosen option's family, never look-alike names", () => {
    const d = (id: string, path: string, current = false) => ({
      id,
      title: path,
      path,
      reviewState: "in_review",
      removed: false,
      current,
    });
    const ticks = chooseCandidates([
      d("a", "option-a/", true),
      d("b", "option-b-cards/"),
      d("s", "api-spec.md"),
      d("c", "api-client.md"),
    ]).map((c) => [c.path, c.ticked]);
    expect(ticks).toEqual([
      ["option-b-cards/", true],
      ["api-spec.md", false],
      ["api-client.md", false],
    ]);
    // Choosing api-spec.md pre-ticks nothing: api-client.md only looks like a sibling.
    expect(
      chooseCandidates([d("s", "api-spec.md", true), d("c", "api-client.md"), d("b", "option-b/")]).map(
        (c) => c.ticked,
      ),
    ).toEqual([false, false]);
    // Two look-alike documents are not alternatives either: Choose is not offered between them.
    expect(planAlternatives([{ path: "api-spec.md" }, { path: "api-client.md" }, { path: "option-a/" }])).toEqual([]);
  });
});

describe("option sets", () => {
  it("groups alternatives by set, and names nothing an option without a set of two", () => {
    const docs = ["layout-a/", "color-a/", "layout-b/", "notes.md", "api.md", "color-b/", "solo-a/"].map((path) => ({
      path,
    }));
    expect(optionSets(docs).map((s) => [s.family, s.docs.map((d) => d.path)])).toEqual([
      ["layout-", ["layout-a/", "layout-b/"]],
      ["color-", ["color-a/", "color-b/"]],
    ]);
    // Documents not named as options are never alternatives, however many there are.
    expect(planAlternatives([{ path: "notes.md" }, { path: "api.md" }])).toEqual([]);
  });

  it("words each set", () => {
    expect(optionSetWords("option-")).toEqual({ title: "Options", noun: "option", pick: "Pick an option" });
    expect(optionSetWords("layout-")).toEqual({ title: "Layout options", noun: "layout", pick: "Pick a layout" });
    expect(optionSetWords("icon-").pick).toBe("Pick an icon");
  });
});
