import { describe, expect, it, vi } from "vitest";
import type { RunStatus } from "#prisma";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { CONTINUATION_CLOSED_HOST_LINE } from "../coding/continuation-wording.js";
import {
  collectRunOutcome,
  completeHostStatus,
  fullReplyComments,
  fullReplyOf,
  GITHUB_REPLY_MAX_CHARS,
  isIssueMentionTask,
  mentionStatusRow,
  outcomeBody,
  postMentionStatus,
  REPLY_MAX_PARTS,
  workingBody,
} from "./host-status.js";

const REPO = "chfields/knock-knock-jokes";

function host(): CodeReviewHost & { comment: ReturnType<typeof vi.fn>; editComment: ReturnType<typeof vi.fn> } {
  return {
    provider: "github",
    repositoryPermission: vi.fn(),
    readPullRequest: vi.fn(),
    pullRequestHead: vi.fn(),
    readFile: vi.fn(),
    listFiles: vi.fn(),
    publishReview: vi.fn(),
    comment: vi.fn(async () => ({ url: "https://x/c", id: "501" })),
    editComment: vi.fn(async () => undefined),
    acknowledge: vi.fn(),
    startCheck: vi.fn(),
    completeCheck: vi.fn(),
  };
}

type StatusRow = {
  runId: string;
  provider: string;
  repository: string;
  number: number;
  commentKind: string;
  commentId: string | null;
  replyToReviewCommentId: string | null;
  completedAt: Date | null;
};

function db(opts: { row?: StatusRow | null; children?: unknown[]; run?: unknown; claimed?: number } = {}) {
  return {
    runHostStatus: {
      findUnique: vi.fn(async () => opts.row ?? null),
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: opts.claimed ?? 1 })),
    },
    run: {
      findMany: vi.fn(async () => opts.children ?? []),
      findUnique: vi.fn(async () => opts.run ?? null),
    },
  };
}

const row = (over: Partial<StatusRow> = {}): StatusRow => ({
  runId: "r1",
  provider: "github",
  repository: REPO,
  number: 71,
  commentKind: "conversation",
  commentId: "501",
  replyToReviewCommentId: null,
  completedAt: null,
  ...over,
});

const child = (result: unknown, status = "succeeded", id = "c1") => ({ id, status, codingRun: { result } });

describe("mentionStatusRow", () => {
  it("records where to comment, replying in the thread for an inline mention", () => {
    expect(mentionStatusRow("github", { repository: REPO, number: 7 }, "r1")).toEqual({
      runId: "r1",
      provider: "github",
      repository: REPO,
      number: 7,
      commentKind: "conversation",
      replyToReviewCommentId: null,
    });
    expect(
      mentionStatusRow("github", { repository: REPO, number: 7, replyToReviewCommentId: "88" }, "r1"),
    ).toMatchObject({ commentKind: "inline", replyToReviewCommentId: "88" });
  });
});

