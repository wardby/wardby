import { describe, expect, it, vi } from "vitest";
import type { IssueTracker } from "../issue-tracker/types.js";
import type { CodeReviewHost } from "../review-host/types.js";
import { linkedIssueReader } from "./linked-issue-reader.js";

describe("linkedIssueReader", () => {
  it("reads a GitHub issue's title and body through the review host", async () => {
    const readIssue = vi.fn(async () => ({ kind: "issue" as const, title: "Jokes", body: "- [ ] list" }) as never);
    const read = linkedIssueReader({
      hosts: { github: { readIssue } as unknown as CodeReviewHost },
      issueTrackers: {},
    });
    await expect(read({ provider: "github", repository: "openai/example", number: 12 })).resolves.toEqual({
      title: "Jokes",
      body: "- [ ] list",
    });
    expect(readIssue).toHaveBeenCalledWith("openai/example", 12, { comments: false });
  });

  it("is null for a pull request number, a missing issue, or no GitHub host", async () => {
    for (const result of [
      { kind: "pull_request", number: 12 },
      { kind: "not_found", number: 12 },
    ]) {
      const host = { readIssue: async () => result } as unknown as CodeReviewHost;
      await expect(
        linkedIssueReader({ hosts: { github: host }, issueTrackers: {} })({
          provider: "github",
          repository: "openai/example",
          number: 12,
        }),
      ).resolves.toBeNull();
    }
    await expect(
      linkedIssueReader({ hosts: {}, issueTrackers: {} })({ provider: "github", repository: "o/r", number: 1 }),
    ).resolves.toBeNull();
  });

  it("reads a Jira issue's summary and description, without comments", async () => {
    const getIssue = vi.fn(async () => ({ summary: "Jokes", description: "AC: list them" }) as never);
    const read = linkedIssueReader({ hosts: {}, issueTrackers: { jira: { getIssue } as unknown as IssueTracker } });
    await expect(read({ provider: "jira", key: "ABC-12" })).resolves.toEqual({
      title: "Jokes",
      body: "AC: list them",
    });
    expect(getIssue).toHaveBeenCalledWith("ABC-12", expect.objectContaining({ maxComments: 0 }));
    await expect(
      linkedIssueReader({ hosts: {}, issueTrackers: {} })({ provider: "jira", key: "ABC-12" }),
    ).resolves.toBeNull();
  });
});
