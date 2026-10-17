/**
 * A GitHub issue mention records its pull requests in IssuePullRequest exactly
 * like a Jira issue (against real PostgreSQL): the status completion writes the
 * row once, a PR mention writes none, a close settles it, and the issue's open
 * pull requests read back from it. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { createPrismaClient } from "./db.js";
import { completeHostStatus } from "./host-status.js";
import { githubIssueKey, handlePullRequestClosed } from "./issue-bridge.js";
import { openSiblingsForIssue } from "./related-pull-requests.js";

describe.skipIf(!process.env.DATABASE_URL)("GitHub issue pull requests (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const id = (name: string) => `ghipr-${name}-${suffix}`;
  const owner = id("owner");
  const agentId = id("agent");
  const repo = `acme-${suffix.slice(0, 8)}/app`;
  const issueKey = githubIssueKey(repo, 5);

  function host(): CodeReviewHost {
    return {
      provider: "github",
      comment: vi.fn(async () => ({ url: "https://x/c", id: "c-new" })),
      editComment: vi.fn(async () => undefined),
    } as unknown as CodeReviewHost;
  }

  /** A mention run on `number` with one coding child whose result is `result`. */
  async function mentionRun(name: string, kind: "issue" | "PR", number: number, result: object, childStatus: string) {
    const runId = id(name);
    await db.run.create({
      data: {
        id: runId,
        agentId,
        status: "succeeded",
        trigger: "host_event",
        taskOverride: `[GitHub ${kind} #${number}]\nRepository: ${repo}\nRequested by @someone\n\nRequest comment:\nadd it`,
      },
    });
    await db.runHostStatus.create({
      data: { runId, provider: "github", repository: repo, number, commentKind: "conversation", commentId: "c-1" },
    });
    const childId = id(`${name}-code`);
    await db.run.create({
      data: { id: childId, agentId, status: childStatus as never, trigger: "subagent", parentRunId: runId },
    });
    await db.codingRun.create({
      data: {
        runId: childId,
        task: "t",
        repository: repo,
        baseRef: "main",
        headRef: `wardby/run-${childId}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        result,
      },
    });
    return { runId, childId };
  }
  const opened = (n: number) => ({
    outcome: "pull_request_opened",
    repository: repo,
    pullRequestNumber: n,
    pullRequestUrl: `https://github.com/${repo}/pull/${n}`,
  });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 10, ownerId: owner },
    });
  });

  afterAll(async () => {
    await db.issuePullRequest.deleteMany({ where: { repository: repo } });
    await db.codingRun.deleteMany({ where: { repository: repo } });
    await db.run.deleteMany({ where: { agentId, parentRunId: { not: null } } });
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.delete({ where: { id: agentId } });
    await db.principal.delete({ where: { id: owner } });
    await db.$disconnect();
  });

  it("an issue mention records its budget-stopped draft once; it reads back as the issue's open PR, then settles on close", async () => {
    const { runId, childId } = await mentionRun("issue", "issue", 5, opened(41), "budget_exhausted");
    const run = { id: runId, status: "succeeded", finalText: "done" } as const;
    await completeHostStatus(db, run, { github: host() });
    // A second completion (the reconciler's retry of a reopened row) adds nothing.
    await db.runHostStatus.update({ where: { runId }, data: { completedAt: null } });
    await completeHostStatus(db, run, { github: host() });

    const rows = await db.issuePullRequest.findMany({ where: { repository: repo } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      issueProvider: "github",
      issueKey,
      codeProvider: "github",
      repository: repo,
      number: 41,
      url: `https://github.com/${repo}/pull/41`,
      agentId,
      openedByRunId: childId,
      state: "open",
    });

    expect(await openSiblingsForIssue(db, { provider: "github", key: issueKey })).toEqual([
      { repository: repo, number: 41, openedByRunId: childId },
    ]);

    await handlePullRequestClosed(db, undefined, {
      codeProvider: "github",
      repository: repo,
      number: 41,
      merged: true,
    });
    expect((await db.issuePullRequest.findFirstOrThrow({ where: { repository: repo, number: 41 } })).state).toBe(
      "merged",
    );
    expect(await openSiblingsForIssue(db, { provider: "github", key: issueKey })).toEqual([]);
  });

  it("a pull request mention records nothing", async () => {
    const { runId } = await mentionRun("pr", "PR", 41, { ...opened(42) }, "succeeded");
    await completeHostStatus(db, { id: runId, status: "succeeded", finalText: "done" }, { github: host() });
    expect(await db.issuePullRequest.count({ where: { repository: repo, number: 42 } })).toBe(0);
  });
});
