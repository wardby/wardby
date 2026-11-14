import { describe, expect, it } from "vitest";
import { PACKAGE_REFUSALS_TASK_NOTE, repositoriesTaskNote, workerTaskNote } from "./task-note.js";
import type { GitHistoryInput, RunRepositoryInput } from "../coding/protocol.js";

const repositories: RunRepositoryInput[] = [
  { name: "tools", path: "/repos/tools", access: "write", repository: "your-org/tools", commit: "b".repeat(40) },
  { name: "base", path: "/repos/base", access: "read", repository: "your-org/base", commit: "c".repeat(40) },
];
const history: GitHistoryInput = {
  repositories: [{ path: "/workspace", baseCommit: "a".repeat(40), excludeCommits: [] }],
};

const NO_HISTORY_NOTE =
  'This run has more than one repository. /workspace is the default repository (pullRequests name: "workspace").\n- /repos/tools: your-org/tools at bbbbbbb, writable\n- /repos/base: your-org/base at ccccccc, read-only\nNone of them has Git history. Wardby opens one pull request per writable repository you change; describe each in pullRequests (name, description, optional title and mergeOrder 1-99). A changed repository without an entry gets your summary.';

describe("repositoriesTaskNote", () => {
  it("is unchanged without git history", () => {
    expect(repositoriesTaskNote(repositories)).toBe(NO_HISTORY_NOTE);
    expect(repositoriesTaskNote(repositories, undefined)).toBe(NO_HISTORY_NOTE);
  });
  it("replaces the no-history sentence when history is on", () => {
    const note = repositoriesTaskNote(repositories, history)!;
    expect(note).not.toContain("None of them has Git history.");
    expect(note).toBe(
      NO_HISTORY_NOTE.replace(
        "None of them has Git history.",
        "Writable repositories have git history; read-only folders do not. Commit your work with git; uncommitted changes are collected too.",
      ),
    );
  });
  it("is undefined for a single-repository run, history or not", () => {
    expect(repositoriesTaskNote(undefined, history)).toBeUndefined();
  });
});

describe("workerTaskNote", () => {
  it("is unchanged without git history", () => {
    expect(workerTaskNote(undefined)).toBe(PACKAGE_REFUSALS_TASK_NOTE);
    expect(workerTaskNote(undefined, repositories)).toBe(`${NO_HISTORY_NOTE}\n\n${PACKAGE_REFUSALS_TASK_NOTE}`);
  });
  it("passes git history to the repositories note", () => {
    expect(workerTaskNote(undefined, repositories, history)).toBe(
      `${repositoriesTaskNote(repositories, history)}\n\n${PACKAGE_REFUSALS_TASK_NOTE}`,
    );
  });
});
