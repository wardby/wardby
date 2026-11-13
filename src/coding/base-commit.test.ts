import { describe, expect, it } from "vitest";
import { CODING_TASK_TRAILER_RESERVE_BYTES, MAX_CODING_TASK_BYTES } from "./protocol.js";
import { withBaseCommit, withExtraRepositories } from "./base-commit.js";

const SHA = "db6e4fa032e52c80670a86918faead2c7fe790bc";

describe("withBaseCommit", () => {
  it("appends the base commit line after the task", () => {
    expect(withBaseCommit("Fix the bug.", SHA)).toBe(
      `Fix the bug.\n\nBase commit: ${SHA} (the commit this workspace was checked out at; the workspace has no git metadata).`,
    );
  });
  it("appends a line that fits within the trailer reserve", () => {
    const added = Buffer.byteLength(withBaseCommit("", SHA));
    expect(added).toBeLessThanOrEqual(CODING_TASK_TRAILER_RESERVE_BYTES);
  });
  it("leaves the task unchanged when the sha is not a full commit", () => {
    expect(withBaseCommit("Fix the bug.", "abc")).toBe("Fix the bug.");
  });
  it("leaves the task unchanged when the line would exceed the task limit", () => {
    const task = "t".repeat(MAX_CODING_TASK_BYTES - 10);
    expect(withBaseCommit(task, SHA)).toBe(task);
  });
});

describe("withExtraRepositories", () => {
  const extras = [
    { name: "upstream", repository: "upstream-org/upstream", access: "read" as const, commit: SHA },
    { name: "tools", repository: "your-org/tools", access: "write" as const, commit: "b".repeat(40) },
  ];
  it("appends one line per extra repository with its full commit", () => {
    expect(withExtraRepositories("Sync the fork.", extras)).toBe(
      `Sync the fork.\n\nExtra repository /repos/upstream: upstream-org/upstream at ${SHA}, read-only.\nExtra repository /repos/tools: your-org/tools at ${"b".repeat(40)}, writable.`,
    );
  });
  it("leaves the task unchanged without extra repositories", () => {
    expect(withExtraRepositories("Fix the bug.", [])).toBe("Fix the bug.");
  });
  it("leaves the task unchanged when the lines would exceed the task limit", () => {
    const task = "t".repeat(MAX_CODING_TASK_BYTES - 10);
    expect(withExtraRepositories(task, extras)).toBe(task);
  });
});