describe("outcomeBody", () => {
  const run = (status: RunStatus, finalText: string | null = null) => ({ id: "r1", status, finalText });

  it("uses a custom no-pull-request sentence when given", () => {
    const body = outcomeBody(run("succeeded", "hi"), REPO, [], [], { noPullRequestText: "Done." });
    expect(body).toMatch(/^✅ Done\.\n\n> hi/);
  });
  it("shows the reply itself, capped, when it is the answer", () => {
    expect(outcomeBody(run("succeeded", "Filed it."), REPO, [], [], { replyAsAnswer: true })).toMatch(
      /^✅ Filed it\.\n\n/,
    );
    const long = outcomeBody(run("succeeded", "x".repeat(2500)), REPO, [], [], { replyAsAnswer: true });
    expect(long).toContain(`✅ ${"x".repeat(2000)}…`);
    expect(
      outcomeBody(run("succeeded", null), REPO, [], [], { replyAsAnswer: true, noPullRequestText: "Done." }),
    ).toMatch(/^✅ Done\./);
  });
  it("links the pull requests a coding sub-run opened or updated", () => {
    const body = outcomeBody(run("succeeded"), REPO, [
      { outcome: "pull_request_opened", repository: REPO, pullRequestNumber: 73, codeProvider: "github" },
      { outcome: "pull_request_updated", repository: REPO, pullRequestNumber: 68, codeProvider: "github" },
      { outcome: "pull_request_opened", repository: "other/repo", pullRequestNumber: 5, codeProvider: "github" },
    ]);
    expect(body).toContain("✅ Opened #73");
    expect(body).toContain("Pushed changes to #68");
    expect(body).toContain("Opened other/repo#5");
    expect(body).toContain("`r1`");
  });

  it("flags a pull request whose run had failing checks instead of a plain ✅", () => {
    const body = outcomeBody(run("succeeded"), REPO, [
      {
        outcome: "pull_request_opened",
        repository: REPO,
        pullRequestNumber: 3,
        codeProvider: "github",
        failedChecks: 2,
      },
    ]);
    expect(body).toMatch(/^⚠️ Opened #3, but 2 checks failed in the run/);
    expect(body).not.toContain("✅");
  });

  it("shows the agent's reply, quoted and without live @-mentions, when no pull request came out", () => {
    const body = outcomeBody(run("succeeded", "Which file?\n@chfields please say"), REPO, []);
    expect(body).toMatch(/^✅ Finished without opening a pull request\./);
    expect(body).toContain("> Which file?\n> @​chfields please say");
  });

  it("truncates a long reply", () => {
    const body = outcomeBody(run("succeeded", "x".repeat(5000)), REPO, []);
    expect(body.length).toBeLessThan(2500);
    expect(body).toContain("…");
  });

  it("reports a failed sub-run as a failure even though the agent itself succeeded", () => {
    const body = outcomeBody(
      run("succeeded", "FAILED: delegate_to_build — status: failed"),
      REPO,
      [],
      [{ id: "c9", status: "failed" }],
    );
    expect(body).toMatch(/^❌ A sub-run did not succeed: `c9` \(`failed`\)\./);
    expect(body).toContain("> FAILED: delegate_to_build");
    expect(body).not.toContain("✅");
  });

  it("tells the requester to retry a run that was lost", () => {
    const body = outcomeBody(run("lost"), REPO, []);
    expect(body).toMatch(/^❌ Interrupted before it finished .*Repeat your request to retry\./);
  });

  it("reports a run that ran out of budget, or could not start for lack of it, with the budget sentence", () => {
    const sentence = "Out of budget: this run's $3.00 budget was used up.";
    const body = outcomeBody(run("budget_exhausted", "internal detail"), REPO, [], [], { budgetSentence: sentence });
    expect(body).toBe(`❌ ${sentence}\n\n<sub>wardby run \`r1\`</sub>`);
    const refused = outcomeBody(run("refused"), REPO, [], [], {
      budgetSentence: "Out of budget: this run could not start within its $1.00 budget.",
    });
    expect(refused).toMatch(/^❌ Out of budget: this run could not start/);
    // Without numbers it still says why.
    expect(outcomeBody(run("budget_exhausted"), REPO, [])).toMatch(/^❌ Out of budget\./);
  });

  it("says a sub-run ran out of budget", () => {
    const body = outcomeBody(run("succeeded", "done"), REPO, [], [{ id: "c9", status: "budget_exhausted" }]);
    expect(body).toMatch(/^❌ A sub-run ran out of budget: `c9`\./);
    const mixed = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [
        { id: "c9", status: "budget_exhausted" },
        { id: "c10", status: "failed" },
      ],
    );
    expect(mixed).toMatch(/^❌ A sub-run ran out of budget: `c9`\. A sub-run did not succeed: `c10` \(`failed`\)\./);
  });

  it("says a sub-run stopped at its budget kept its changes in a pull request it can be continued from", () => {
    const opened = {
      outcome: "pull_request_opened" as const,
      repository: REPO,
      pullRequestNumber: 42,
      codeProvider: "github",
      runId: "c9",
    };
    const body = outcomeBody(run("succeeded", "done"), REPO, [opened], [{ id: "c9", status: "budget_exhausted" }]);
    expect(body).toBe(
      "⚠️ A sub-run ran out of budget before finishing. The changes so far are in draft PR #42; comment `@wardby` on it to continue.\n\n> done\n\n<sub>wardby run `r1`</sub>",
    );
    const updated = outcomeBody(
      run("succeeded"),
      REPO,
      [{ ...opened, outcome: "pull_request_updated" }],
      [
        { id: "c9", status: "budget_exhausted" },
        { id: "c10", status: "failed" },
      ],
    );
    expect(updated).toMatch(
      /^❌ A sub-run ran out of budget before finishing\. The changes so far are in #42; comment `@wardby` on it to continue\. A sub-run did not succeed: `c10` \(`failed`\)\./,
    );
    expect(updated).not.toContain("Pushed changes to #42");
  });

  it("says a sub-run could not reach the model, naming the class of provider failure but not its code", () => {
    const quota = outcomeBody(
      run("succeeded", "done"),
      REPO,
      [],
      [{ id: "c9", status: "failed", failureCategory: "provider_quota" }],
    );
    expect(quota).toMatch(
      /^❌ A sub-run could not reach the model: The model provider refused the request: its account has reached a spending or quota limit\. An operator needs to raise the limit with the provider, then retry\./,
    );
    expect(quota).not.toContain("did not succeed");
    const mixed = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [
        { id: "c9", status: "failed", failureCategory: "provider_rate_limited" },
        { id: "c10", status: "failed", failureCategory: "provider_rate_limited" },
        { id: "c11", status: "failed", failureCategory: "job" },
      ],
    );
    expect(mixed).toMatch(
      /^❌ A sub-run could not reach the model: The model provider is rate-limiting requests\. Try again later\. A sub-run did not succeed: `c11` \(`failed`\)\./,
    );
    expect(mixed.match(/rate-limiting/g)).toHaveLength(1);
  });

  it("says a coding sub-run could not start because of its services, in the host sentence only", () => {
    const refused = outcomeBody(
      run("succeeded", "done"),
      REPO,
      [],
      [
        {
          id: "c9",
          status: "refused",
          error:
            "service_not_allowed: This repository asks for `redis`, which this agent isn't allowed to use. An admin or the agent's owner can allow it.",
        },
      ],
    );
    expect(refused).toMatch(
      /^❌ A sub-run could not start: This repository asks for `redis`, which this agent isn't allowed to use\. An admin or the agent's owner can allow it\./,
    );
    expect(refused).not.toContain("service_not_allowed");
    expect(refused).not.toContain("did not succeed");

    const unready = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [{ id: "c9", status: "failed", failureCategory: "service_unready", services: ["postgres"] }],
    );
    expect(unready).toMatch(
      /^❌ A sub-run could not start: The `postgres` service didn't become ready, so the run couldn't start\./,
    );
  });

  it("says a coding sub-run could not open its changes when it touched a protected path, without naming it, and doesn't double-count it", () => {
    const body = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [{ id: "c9", status: "failed", failureCategory: "protected_path" }],
    );
    expect(body).toBe(
      "❌ A sub-run could not open its changes: it changed a file its agent may not edit, so none of its changes were kept.\n\n<sub>wardby run `r1`</sub>",
    );
    expect(body).not.toContain("did not succeed");
  });

  it("says a sub-run's PR was no longer open, without the error code", () => {
    const body = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [{ id: "c1", status: "failed", failureCategory: "continuation_closed" }],
    );
    expect(body).toContain(CONTINUATION_CLOSED_HOST_LINE);
    expect(body).not.toContain("did not succeed");
  });

  it('says the same thing when the sub-run\'s PR closed before it spent anything (status "refused")', () => {
    const body = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [{ id: "c1", status: "refused", failureCategory: "continuation_closed" }],
    );
    expect(body).toContain(CONTINUATION_CLOSED_HOST_LINE);
    expect(body).not.toContain("did not succeed");
  });

  it("still reports a sub-run refused for budget by its status", () => {
    const body = outcomeBody(
      run("succeeded"),
      REPO,
      [],
      [
        {
          id: "c9",
          status: "refused",
          error: "run_tree_exhausted: the run tree's shared budget is spent; the run was not started.",
        },
      ],
    );
    expect(body).toMatch(/A sub-run did not succeed: `c9` \(`refused`\)\./);
    expect(body).not.toContain("run_tree_exhausted");
  });

  it("reports any other unsuccessful run by its status, never its error text", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const body = outcomeBody(run(status, "secret-ish internal detail"), REPO, []);
      expect(body).toMatch(/^❌ Stopped/);
      expect(body).toContain(`\`${status}\``);
      expect(body).not.toContain("secret-ish");
    }
  });

  it("still links a pull request a failed run managed to open", () => {
    const body = outcomeBody(run("failed"), REPO, [
      { outcome: "pull_request_opened", repository: REPO, pullRequestNumber: 80, codeProvider: "github" },
    ]);
    expect(body).toMatch(/^❌ /);
    expect(body).toContain("Opened #80");
  });
});

