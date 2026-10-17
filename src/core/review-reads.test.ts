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
    );
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual(["src/b.ts"]);
  });

  it("counts a file read in parts once its last part arrives, and one read with repo_read_file at the head", () => {
    const reads = new ReviewReadLedger();
    reads.recordPage(
      "o/r",
      1,
      view([f("src/a.ts", "partial", "xx", { offset: 0, continues: true }), f("src/b.ts", "unavailable", "")], "v1.c"),
    );
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual(["src/a.ts", "src/b.ts"]);
    reads.recordPage(
      "o/r",
      1,
      view([f("src/a.ts", "partial", "yy", { offset: 2, continues: false }), f("src/b.ts", "unavailable", "")], null),
    );
    reads.recordFileRead("o/r", HEAD, "src/b.ts");
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual([]);
  });

  it("does not count a read at another ref", () => {
    const reads = new ReviewReadLedger();
    reads.recordPage("o/r", 1, view([f("src/b.ts", "unavailable", "")]));
    reads.recordFileRead("o/r", "main", "src/b.ts");
    expect(reads.unreadCode("o/r", 1, HEAD)).toEqual(["src/b.ts"]);
  });
});
