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

describe("withBaseCommit with git history", () => {
  const remote = { ref: "upstream/pinned", commit: "b".repeat(40) };
  it("says the workspace has history to a depth, with its remotes", () => {
    expect(withBaseCommit("Fix the bug.", SHA, { depth: 50, remotes: [remote] })).toBe(
      `Fix the bug.\n\nBase commit: ${SHA} (the workspace has git history to depth 50; remotes: upstream/pinned at ${"b".repeat(40)}; fetching and pushing are not possible \u2014 commit your work).`,
    );
  });
  it("says full history, and joins several remotes", () => {
    expect(
      withBaseCommit("T", SHA, { depth: "full", remotes: [remote, { ref: "up/main", commit: "c".repeat(40) }] }),
    ).toBe(
      `T\n\nBase commit: ${SHA} (the workspace has full history; remotes: upstream/pinned at ${"b".repeat(40)}, up/main at ${"c".repeat(40)}; fetching and pushing are not possible \u2014 commit your work).`,
    );
  });
  it("omits the remotes clause when there are none", () => {
    expect(withBaseCommit("T", SHA, { depth: 1, remotes: [] })).toBe(
      `T\n\nBase commit: ${SHA} (the workspace has git history to depth 1; fetching and pushing are not possible \u2014 commit your work).`,
    );
  });
  it("still leaves the task unchanged for a bad sha or no room", () => {
    expect(withBaseCommit("T", "abc", { depth: 1, remotes: [] })).toBe("T");
    const task = "t".repeat(MAX_CODING_TASK_BYTES - 10);
    expect(withBaseCommit(task, SHA, { depth: "full", remotes: [] })).toBe(task);
  });
  it("fits the trailer reserve with a few remotes", () => {
    const added = Buffer.byteLength(withBaseCommit("", SHA, { depth: "full", remotes: [remote] }));
    expect(added).toBeLessThanOrEqual(CODING_TASK_TRAILER_RESERVE_BYTES);
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
  it("says a writable extra with history has git history", () => {
    expect(
      withExtraRepositories("S.", [
        { ...extras[1], history: true },
        { ...extras[0], history: false },
      ]),
    ).toBe(
      `S.\n\nExtra repository /repos/tools: your-org/tools at ${"b".repeat(40)}, writable, with git history.\nExtra repository /repos/upstream: upstream-org/upstream at ${SHA}, read-only.`,
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