describe("postMentionStatus", () => {
  it("posts the working comment and records it on the dispatch-time row", async () => {
    const h = host();
    const d = db({ row: row({ commentId: null }), run: { id: "r1", status: "running", finalText: null } });
    await postMentionStatus(d as never, h, "r1", undefined);
    expect(h.comment).toHaveBeenCalledWith(REPO, { number: 71, body: workingBody("r1") });
    expect(d.runHostStatus.updateMany).toHaveBeenCalledWith({
      where: { runId: "r1", commentId: null, completedAt: null },
      data: { commentId: "501" },
    });
    expect(h.editComment).not.toHaveBeenCalled();
  });

  it("replies in the review thread for an inline mention", async () => {
    const h = host();
    const d = db({
      row: row({ commentId: null, commentKind: "inline", replyToReviewCommentId: "88" }),
      run: { id: "r1", status: "running", finalText: null },
    });
    await postMentionStatus(d as never, h, "r1", undefined);
    expect(h.comment).toHaveBeenCalledWith(REPO, { number: 71, body: workingBody("r1"), replyToReviewCommentId: "88" });
  });

  it("does nothing without a row, or when the comment exists or the row is complete", async () => {
    for (const r of [null, row(), row({ commentId: null, completedAt: new Date() })]) {
      const h = host();
      await postMentionStatus(db({ row: r }) as never, h, "r1", undefined);
      expect(h.comment).not.toHaveBeenCalled();
    }
  });

  it("completes the comment at once when the run already ended", async () => {
    const h = host();
    const d = db({ row: row({ commentId: null }), run: { id: "r1", status: "failed", finalText: null } });
    // After the claim, completeHostStatus reads the row with its new comment.
    d.runHostStatus.findUnique.mockResolvedValueOnce(row({ commentId: null })).mockResolvedValueOnce(row());
    await postMentionStatus(d as never, h, "r1", { github: h });
    expect(h.editComment).toHaveBeenCalledWith(REPO, expect.objectContaining({ id: "501", kind: "conversation" }));
  });

  it("stops when the reconciler completed the row meanwhile", async () => {
    const h = host();
    const d = db({ row: row({ commentId: null }), claimed: 0, run: { id: "r1", status: "failed", finalText: null } });
    await postMentionStatus(d as never, h, "r1", { github: h });
    expect(h.editComment).not.toHaveBeenCalled();
    expect(d.run.findUnique).not.toHaveBeenCalled();
  });

  it("never throws when the host refuses", async () => {
    const h = host();
    h.comment.mockRejectedValue(new Error("boom"));
    const d = db({ row: row({ commentId: null }) });
    await expect(postMentionStatus(d as never, h, "r1", undefined)).resolves.toBeUndefined();
    expect(d.runHostStatus.updateMany).not.toHaveBeenCalled();
  });
});

