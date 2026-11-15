import { describe, expect, it } from "vitest";
import { MAX_EDITS, unifiedDiff } from "./text-diff.js";

describe("unifiedDiff", () => {
  it("is empty for identical text", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  it("gives one hunk with three lines of context around a change", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((l) => `${l}\n`).join("");
    const b = a.replace("5\n", "five\n");
    expect(unifiedDiff(a, b)).toBe("@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n");
  });

  it("splits far-apart changes into separate hunks and joins near ones", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}\n`);
    const far = [...lines];
    far[2] = "x\n";
    far[25] = "y\n";
    expect(unifiedDiff(lines.join(""), far.join(""))!.match(/^@@/gm)).toHaveLength(2);
    const near = [...lines];
    near[10] = "x\n";
    near[14] = "y\n";
    expect(unifiedDiff(lines.join(""), near.join(""))!.match(/^@@/gm)).toHaveLength(1);
  });

  it("handles an added file, a deleted file and a missing final newline", () => {
    expect(unifiedDiff("", "a\nb")).toBe("@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n");
    expect(unifiedDiff("a\n", "")).toBe("@@ -1,1 +0,0 @@\n-a\n");
  });

  it("gives up (null) past the edit cap", () => {
    const a = Array.from({ length: MAX_EDITS + 10 }, (_, i) => `a${i}\n`).join("");
    const b = Array.from({ length: MAX_EDITS + 10 }, (_, i) => `b${i}\n`).join("");
    expect(unifiedDiff(a, b)).toBeNull();
  });
});
