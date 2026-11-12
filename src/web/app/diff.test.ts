import { describe, expect, it } from "vitest";
import { diffText, myers, splitLines, splitWords, type DiffOp } from "./diff.js";

const side = (ops: DiffOp[], drop: "insert" | "delete") =>
  ops
    .filter((o) => o.kind !== drop)
    .map((o) => o.text)
    .join("");

function check(before: string, after: string): DiffOp[] {
  const ops = diffText(before, after);
  expect(side(ops, "insert")).toBe(before);
  expect(side(ops, "delete")).toBe(after);
  for (let i = 1; i < ops.length; i++) expect(ops[i].kind).not.toBe(ops[i - 1].kind);
  return ops;
}

describe("splitLines / splitWords", () => {
  it("split losslessly", () => {
    expect(splitLines("a\nb\n\nc")).toEqual(["a\n", "b\n", "\n", "c"]);
    expect(splitLines("")).toEqual([]);
    expect(splitWords("Hi, wörld  42_x\nnext")).toEqual(["Hi", ",", " ", "wörld", "  ", "42_x", "\n", "next"]);
  });
});

describe("myers", () => {
  it("finds a shortest edit script", () => {
    const steps = myers([1, 2, 3, 4], [1, 3, 4, 5])!;
    expect(steps.filter((s) => s !== "=")).toHaveLength(2);
    expect(myers([], [])).toEqual([]);
    expect(myers([1], [])).toEqual(["-"]);
    expect(myers([], [1, 2])).toEqual(["+", "+"]);
  });

  it("gives up past the edit cap", () => {
    expect(myers([1, 2, 3], [4, 5, 6], 2)).toBeNull();
    expect(myers([1, 2, 3], [4, 5, 6], 6)).not.toBeNull();
  });
});

describe("diffText", () => {
  it("reports equal text as one equal part", () => {
    expect(check("same text", "same text")).toEqual([{ kind: "equal", text: "same text" }]);
    expect(check("", "")).toEqual([]);
  });

  it("marks an inserted word", () => {
    expect(check("the quick fox", "the quick brown fox")).toEqual([
      { kind: "equal", text: "the quick " },
      { kind: "insert", text: "brown " },
      { kind: "equal", text: "fox" },
    ]);
  });

  it("marks a deleted word", () => {
    expect(check("the quick brown fox", "the brown fox")).toEqual([
      { kind: "equal", text: "the " },
      { kind: "delete", text: "quick " },
      { kind: "equal", text: "brown fox" },
    ]);
  });

  it("marks a replaced word as a delete then an insert", () => {
    expect(check("one two three", "one 2 three")).toEqual([
      { kind: "equal", text: "one " },
      { kind: "delete", text: "two" },
      { kind: "insert", text: "2" },
      { kind: "equal", text: " three" },
    ]);
  });

  it("handles new and removed lines (blocks)", () => {
    const ops = check("Title\nfirst para\nlast", "Title\nnew heading\nfirst para\nlast");
    expect(ops).toContainEqual({ kind: "insert", text: "new heading\n" });
    const gone = check("a\nb\nc", "a\nc");
    expect(gone).toContainEqual({ kind: "delete", text: "b\n" });
  });

  it("diffs words inside a changed line among unchanged lines", () => {
    const ops = check("keep\nsome words here\nkeep too", "keep\nsome other words here\nkeep too");
    expect(ops).toEqual([
      { kind: "equal", text: "keep\nsome " },
      { kind: "insert", text: "other " },
      { kind: "equal", text: "words here\nkeep too" },
    ]);
  });

  it("merges changes separated only by spaces into one replacement", () => {
    expect(check("go to the team channel.", "go to #launch on Slack.")).toEqual([
      { kind: "equal", text: "go to " },
      { kind: "delete", text: "the team channel" },
      { kind: "insert", text: "#launch on Slack" },
      { kind: "equal", text: "." },
    ]);
    // A newline between changes keeps them apart.
    expect(check("a\nb", "x\ny").filter((o) => o.kind === "equal")).toEqual([{ kind: "equal", text: "\n" }]);
  });

  it("stays bounded on unrelated large texts", () => {
    const a = Array.from({ length: 4000 }, (_, i) => `line ${i} alpha`).join("\n");
    const b = Array.from({ length: 4000 }, (_, i) => `row ${i * 7} beta`).join("\n");
    const started = Date.now();
    check(a, b);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