describe("completeHostStatus", () => {
  const finished = { id: "r1", status: "succeeded", finalText: "done" } as const;

  it("edits the comment with the outcome and marks it complete", async () => {
    const h = host();
    const d = db({
      row: row(),
      children: [
        child({ outcome: "pull_request_opened", repository: REPO, pullRequestNumber: 73, codeProvider: "github" }),
        child(null),
      ],
    });
    await completeHostStatus(d as never, finished, { github: h });
    expect(d.run.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { parentRunId: "r1" } }));
    expect(h.editComment).toHaveBeenCalledWith(REPO, {
      kind: "conversation",
      id: "501",
      body: expect.stringContaining("Opened #73"),
    });
    expect(d.runHostStatus.updateMany).toHaveBeenCalledWith({
      where: { runId: "r1", completedAt: null },
      data: { commentId: "501", completedAt: expect.any(Date) },
    });
  });

  it("marks a failed sub-run as a failure", async () => {
    const h = host();
    const d = db({ row: row(), children: [child(null, "failed", "c9"), child(null, "running", "c10")] });
    await completeHostStatus(d as never, finished, { github: h });
    expect(h.editComment.mock.calls[0][1].body).toMatch(/^❌ A sub-run did not succeed: `c9` \(`failed`\)\./);
  });

  it("reads a failed sub-run's failure category to say the model provider refused it", async () => {
    const h = host();
    const d = db({
      row: row(),
      children: [{ id: "c9", status: "failed", codingRun: { result: null, failureCategory: "provider_unavailable" } }],
    });
    await completeHostStatus(d as never, finished, { github: h });
    expect(d.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          codingRun: { select: expect.objectContaining({ result: true, failureCategory: true }) },
        }),
      }),
    );
    expect(h.editComment.mock.calls[0][1].body).toMatch(
      /^❌ A sub-run could not reach the model: The model provider reported an outage or overload\. Try again later\./,
    );
  });

  it("reads each child's error and services, so a service refusal can be named", async () => {
    const d = db({
      row: row(),
      children: [
        {
          id: "c1",
          status: "failed",
          error: "coding_failure_service_unready:coding_diag_1",
          codingRun: {
            result: null,
            failureCategory: "service_unready",
            services: [{ name: "postgres", version: "16" }],
          },
        },
      ],
    });
    const h = host();
    await completeHostStatus(d as never, { id: "r1", status: "succeeded", finalText: "done" }, { github: h });
    expect(d.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          error: true,
          codingRun: { select: expect.objectContaining({ failureCategory: true, services: true }) },
        }),
      }),
    );
    expect(h.editComment.mock.calls[0][1].body).toMatch(/The `postgres` service didn't become ready/);
  });

  it("reports a run that ran out of budget with its amounts", async () => {
    const h = host();
    const d = db({
      row: row(),
      run: { agent: { budgetUsd: 3, budgetGroup: { name: "reviewers" } }, codingRun: { budgetReservedUsd: 0.52 } },
    });
    await completeHostStatus(d as never, { id: "r1", status: "budget_exhausted", finalText: null }, { github: h });
    expect(h.editComment.mock.calls[0][1].body).toMatch(
      /^❌ Out of budget: this run's \$0\.52 budget was used up \(the "reviewers" budget group had only that much left of its limit\)\./,
    );
  });

  it("leaves a row without a comment to the follow-up, unless asked to post", async () => {
    const h = host();
    const d = db({ row: row({ commentId: null }) });
    await completeHostStatus(d as never, { id: "r1", status: "lost", finalText: null }, { github: h });
    expect(h.comment).not.toHaveBeenCalled();
    expect(d.runHostStatus.updateMany).not.toHaveBeenCalled();

    await completeHostStatus(
      d as never,
      { id: "r1", status: "lost", finalText: null },
      { github: h },
      {
        postIfMissing: true,
      },
    );
    expect(h.comment).toHaveBeenCalledWith(REPO, {
      number: 71,
      body: expect.stringMatching(/^❌ Interrupted before it finished/),
    });
    expect(d.runHostStatus.updateMany).toHaveBeenCalledWith({
      where: { runId: "r1", completedAt: null },
      data: { commentId: "501", completedAt: expect.any(Date) },
    });
  });

  it("posts a missing outcome as a reply in the review thread for an inline mention", async () => {
    const h = host();
    const d = db({ row: row({ commentId: null, commentKind: "inline", replyToReviewCommentId: "88" }) });
    await completeHostStatus(
      d as never,
      { id: "r1", status: "lost", finalText: null },
      { github: h },
      {
        postIfMissing: true,
      },
    );
    expect(h.comment).toHaveBeenCalledWith(REPO, expect.objectContaining({ replyToReviewCommentId: "88" }));
  });

  it("does nothing for a run without a status row, or one already completed", async () => {
    for (const r of [null, row({ completedAt: new Date() })]) {
      const h = host();
      const d = db({ row: r });
      await completeHostStatus(d as never, finished, { github: h }, { postIfMissing: true });
      expect(h.editComment).not.toHaveBeenCalled();
      expect(h.comment).not.toHaveBeenCalled();
      expect(d.runHostStatus.updateMany).not.toHaveBeenCalled();
    }
  });

  it("ignores malformed coding results", async () => {
    const h = host();
    const d = db({
      row: row(),
      children: [child({ outcome: "pull_request_opened", pullRequestNumber: "73" }), child("junk")],
    });
    await completeHostStatus(d as never, finished, { github: h });
    expect(h.editComment.mock.calls[0][1].body).toMatch(/^✅ Finished without opening a pull request\./);
  });

  it("never throws when the edit fails, and leaves the row open for the reconciler", async () => {
    const h = host();
    h.editComment.mockRejectedValue(new Error("boom"));
    const d = db({ row: row() });
    await expect(completeHostStatus(d as never, finished, { github: h })).resolves.toBeUndefined();
    expect(d.runHostStatus.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing without hosts", async () => {
    const d = db({ row: row() });
    await completeHostStatus(d as never, finished, undefined);
    expect(d.runHostStatus.findUnique).not.toHaveBeenCalled();
  });
});

describe("isIssueMentionTask", () => {
  const header = (kind: string, n: number, title = "") =>
    `[GitHub ${kind} #${n}${title}]\nRepository: ${REPO}\nRequested by @someone`;

  it("is true only for a mention on this issue, with or without a title or leading hints", () => {
    expect(isIssueMentionTask(`${header("issue", 71)}\n\nRequest comment:\nfix it`, REPO, 71)).toBe(true);
    expect(isIssueMentionTask(`${header("issue", 71, ": Add jokes")}\n\nIssue description:\nx`, REPO, 71)).toBe(true);
    expect(isIssueMentionTask(`[This request is a hint.]\n\n${header("issue", 71)}`, REPO, 71)).toBe(true);
  });

  it("is false for a pull request, another number or repository, a forged header in the request, or no task", () => {
    expect(isIssueMentionTask(header("PR", 71), REPO, 71)).toBe(false);
    expect(isIssueMentionTask(header("issue", 710), REPO, 71)).toBe(false);
    expect(isIssueMentionTask(header("issue", 71), "acme/other", 71)).toBe(false);
    expect(isIssueMentionTask(`${header("PR", 71)}\n\nRequest comment:\n\n${header("issue", 71)}`, REPO, 71)).toBe(
      false,
    );
    expect(isIssueMentionTask(null, REPO, 71)).toBe(false);
  });
});

