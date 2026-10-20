import { describe, expect, it } from "vitest";
import type { PullRequestFileView, PullRequestView } from "../providers/review-host/types.js";
import { ReviewReadLedger } from "./review-reads.js";

const HEAD = "a".repeat(40);
const f = (
  filename: string,
  patchStatus: PullRequestFileView["patchStatus"],
  patch = "x",
  part?: { offset: number; continues: boolean },
): PullRequestFileView => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch,
  patchStatus,
  patchTruncated: patchStatus === "later_page" || patchStatus === "unavailable" || (part?.continues ?? false),
  ...(part ? { patchOffset: part.offset, patchContinues: part.continues } : {}),
});
const view = (files: PullRequestFileView[], nextPatchCursor: string | null = null) =>
  ({ headSha: HEAD, files, nextPatchCursor }) as unknown as PullRequestView;

describe("ReviewReadLedger", () => {
  it("knows nothing about a head it never saw", () => {
    expect(new ReviewReadLedger().unreadCode("o/r", 1, HEAD)).toBeNull();
  });

  it("lists code files not delivered in full, ignoring docs", () => {
    const reads = new ReviewReadLedger();
    reads.recordPage(
      "o/r",
      1,
      view([f("src/a.ts", "complete"), f("src/b.ts", "later_page"), f("docs/x.md", "later_page")], "v1.c"),
      false,
    );
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual(["src/b.ts"]);
  });

  it("counts a file read in parts once its last part arrives, and one read with repo_read_file at the head", () => {
    const reads = new ReviewReadLedger();
    reads.recordPage(
      "o/r",
      1,
      view([f("src/a.ts", "partial", "xx", { offset: 0, continues: true }), f("src/b.ts", "unavailable", "")], "v1.c"),
      false,
    );
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual(["src/a.ts", "src/b.ts"]);
    reads.recordPage(
      "o/r",
      1,
      view([f("src/a.ts", "partial", "yy", { offset: 2, continues: false }), f("src/b.ts", "unavailable", "")], null),
      true,
    );
    reads.recordFileRead("o/r", HEAD, "src/b.ts");
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual([]);
  });

  it("does not count a read at another ref", () => {
    const reads = new ReviewReadLedger();
    reads.recordPage("o/r", 1, view([f("src/b.ts", "unavailable", "")]), false);
    reads.recordFileRead("o/r", "main", "src/b.ts");
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual(["src/b.ts"]);
  });

  it("never gates a removed file, even one with no patch", () => {
    const reads = new ReviewReadLedger();
    reads.recordPage("o/r", 1, view([{ ...f("src/gone.ts", "unavailable", ""), status: "removed" }]), false);
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual([]);
  });

  it("does not gate a head whose first page this attempt never saw (a resume replayed it)", () => {
    const reads = new ReviewReadLedger();
    // Page 1 was a replayed step: only the cursor page reached this attempt's handler.
    reads.recordPage("o/r", 1, view([f("src/a.ts", "earlier_page", ""), f("src/b.ts", "complete")]), true);
    expect(reads.unreadCode("o/r", 1, HEAD)).toBeNull();
    // A fresh first page in this attempt starts gating again.
    reads.recordPage("o/r", 1, view([f("src/a.ts", "complete"), f("src/b.ts", "later_page")], "v1.c"), false);
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual([]);
  });

  it("counts a part only when it continues where the file's last delivered part ended", () => {
    const reads = new ReviewReadLedger();
    reads.recordPage("o/r", 1, view([f("src/a.ts", "later_page", "")], "v1.c"), false);
    // A forged cursor jumps to the end: an empty last part at offset 10 with nothing delivered before it.
    reads.recordPage("o/r", 1, view([f("src/a.ts", "partial", "", { offset: 10, continues: false })]), true);
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual(["src/a.ts"]);
    // A gap (0..4 delivered, next part starts at 6) does not count either.
    reads.recordPage("o/r", 1, view([f("src/a.ts", "partial", "abcd", { offset: 0, continues: true })]), true);
    reads.recordPage("o/r", 1, view([f("src/a.ts", "partial", "ghij", { offset: 6, continues: false })]), true);
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual(["src/a.ts"]);
    // The contiguous chain does.
    reads.recordPage("o/r", 1, view([f("src/a.ts", "partial", "ef", { offset: 4, continues: true })]), true);
    reads.recordPage("o/r", 1, view([f("src/a.ts", "partial", "ghij", { offset: 6, continues: false })]), true);
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual([]);
  });

  it("accepts a re-read chain that overlaps what was already delivered", () => {
    const reads = new ReviewReadLedger();
    reads.recordPage("o/r", 1, view([f("src/a.ts", "partial", "abcdef", { offset: 0, continues: true })]), false);
    // Paging restarted with a smaller budget: page 1 again, then a part ending the file.
    reads.recordPage("o/r", 1, view([f("src/a.ts", "partial", "abc", { offset: 0, continues: true })]), false);
    reads.recordPage("o/r", 1, view([f("src/a.ts", "partial", "defgh", { offset: 3, continues: false })]), true);
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual([]);
  });
});

