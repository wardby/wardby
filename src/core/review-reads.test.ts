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
});