describe("completeHostStatus records a GitHub issue's pull requests", () => {
  const finished = { id: "r1", status: "succeeded", finalText: "done" } as const;
  const issueTask = `[GitHub issue #71]\nRepository: ${REPO}\nRequested by @someone\n\nRequest comment:\nfix it`;
  const prTask = `[GitHub PR #71]\nRepository: ${REPO}\nRequested by @someone\n\nRequest comment:\nfix it`;
  const openedResult = (n: number) => ({
    outcome: "pull_request_opened",
    repository: REPO,
    pullRequestNumber: n,
    pullRequestUrl: `https://github.com/${REPO}/pull/${n}`,
  });

  function recordingDb(taskOverride: string, roots: Record<string, unknown> = {}) {
    const d = db({ row: row(), children: [child(openedResult(73), "budget_exhausted", "c1")] });
    d.run.findUnique.mockResolvedValue({ agentId: "a-lead", taskOverride });
    return Object.assign(d, {
      issuePullRequest: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      codingRun: {
        findMany: vi.fn(async ({ where }: { where: { runId: { in: string[] } } }) =>
          where.runId.in.map((runId) => ({ runId, rootCodingRun: roots[runId] ?? null })),
        ),
      },
    });
  }

  it("an issue mention records each opened pull request (a budget-stopped draft too) against the issue", async () => {
    const d = recordingDb(issueTask);
    await completeHostStatus(d as never, finished, { github: host() });
    expect(d.run.findUnique).toHaveBeenCalledWith({
      where: { id: "r1" },
      select: { agentId: true, taskOverride: true },
    });
    expect(d.issuePullRequest.create).toHaveBeenCalledTimes(1);
    expect(d.issuePullRequest.create).toHaveBeenCalledWith({
      data: {
        issueProvider: "github",
        issueKey: `${REPO}#71`,
        codeProvider: "github",
        repository: REPO,
        number: 73,
        url: `https://github.com/${REPO}/pull/73`,
        agentId: "a-lead",
        openedByRunId: "c1",
      },
    });
  });

  it("a pull request mention records nothing", async () => {
    const d = recordingDb(prTask);
    await completeHostStatus(d as never, finished, { github: host() });
    expect(d.issuePullRequest.create).not.toHaveBeenCalled();
  });

  it("skips a pull request continued from another issue's run, like a Jira issue", async () => {
    const d = recordingDb(issueTask, { c1: { issueProvider: "jira", issueKey: "PROJ-7" } });
    await completeHostStatus(d as never, finished, { github: host() });
    expect(d.issuePullRequest.create).not.toHaveBeenCalled();
  });

  it("a failing store still completes the status comment", async () => {
    const d = recordingDb(issueTask);
    d.issuePullRequest.findUnique.mockRejectedValue(new Error("db"));
    const h = host();
    await completeHostStatus(d as never, finished, { github: h });
    expect(h.editComment).toHaveBeenCalled();
    expect(d.runHostStatus.updateMany).toHaveBeenCalled();
  });
});

describe("collectRunOutcome", () => {
  it("returns opened PRs and failed children for a finished run", async () => {
    const database = {
      run: {
        findMany: vi.fn(async () => [
          {
            id: "c1",
            status: "succeeded",
            error: null,
            codingRun: {
              result: {
                outcome: "pull_request_opened",
                repository: "o/r",
                pullRequestNumber: 4,
                codeProvider: "github",
              },
              failureCategory: null,
              services: [],
            },
          },
          { id: "c2", status: "failed", error: null, codingRun: { result: null, failureCategory: "x", services: [] } },
        ]),
      },
    } as never;
    const out = await collectRunOutcome(database, { id: "r1", status: "succeeded", finalText: null });
    expect(out.pullRequests).toEqual([
      { outcome: "pull_request_opened", repository: "o/r", pullRequestNumber: 4, codeProvider: "github", runId: "c1" },
    ]);
    expect(out.failedChildren.map((c) => c.id)).toEqual(["c2"]);
    expect(out.budgetSentence).toBeUndefined();
  });

  it("counts a pull request's failed checks from the coding result", async () => {
    const database = {
      run: {
        findMany: vi.fn(async () => [
          {
            id: "c1",
            status: "succeeded",
            error: null,
            codingRun: {
              result: {
                outcome: "pull_request_opened",
                repository: "o/r",
                pullRequestNumber: 4,
                tests: [
                  { command: "npm run typecheck", outcome: "failed" },
                  { command: "npm run build", outcome: "failed" },
                  { command: "npm run e2e", outcome: "skipped" },
                ],
              },
              failureCategory: null,
              services: [],
            },
          },
        ]),
      },
    } as never;
    const out = await collectRunOutcome(database, { id: "r1", status: "succeeded", finalText: null });
    expect(out.pullRequests[0].failedChecks).toBe(2);
  });
});