describe("ReviewReadLedger state", () => {
  it("restores what it had read, and a restored chain of parts continues", () => {
    const reads = new ReviewReadLedger();
    reads.recordPage(
      "o/r",
      1,
      view([f("src/a.ts", "partial", "xx", { offset: 0, continues: true }), f("src/b.ts", "unavailable", "")], "v1.c"),
      false,
    );
    reads.recordFileRead("o/r", HEAD, "src/b.ts");

    const restored = ReviewReadLedger.fromJSON(JSON.parse(JSON.stringify(reads.toJSON())));
    expect(restored.unreadCode("o/r", 1, HEAD)).toEqual(["src/a.ts"]);
    restored.recordPage("o/r", 1, view([f("src/a.ts", "partial", "yy", { offset: 2, continues: false })], null), true);
    expect(restored.unreadCode("o/r", 1, HEAD)).toEqual([]);
  });

  it("starts empty from a missing or malformed state", () => {
    for (const state of [
      null,
      undefined,
      "x",
      3,
      { v: 2 },
      { v: 1, heads: "x" },
      { v: 1, heads: { k: { code: 1 } } },
    ]) {
      expect(ReviewReadLedger.fromJSON(state).unreadCode("o/r", 1, HEAD)).toBeNull();
    }
  });

  it("merges two attempts' reads of the same head", () => {
    const first = new ReviewReadLedger();
    first.recordPage("o/r", 1, view([f("src/a.ts", "complete"), f("src/b.ts", "later_page")], "v1.c"), false);
    const second = new ReviewReadLedger();
    second.recordPage("o/r", 1, view([f("src/a.ts", "earlier_page"), f("src/b.ts", "complete")], null), true);
    second.recordFileRead("o/r", HEAD, "src/c.ts");

    first.merge(second);
    expect(first.unreadCode("o/r", 1, HEAD)).toEqual([]);
    expect(first.toJSON().fileReads).toEqual({ [`o/r@${HEAD}`]: ["src/c.ts"] });
  });

  it("keeps the furthest contiguous delivery when merging parts", () => {
    const a = new ReviewReadLedger();
    a.recordPage("o/r", 1, view([f("src/a.ts", "partial", "xxxx", { offset: 0, continues: true })], "v1.c"), false);
    const b = ReviewReadLedger.fromJSON(a.toJSON());
    b.recordPage("o/r", 1, view([f("src/a.ts", "partial", "yy", { offset: 4, continues: true })], "v1.d"), true);

    a.merge(b);
    a.recordPage("o/r", 1, view([f("src/a.ts", "partial", "z", { offset: 6, continues: false })], null), true);
    expect(a.unreadCode("o/r", 1, HEAD)).toEqual([]);
  });

  describe("a sinceSha read after a full read of the same head", () => {
    const compare = (files: PullRequestFileView[], fileListComplete = true) =>
      ({
        headSha: HEAD,
        files,
        nextPatchCursor: null,
        comparedFrom: "b".repeat(40),
        fileListComplete,
      }) as unknown as PullRequestView;
    const full = (files: PullRequestFileView[], fileListComplete = true) =>
      ({
        headSha: HEAD,
        files,
        nextPatchCursor: null,
        comparedFrom: null,
        fileListComplete,
      }) as unknown as PullRequestView;
    const listed = [f("src/a.ts", "complete"), f("src/b.ts", "later_page"), f("src/c.ts", "later_page")];

    it("never narrows the gate (control plane: one ledger)", () => {
      const reads = new ReviewReadLedger();
      reads.recordPage("o/r", 1, full(listed), false);
      reads.recordPage("o/r", 1, compare([f("src/a.ts", "complete")]), false);
      expect(reads.unreadCode("o/r", 1, HEAD)).toEqual(["src/b.ts", "src/c.ts"]);
    });

    it("never narrows the gate (sandbox: each request's ledger merged into the saved one)", () => {
      const first = new ReviewReadLedger();
      first.recordPage("o/r", 1, full(listed), false);
      const saved = ReviewReadLedger.fromJSON(first.toJSON());
      const second = ReviewReadLedger.fromJSON(saved.toJSON());
      second.recordPage("o/r", 1, compare([f("src/a.ts", "complete")]), false);
      expect(second.unreadCode("o/r", 1, HEAD)).toEqual(["src/b.ts", "src/c.ts"]);
      saved.merge(second);
      expect(saved.unreadCode("o/r", 1, HEAD)).toEqual(["src/b.ts", "src/c.ts"]);
    });

    it("a whole compare list does not clear a cut full list; a whole full list does", () => {
      const reads = new ReviewReadLedger();
      reads.recordPage("o/r", 1, full([f("src/a.ts", "complete")], false), false);
      reads.recordPage("o/r", 1, compare([f("src/a.ts", "complete")]), false);
      expect(reads.fileListCut("o/r", 1, HEAD)).toBe(true);
      reads.recordPage("o/r", 1, full([f("src/a.ts", "complete")]), false);
      expect(reads.fileListCut("o/r", 1, HEAD)).toBe(false);
    });

    it("a cut compare list after a whole full list is not cut: the full list's files stay gated", () => {
      const reads = new ReviewReadLedger();
      reads.recordPage("o/r", 1, full([f("src/a.ts", "complete")]), false);
      reads.recordPage("o/r", 1, compare([f("src/a.ts", "complete")], false), false);
      expect(reads.fileListCut("o/r", 1, HEAD)).toBe(false);
    });
  });

  describe("a compare from a base the host did not vouch for", () => {
    const B1 = "b".repeat(40);
    const B2 = "c".repeat(40);
    const read = (comparedFrom: string | null, trusted: string | null) =>
      ({
        headSha: HEAD,
        files: [f("src/a.ts", "complete")],
        nextPatchCursor: null,
        comparedFrom,
        lastReviewedSha: trusted,
        lastCoveredSha: trusted,
        fileListComplete: true,
      }) as unknown as PullRequestView;

    it("is unverified on a first review that compares from any ancestor (control plane)", () => {
      const reads = new ReviewReadLedger();
      reads.recordPage("o/r", 1, read(B1, null), false);
      expect(reads.unreadCode("o/r", 1, HEAD)).toEqual([]);
      expect(reads.baseUnverified("o/r", 1, HEAD)).toBe(true);
      // A whole list of the pull request settles it.
      reads.recordPage("o/r", 1, read(null, null), false);
      expect(reads.baseUnverified("o/r", 1, HEAD)).toBe(false);
    });

    it("is verified when the base is the head the same read vouched for, and not for another base", () => {
      const reads = new ReviewReadLedger();
      reads.recordPage("o/r", 1, read(B1, B1), false);
      expect(reads.baseUnverified("o/r", 1, HEAD)).toBe(false);
      reads.recordPage("o/r", 1, read(B2, B1), false);
      expect(reads.baseUnverified("o/r", 1, HEAD)).toBe(true);
      expect(reads.baseUnverified("o/r", 2, HEAD)).toBe(false);
    });

    it("is unverified the same way in sandbox mode (saved, restored and merged)", () => {
      const saved = new ReviewReadLedger();
      const request = ReviewReadLedger.fromJSON(JSON.parse(JSON.stringify(saved.toJSON())));
      request.recordPage("o/r", 1, read(B1, null), false);
      saved.merge(request);
      const restored = ReviewReadLedger.fromJSON(JSON.parse(JSON.stringify(saved.toJSON())));
      expect(restored.baseUnverified("o/r", 1, HEAD)).toBe(true);
      const trusted = ReviewReadLedger.fromJSON(restored.toJSON());
      trusted.recordPage("o/r", 1, read(B1, B1), false);
      restored.merge(trusted);
      expect(restored.baseUnverified("o/r", 1, HEAD)).toBe(false);
    });
  });

  describe("a head saved without its compare bases (an older state, or an older gateway's rewrite)", () => {
    const B1 = "b".repeat(40);
    const delta = (lastCoveredSha: string | null = null) =>
      ({
        headSha: HEAD,
        files: [f("src/a.ts", "complete")],
        nextPatchCursor: null,
        comparedFrom: B1,
        lastReviewedSha: B1,
        lastCoveredSha,
        fileListComplete: true,
      }) as unknown as PullRequestView;
    const legacy = (reads: ReviewReadLedger) => {
      const state = JSON.parse(JSON.stringify(reads.toJSON())) as { heads: Record<string, Record<string, unknown>> };
      for (const head of Object.values(state.heads)) {
        delete head.bases;
        delete head.trustedBases;
        delete head.basesKnown;
      }
      return ReviewReadLedger.fromJSON(state);
    };

    it("is never covered and stays unverified until a whole list is read", () => {
      const reads = new ReviewReadLedger();
      reads.recordPage("o/r", 1, delta(), false);
      const old = legacy(reads);
      expect(old.unreadCode("o/r", 1, HEAD)).toEqual([]);
      expect(old.baseUnverified("o/r", 1, HEAD)).toBe(true);
      expect(old.covered("o/r", 1, HEAD)).toBe(false);
      // Even a later delta from a vouched-for base does not settle it: the earlier bases are unknown.
      old.recordPage("o/r", 1, delta(B1), false);
      expect(old.covered("o/r", 1, HEAD)).toBe(false);
      old.recordPage("o/r", 1, { ...delta(), comparedFrom: null }, false);
      expect(old.covered("o/r", 1, HEAD)).toBe(true);
    });

    it("keeps the bases unknown through a merge with a ledger that knows them", () => {
      const reads = new ReviewReadLedger();
      reads.recordPage("o/r", 1, delta(B1), false);
      const saved = legacy(reads);
      const fresh = new ReviewReadLedger();
      fresh.recordPage("o/r", 1, delta(B1), false);
      expect(fresh.baseUnverified("o/r", 1, HEAD)).toBe(false);
      fresh.merge(saved);
      expect(fresh.baseUnverified("o/r", 1, HEAD)).toBe(true);
      // A state this version saved round-trips as known.
      expect(ReviewReadLedger.fromJSON(JSON.parse(JSON.stringify(reads.toJSON()))).covered("o/r", 1, HEAD)).toBe(true);
    });
  });

  describe("covered(): this attempt read every file of the head", () => {
    const B1 = "b".repeat(40);
    const page = (
      files: PullRequestFileView[],
      over: { comparedFrom?: string | null; lastCoveredSha?: string | null; fileListComplete?: boolean } = {},
    ) =>
      ({
        headSha: HEAD,
        files,
        nextPatchCursor: null,
        comparedFrom: null,
        lastReviewedSha: null,
        lastCoveredSha: null,
        fileListComplete: true,
        ...over,
      }) as unknown as PullRequestView;

    it("only for a whole, uncut list with every code file read", () => {
      const reads = new ReviewReadLedger();
      expect(reads.covered("o/r", 1, HEAD)).toBe(false);
      reads.recordPage("o/r", 1, page([f("src/a.ts", "later_page")]), false);
      expect(reads.covered("o/r", 1, HEAD)).toBe(false);
      reads.recordPage("o/r", 1, page([f("src/a.ts", "complete")]), true);
      expect(reads.covered("o/r", 1, HEAD)).toBe(true);
      const cut = new ReviewReadLedger();
      cut.recordPage("o/r", 1, page([f("src/a.ts", "complete")], { fileListComplete: false }), false);
      expect(cut.covered("o/r", 1, HEAD)).toBe(false);
    });

    it("for a delta only when it starts from the covered head the read returned", () => {
      const trusted = new ReviewReadLedger();
      trusted.recordPage("o/r", 1, page([f("src/a.ts", "complete")], { comparedFrom: B1, lastCoveredSha: B1 }), false);
      expect(trusted.covered("o/r", 1, HEAD)).toBe(true);
      const other = new ReviewReadLedger();
      other.recordPage("o/r", 1, page([f("src/a.ts", "complete")], { comparedFrom: B1, lastCoveredSha: null }), false);
      expect(other.covered("o/r", 1, HEAD)).toBe(false);
    });
  });

  describe("a file list the host cut", () => {
    const cut = (files: PullRequestFileView[]) =>
      ({ headSha: HEAD, files, nextPatchCursor: null, fileListComplete: false }) as unknown as PullRequestView;
    const whole = (files: PullRequestFileView[]) =>
      ({ headSha: HEAD, files, nextPatchCursor: null, fileListComplete: true }) as unknown as PullRequestView;

    it("is cut even when every listed file was read, and only once the first page was seen", () => {
      const reads = new ReviewReadLedger();
      reads.recordPage("o/r", 1, cut([f("src/a.ts", "complete")]), true);
      expect(reads.fileListCut("o/r", 1, HEAD)).toBe(false);
      reads.recordPage("o/r", 1, cut([f("src/a.ts", "complete")]), false);
      expect(reads.unreadCode("o/r", 1, HEAD)).toEqual([]);
      expect(reads.fileListCut("o/r", 1, HEAD)).toBe(true);
      expect(reads.fileListCut("o/r", 2, HEAD)).toBe(false);
    });

    it("a whole full list after a cut one clears it", () => {
      const reads = new ReviewReadLedger();
      reads.recordPage("o/r", 1, cut([f("src/a.ts", "complete")]), false);
      reads.recordPage("o/r", 1, whole([f("src/a.ts", "complete")]), false);
      expect(reads.fileListCut("o/r", 1, HEAD)).toBe(false);
    });

    it("survives toJSON/fromJSON, and a state saved without the field reads as not cut", () => {
      const reads = new ReviewReadLedger();
      reads.recordPage("o/r", 1, cut([f("src/a.ts", "complete")]), false);
      const state = JSON.parse(JSON.stringify(reads.toJSON())) as { heads: Record<string, Record<string, unknown>> };
      expect(ReviewReadLedger.fromJSON(state).fileListCut("o/r", 1, HEAD)).toBe(true);
      for (const head of Object.values(state.heads)) {
        delete head.listCut;
        delete head.fullListSeen;
      }
      expect(ReviewReadLedger.fromJSON(state).fileListCut("o/r", 1, HEAD)).toBe(false);
      expect(ReviewReadLedger.fromJSON(state).unreadCode("o/r", 1, HEAD)).toEqual([]);
    });

    it("merges: a whole full list clears a cut, and a cut kept side by side with a compare stays", () => {
      const saved = new ReviewReadLedger();
      saved.recordPage("o/r", 1, cut([f("src/a.ts", "complete")]), false);
      const newer = ReviewReadLedger.fromJSON(saved.toJSON());
      newer.recordPage("o/r", 1, whole([f("src/a.ts", "complete")]), false);
      const stale = ReviewReadLedger.fromJSON(saved.toJSON());
      stale.merge(newer);
      expect(stale.fileListCut("o/r", 1, HEAD)).toBe(false);

      // Side by side: a whole compare list never clears the other request's cut full list.
      const left = new ReviewReadLedger();
      const right = new ReviewReadLedger();
      left.recordPage("o/r", 1, { ...whole([f("src/a.ts", "complete")]), comparedFrom: "b".repeat(40) }, false);
      right.recordPage("o/r", 1, cut([f("src/a.ts", "complete")]), false);
      left.merge(right);
      expect(left.fileListCut("o/r", 1, HEAD)).toBe(true);
      // And a whole full list in either request means every file is listed.
      const done = new ReviewReadLedger();
      done.recordPage("o/r", 1, whole([f("src/a.ts", "complete")]), false);
      left.merge(done);
      expect(left.fileListCut("o/r", 1, HEAD)).toBe(false);
    });
  });
});
