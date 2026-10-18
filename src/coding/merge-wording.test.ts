import { describe, expect, it } from "vitest";
import {
  conflictMarkersPathFromError,
  conflictMarkersSentence,
  mergeSentence,
  withTargetMerge,
} from "./merge-wording.js";
import { byteLength, MAX_CODING_TASK_BYTES } from "./protocol.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("merge wording", () => {
  it("states what was merged and how many files had conflicts", () => {
    expect(mergeSentence({ ref: "main", targetCommit: SHA, conflicts: 0 })).toBe(
      "Merged `main` @ `0123456` into this branch; no conflicts.",
    );
    expect(mergeSentence({ ref: "release/2", targetCommit: SHA, conflicts: 3 })).toBe(
      "Merged `release/2` @ `0123456` into this branch; resolved conflicts in 3 files.",
    );
  });

  it("names a file left with markers, host-safely", () => {
    expect(conflictMarkersPathFromError(new Error("vcs_conflict_markers_remain:a/b.ts"))).toBe("a/b.ts");
    expect(conflictMarkersPathFromError(new Error("vcs_protected_path:a/b.ts"))).toBeNull();
    expect(conflictMarkersSentence("we`ird\npath")).toContain("`we'ird path` still has conflict markers");
    expect(conflictMarkersSentence(null)).toContain("a conflicted file still has conflict markers");
  });

  it("adds nothing without a merge, one line for a clean merge, and the conflicted files otherwise", () => {
    expect(withTargetMerge("Do it.", undefined, "wardby/run-r")).toBe("Do it.");
    const clean = withTargetMerge("Do it.", { ref: "main", targetCommit: SHA, conflictedPaths: [] }, "wardby/run-r");
    expect(clean).toBe(
      "Do it.\n\nTarget branch: before you started, wardby merged `main` @ 0123456 (this pull request's target branch) into this branch with no conflicts. Check that the combined code still builds and its tests pass.",
    );
    const conflicted = withTargetMerge(
      "Do it.",
      { ref: "main", targetCommit: SHA, conflictedPaths: ["a.ts", "b`c.ts"] },
      "wardby/run-r",
    );
    expect(conflicted).toContain("and 2 files conflict:\n- `a.ts`\n- `b'c.ts`\n");
    expect(conflicted).toContain("this pull request's branch (`wardby/run-r`)");
    expect(conflicted).toContain("Your changes are refused while any of these files still has conflict markers.");
  });

  it("shortens the list, then leaves the note out, rather than pass the task limit", () => {
    const paths = Array.from({ length: 400 }, (_, n) => `src/some/long/directory/name/file-${n}.ts`);
    const listed = withTargetMerge("Do it.", { ref: "main", targetCommit: SHA, conflictedPaths: paths }, "h");
    expect(byteLength(listed)).toBeLessThanOrEqual(MAX_CODING_TASK_BYTES);
    expect(listed).toMatch(/- and \d+ more/);
    const full = "x".repeat(MAX_CODING_TASK_BYTES - 10);
    expect(withTargetMerge(full, { ref: "main", targetCommit: SHA, conflictedPaths: paths }, "h")).toBe(full);
  });
});