describe("package audit mode in the outcome", () => {
  const child = (id: string, status: string, packageAuditMode: string | null, result: unknown = null) => ({
    id,
    status,
    error: null,
    codingRun: { result, failureCategory: null, services: [], packageAuditMode },
  });
  const auditDb = (children: unknown[], rows: unknown[]) =>
    ({
      run: { findMany: vi.fn(async () => children) },
      registryFetch: { findMany: vi.fn(async () => []) },
      registryAuditRecord: { findMany: vi.fn(async () => rows) },
    }) as never;
  const row = (name: string, relation: string, extra: Record<string, unknown> = {}) => ({
    ecosystem: "npm",
    name,
    version: "1.0.0",
    relation,
    via: null,
    sizeBytes: 1,
    advisories: [],
    ...extra,
  });

  it("collects the coding children's audit rows and the strongest mode", async () => {
    const database = auditDb(
      [child("c1", "succeeded", "audit"), child("c2", "succeeded", "full"), child("c3", "succeeded", null)],
      [row("expo-dev-client", "top-level")],
    );
    const out = await collectRunOutcome(database, { id: "r1", status: "succeeded", finalText: null });
    expect(out.packageAudit?.mode).toBe("full");
    expect(out.packageAudit?.summary.toApprove).toEqual([
      { ecosystem: "npm", name: "expo-dev-client", dependencies: 0 },
    ]);
  });

  it("collects nothing when no child had the mode", async () => {
    const database = auditDb([child("c1", "succeeded", null)], [row("x", "top-level")]);
    const out = await collectRunOutcome(database, { id: "r1", status: "succeeded", finalText: null });
    expect(out.packageAudit).toBeUndefined();
  });

  it("puts the audit block above the run line, whatever the outcome", async () => {
    const database = auditDb([child("c1", "failed", "audit")], [row("expo-dev-client", "top-level")]);
    const run = { id: "r1", status: "succeeded" as const, finalText: null };
    const out = await collectRunOutcome(database, run);
    const body = outcomeBody(run, REPO, out.pullRequests, out.failedChildren, { packageAudit: out.packageAudit });
    const block = body.indexOf("🔎 **Package audit mode (`audit`) was on:**");
    expect(block).toBeGreaterThan(-1);
    expect(body).toContain("`expo-dev-client` (npm)");
    expect(block).toBeLessThan(body.indexOf("r1"));
    const lost = outcomeBody({ ...run, status: "lost" }, REPO, [], [], { packageAudit: out.packageAudit });
    expect(lost).toContain("🔎 **Package audit mode (`audit`) was on:**");
  });
});

