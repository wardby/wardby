import { describe, expect, it } from "vitest";
import { commentableLines, partitionComments } from "./diff-lines.js";

const PATCH = [
  "@@ -1,4 +1,5 @@",
  " line one",
  "-old two",
  "+new two",
  "+new three",
  " line four",
  "@@ -20,2 +21,2 @@",
  " ctx",
  "\\ No newline at end of file",
].join("\n");

describe("commentableLines", () => {
  it("maps added and context lines to RIGHT and removed and context lines to LEFT", () => {
    const { right, left } = commentableLines(PATCH);
    expect([...right].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 21]);
    expect([...left].sort((a, b) => a - b)).toEqual([1, 2, 3, 20]);
  });

  it("returns nothing for an empty or missing patch", () => {
    expect(commentableLines("").right.size).toBe(0);
  });
});

describe("partitionComments", () => {
  it("keeps comments on diff lines inline and moves the rest outside", () => {
    const comments = [
      { path: "a.py", line: 3, side: "RIGHT" as const, severity: "MAJOR", body: "x" },
      { path: "a.py", line: 99, side: "RIGHT" as const, severity: "MINOR", body: "y" },
      { path: "b.py", line: 1, side: "RIGHT" as const, severity: "MINOR", body: "z" },
      { path: "a.py", line: 2, side: "LEFT" as const, severity: "MINOR", body: "w" },
    ];
    const { inline, outside } = partitionComments(comments, new Map([["a.py", PATCH]]));
    expect(inline.map((c) => c.body)).toEqual(["x", "w"]);
    expect(outside.map((c) => c.body)).toEqual(["y", "z"]);
  });
});