describe("full replies", () => {
  const POINTER = "✅ Finished without opening a pull request. The full reply follows in the next comment(s).";
  const pr = {
    outcome: "pull_request_opened" as const,
    repository: REPO,
    pullRequestNumber: 73,
    codeProvider: "github",
  };
  /** A plan-shaped reply: Markdown sections of paragraphs, `chars` long. */
  const plan = (chars: number): string => {
    const section = (i: number) => `## Step ${i}\n\n${"Do the thing carefully. ".repeat(40).trim()}\n\n`;
    let text = "";
    for (let i = 1; text.length < chars; i++) text += section(i);
    return text.slice(0, chars).trim();
  };
  const succeeded = (finalText: string) => ({ id: "r1", status: "succeeded" as const, finalText });

  describe("fullReplyOf", () => {
    it("is the trimmed reply only for a succeeded run with no PR, no failed child and a reply over the quote limit", () => {
      const long = plan(2500);
      expect(fullReplyOf(succeeded(`  ${long}\n`), [], [])).toBe(long);
      expect(fullReplyOf(succeeded("x".repeat(2000)), [], [])).toBeNull();
      expect(fullReplyOf(succeeded(long), [pr], [])).toBeNull();
      expect(fullReplyOf(succeeded(long), [], [{ id: "c9", status: "failed" }])).toBeNull();
      expect(fullReplyOf({ id: "r1", status: "failed", finalText: long }, [], [])).toBeNull();
      expect(fullReplyOf({ id: "r1", status: "succeeded", finalText: null }, [], [])).toBeNull();
    });
  });

  describe("fullReplyComments", () => {
    const opts = { maxChars: GITHUB_REPLY_MAX_CHARS, maxParts: REPLY_MAX_PARTS };

    it("numbers the parts and keeps every comment within the limit, header included", () => {
      const reply = plan(150_000);
      const bodies = fullReplyComments(reply, opts);
      expect(bodies).toHaveLength(3);
      bodies.forEach((body, i) => {
        expect(body.startsWith(`**Reply, part ${i + 1} of 3**\n\n`)).toBe(true);
        expect(body.length).toBeLessThanOrEqual(60_000);
      });
      const text = bodies.map((b) => b.replace(/^\*\*Reply, part \d of 3\*\*\n\n/, "")).join("");
      expect(text).toBe(reply);
      expect(bodies.join("")).not.toContain("was cut");
    });

    it("stops at four parts and ends the last with the cut note", () => {
      const bodies = fullReplyComments(plan(300_000), opts);
      expect(bodies).toHaveLength(4);
      for (const body of bodies) expect(body.length).toBeLessThanOrEqual(60_000);
      expect(bodies[3]).toMatch(/^\*\*Reply, part 4 of 4\*\*\n\n/);
      expect(bodies[3]).toMatch(/The rest of the reply was cut.*`get_run`.*`finalText`/s);
      for (const body of bodies.slice(0, 3)) expect(body).not.toContain("was cut");
    });

    it("keeps the header and cut note within a small limit too", () => {
      const bodies = fullReplyComments("y".repeat(10_000), { maxChars: 1000, maxParts: 2 });
      expect(bodies).toHaveLength(2);
      for (const body of bodies) expect(body.length).toBeLessThanOrEqual(1000);
      expect(bodies[1]).toContain("The rest of the reply was cut");
    });
  });

  describe("outcomeBody", () => {
    it("points to the follow-up comments instead of quoting a long reply", () => {
      const body = outcomeBody(succeeded(plan(11_000)), REPO, [], [], { fullReplyFollows: true });
      expect(body).toBe(`${POINTER}\n\n<sub>wardby run \`r1\`</sub>`);
    });

    it("points to the follow-ups for a long reply that is the answer (Jira)", () => {
      const body = outcomeBody(succeeded(plan(11_000)), "", [], [], {
        replyAsAnswer: true,
        noPullRequestText: "Done.",
        fullReplyFollows: true,
      });
      expect(body).toBe("✅ The full reply follows in the next comment(s).\n\n<sub>wardby run `r1`</sub>");
    });

    it("leaves a short reply, a PR link and a failed child as they were", () => {
      const opts = { fullReplyFollows: true };
      expect(outcomeBody(succeeded("Which file?"), REPO, [], [], opts)).toBe(
        outcomeBody(succeeded("Which file?"), REPO, []),
      );
      const long = plan(11_000);
      expect(outcomeBody(succeeded(long), REPO, [pr], [], opts)).toBe(`✅ Opened #73.\n\n<sub>wardby run \`r1\`</sub>`);
      const failed = outcomeBody(succeeded(long), REPO, [], [{ id: "c9", status: "failed" }], opts);
      expect(failed).toMatch(/^❌ A sub-run did not succeed/);
      expect(failed).toContain("…");
      expect(failed.length).toBeLessThan(2300);
    });
  });

  describe("completeHostStatus", () => {
    it("edits the status to the pointer and posts the whole plan as one follow-up", async () => {
      const h = host();
      const d = db({ row: row() });
      const reply = plan(11_000);
      await completeHostStatus(d as never, succeeded(reply), { github: h });
      const status = h.editComment.mock.calls[0][1].body as string;
      expect(status).toMatch(/^✅ Finished without opening a pull request\. The full reply follows/);
      expect(status).not.toContain("> ");
      expect(h.comment).toHaveBeenCalledTimes(1);
      expect(h.comment).toHaveBeenCalledWith(REPO, { number: 71, body: `**Reply, part 1 of 1**\n\n${reply}` });
      expect(d.runHostStatus.updateMany).toHaveBeenCalledWith({
        where: { runId: "r1", completedAt: null },
        data: { commentId: "501", completedAt: expect.any(Date) },
      });
    });

    it("posts a 150,000-character reply as three parts, in order, each within GitHub's limit", async () => {
      const h = host();
      const d = db({ row: row() });
      await completeHostStatus(d as never, succeeded(plan(150_000)), { github: h });
      const bodies = h.comment.mock.calls.map((c) => (c[1] as { body: string }).body);
      expect(bodies).toHaveLength(3);
      bodies.forEach((body, i) => {
        expect(body).toMatch(new RegExp(`^\\*\\*Reply, part ${i + 1} of 3\\*\\*`));
        expect(body.length).toBeLessThanOrEqual(60_000);
      });
    });

    it("posts at most four parts of a 300,000-character reply, the last with the cut note", async () => {
      const h = host();
      const d = db({ row: row() });
      await completeHostStatus(d as never, succeeded(plan(300_000)), { github: h });
      const bodies = h.comment.mock.calls.map((c) => (c[1] as { body: string }).body);
      expect(bodies).toHaveLength(4);
      expect(bodies[3]).toContain("The rest of the reply was cut");
    });

    it("posts no follow-up for a short reply, a PR link, or a failed child", async () => {
      const long = plan(11_000);
      const cases = [
        {
          finalText: "Which file?",
          children: [] as unknown[],
          expected: /^✅ Finished without opening a pull request\.\n\n> Which file\?/,
        },
        { finalText: long, children: [child(pr)], expected: /^✅ Opened #73\.\n\n<sub>/ },
        { finalText: long, children: [child(null, "failed", "c9")], expected: /^❌ A sub-run did not succeed: `c9`/ },
      ];
      for (const { finalText, children, expected } of cases) {
        const h = host();
        const d = db({ row: row(), children });
        await completeHostStatus(d as never, succeeded(finalText), { github: h });
        const status = h.editComment.mock.calls[0][1].body as string;
        expect(status).toMatch(expected);
        expect(status).not.toContain("follows in the next comment");
        expect(h.comment).not.toHaveBeenCalled();
      }
    });

    it("keeps the 2,000-character quote for a failed child", async () => {
      const h = host();
      const d = db({ row: row(), children: [child(null, "failed", "c9")] });
      await completeHostStatus(d as never, succeeded("z".repeat(5000)), { github: h });
      expect(h.editComment.mock.calls[0][1].body).toContain(`> ${"z".repeat(2000)}…`);
    });

    it("defuses @-mentions in the follow-ups", async () => {
      const h = host();
      const d = db({ row: row() });
      await completeHostStatus(d as never, succeeded(`${plan(3000)}\n\nThanks @chfields and @wardby/team.`), {
        github: h,
      });
      const body = (h.comment.mock.calls[0][1] as { body: string }).body;
      expect(body).toContain("Thanks @\u200bchfields and @\u200bwardby/team.");
      expect(body).not.toMatch(/@(?!\u200b)\w/);
    });

    /**
     * A status row that remembers each write, so a second call sees what the first one wrote. updateMany
     * matches its `where` and writes in one step, as the database does, so only one of two racing claims wins.
     */
    const statefulDb = (initial: StatusRow) => {
      const d = db({ row: initial });
      let current: StatusRow = { ...initial };
      d.runHostStatus.findUnique.mockImplementation(async () => ({ ...current }));
      const update = vi.fn((args: { data: Partial<StatusRow> }) => {
        current = { ...current, ...args.data };
        return Promise.resolve(undefined);
      });
      const updateMany = vi.fn((args: { where: Partial<StatusRow>; data: Partial<StatusRow> }) => {
        const matches = Object.entries(args.where).every(([k, v]) => current[k as keyof StatusRow] === v);
        if (matches) current = { ...current, ...args.data };
        return Promise.resolve({ count: matches ? 1 : 0 });
      });
      return { d: { ...d, runHostStatus: { ...d.runHostStatus, update, updateMany } }, current: () => current };
    };

    it("posts the parts once when two completions race: only the one that claims the row posts them", async () => {
      const h = host();
      const { d, current } = statefulDb(row());
      const run = succeeded(plan(150_000));
      await Promise.all([
        completeHostStatus(d as never, run, { github: h }),
        completeHostStatus(d as never, run, { github: h }, { postIfMissing: true }),
      ]);
      const parts = h.comment.mock.calls.filter((c) => /^\*\*Reply, part/.test((c[1] as { body: string }).body));
      expect(parts).toHaveLength(3);
      expect(current().completedAt).toBeInstanceOf(Date);
    });

    it("claims the row before posting any part, and posts none when another completion claimed it", async () => {
      const h = host();
      const d = db({ row: row() });
      await completeHostStatus(d as never, succeeded(plan(11_000)), { github: h });
      expect(h.comment).toHaveBeenCalledTimes(1);
      expect(d.runHostStatus.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        h.comment.mock.invocationCallOrder[0],
      );
      expect(d.runHostStatus.updateMany).toHaveBeenCalledWith({
        where: { runId: "r1", completedAt: null },
        data: { commentId: "501", completedAt: expect.any(Date) },
      });
      expect(d.runHostStatus.update).not.toHaveBeenCalled();

      const lost = host();
      const taken = db({ row: row(), claimed: 0 });
      await expect(
        completeHostStatus(taken as never, succeeded(plan(11_000)), { github: lost }),
      ).resolves.toBeUndefined();
      expect(lost.editComment).toHaveBeenCalledTimes(1);
      expect(lost.comment).not.toHaveBeenCalled();
    });

    it("posts each part once: a failed part is logged, the row completed, and a retry posts nothing", async () => {
      const h = host();
      h.comment.mockResolvedValueOnce({ url: "https://x/p1", id: "601" }).mockRejectedValueOnce(new Error("boom"));
      const { d, current } = statefulDb(row());
      const run = succeeded(plan(150_000));
      await expect(completeHostStatus(d as never, run, { github: h })).resolves.toBeUndefined();
      // Stops at the failed part: part 3 without part 2 would read as a gap.
      expect(h.comment).toHaveBeenCalledTimes(2);
      expect((h.comment.mock.calls[1][1] as { body: string }).body).toMatch(/^\*\*Reply, part 2 of 3\*\*/);
      expect(current().completedAt).toBeInstanceOf(Date);

      await completeHostStatus(d as never, run, { github: h }, { postIfMissing: true });
      expect(h.comment).toHaveBeenCalledTimes(2);
      expect(h.editComment).toHaveBeenCalledTimes(1);
    });

    it("posts a missing status comment, saves its id at once, then posts the parts", async () => {
      const h = host();
      h.comment.mockResolvedValueOnce({ url: "https://x/s", id: "700" });
      const { d, current } = statefulDb(row({ commentId: null }));
      const reply = plan(11_000);
      await completeHostStatus(d as never, succeeded(reply), { github: h }, { postIfMissing: true });
      expect(h.comment).toHaveBeenCalledTimes(2);
      expect((h.comment.mock.calls[0][1] as { body: string }).body).toMatch(/^✅ .*The full reply follows/);
      expect(h.comment.mock.calls[1][1]).toEqual({ number: 71, body: `**Reply, part 1 of 1**\n\n${reply}` });
      // The claim saves the id with the completion, before any part, so a retry edits it instead of re-posting.
      expect(d.runHostStatus.updateMany).toHaveBeenCalledTimes(1);
      expect(d.runHostStatus.updateMany).toHaveBeenCalledWith({
        where: { runId: "r1", completedAt: null },
        data: { commentId: "700", completedAt: expect.any(Date) },
      });
      expect(d.runHostStatus.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        h.comment.mock.invocationCallOrder[1],
      );
      expect(current()).toMatchObject({ commentId: "700", completedAt: expect.any(Date) });
    });

    it("keeps a posted status comment's id when its first part fails, so it is never posted twice", async () => {
      const h = host();
      h.comment.mockResolvedValueOnce({ url: "https://x/s", id: "700" }).mockRejectedValueOnce(new Error("boom"));
      const { d, current } = statefulDb(row({ commentId: null }));
      const run = succeeded(plan(11_000));
      await expect(
        completeHostStatus(d as never, run, { github: h }, { postIfMissing: true }),
      ).resolves.toBeUndefined();
      expect(current().commentId).toBe("700");
      await completeHostStatus(d as never, run, { github: h }, { postIfMissing: true });
      expect(h.comment).toHaveBeenCalledTimes(2);
      const statusPosts = h.comment.mock.calls.filter((c) => /^✅/.test((c[1] as { body: string }).body));
      expect(statusPosts).toHaveLength(1);
    });

    it("says the reply follows in the pull request's conversation for a review-thread status", async () => {
      const h = host();
      const d = db({ row: row({ commentKind: "inline", replyToReviewCommentId: "88" }) });
      await completeHostStatus(d as never, succeeded(plan(11_000)), { github: h });
      expect(h.editComment.mock.calls[0][1]).toMatchObject({
        kind: "inline",
        body: "✅ Finished without opening a pull request. The full reply follows in this pull request's conversation.\n\n<sub>wardby run `r1`</sub>",
      });
      expect(h.comment).toHaveBeenCalledWith(REPO, {
        number: 71,
        body: expect.stringMatching(/^\*\*Reply, part 1 of 1/),
      });
    });
  });
});
