import { describe, expect, it, vi } from "vitest";
import { adfToText, markdownToAdf } from "../providers/issue-tracker/adf.js";
import { isStatusComment } from "../providers/issue-tracker/jira.js";
import type { IssueTracker } from "../providers/issue-tracker/types.js";
import {
  closeOrphanedIssueStatuses,
  completeIssueStatus,
  formatSpendLine,
  postIssueWorkingStatus,
  toJiraMarkdown,
} from "./issue-status.js";

function tracker(): IssueTracker {
  return {
    provider: "jira",
    botAccountId: vi.fn(async () => "bot-1"),
    createMeta: vi.fn(),
    fieldMeta: vi.fn(),
    createIssue: vi.fn(),
    readAttachmentText: vi.fn(),
    identity: vi.fn(async () => ({ accountId: "bot-1", displayName: "bot", accountType: "app" })),
    transitions: vi.fn(),
    transitionTo: vi.fn(),
    editableFields: vi.fn(),
    editFields: vi.fn(),
    linkTypes: vi.fn(),
    linkIssues: vi.fn(),
    addRemoteLink: vi.fn(),
    getProperty: vi.fn(),
    setProperty: vi.fn(),
    getIssue: vi.fn(),
    issueProject: vi.fn(async (key: string) => key.slice(0, key.lastIndexOf("-"))),
    snapshotIssue: vi.fn(async (key: string) => ({
      key,
      url: `https://example.test/browse/${key}`,
      scopeKey: key.slice(0, key.lastIndexOf("-")),
    })),
    search: vi.fn(),
    matchesJql: vi.fn(),
    comment: vi.fn(async () => ({ id: "c-1", url: "u" })),
    editComment: vi.fn(async () => undefined),
    readComment: vi.fn(),
    issueUrl: (k) => `https://your-site.atlassian.net/browse/${k}`,
  };
}

type SpendRows = { tree?: unknown; issue?: unknown; models?: unknown };

/** A $queryRaw tagged-template stub that answers the three spend queries by the table each one reads. */
function queryRaw(rows: SpendRows = {}) {
  return vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("RunModelUsage")) return rows.models ?? [];
    if (sql.includes("RunAttribution")) return rows.issue ?? [{ usd: null }];
    return rows.tree ?? [{ usd: null }];
  });
}

function db(
  row: Record<string, unknown> | null,
  run: Record<string, unknown> = { id: "r1", status: "running", finalText: null, agentId: "a1" },
  extra: Record<string, unknown> = {},
  link: Record<string, unknown> | null = { access: "write", commentVisibilityRole: null },
) {
  return {
    $queryRaw: queryRaw(),
    agentIssueProject: { findUnique: vi.fn(async () => link) },
    issuePullRequest: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    },
    codingRun: { findMany: vi.fn(async () => []) },
    runIssueStatus: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => undefined),
    },
    run: {
      findUnique: vi.fn(async () => run),
      findMany: vi.fn(async () => []),
      ...extra,
    },
  } as never;
}

describe("toJiraMarkdown", () => {
  it("turns the run footer into italics and PR refs into links", () => {
    expect(toJiraMarkdown("✅ Opened o/r#4.\n\n<sub>wardby run `r1`</sub>")).toBe(
      "✅ Opened [o/r#4](https://github.com/o/r/pull/4).\n\n_wardby run `r1`_",
    );
  });
});

describe("completeIssueStatus after the agent was unlinked", () => {
  const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-9", completedAt: null };
  const finished = { id: "r1", status: "succeeded", finalText: "SECRET REPLY" } as never;

  it("edits the comment with a status-only outcome and completes the row", async () => {
    const t = tracker();
    const d = db(row, { id: "r1", agentId: "a1" }, {}, null);
    await completeIssueStatus(d, finished, { jira: t });
    expect((d as any).agentIssueProject.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId_provider_projectKey: { agentId: "a1", provider: "jira", projectKey: "PROJ" } },
      }),
    );
    const md = (t.editComment as any).mock.calls[0][2].markdown as string;
    expect(md).toContain("Stopped reporting: this agent is no longer linked to PROJ.");
    expect(md).not.toContain("SECRET REPLY");
    expect(md).not.toContain("Agent spend");
    expect(md.trimEnd().split("\n").pop()).toMatch(/wardby run/);
    expect(isStatusComment(adfToText(markdownToAdf(md)))).toBe(true);
    expect((d as any).runIssueStatus.update).toHaveBeenCalled();
  });

  it("never posts a new comment into an unlinked project; it completes the row", async () => {
    const t = tracker();
    const d = db({ ...row, commentId: null }, { id: "r1", agentId: "a1" }, {}, null);
    await completeIssueStatus(d, finished, { jira: t }, { postIfMissing: true });
    expect(t.comment).not.toHaveBeenCalled();
    expect(t.editComment).not.toHaveBeenCalled();
    expect((d as any).runIssueStatus.update).toHaveBeenCalledWith({
      where: { runId: "r1" },
      data: { commentId: null, completedAt: expect.any(Date) },
    });
  });

  it.each([
    ["the run row is missing", null],
    ["the run has no agent", { id: "r1", agentId: null }],
  ])("treats %s as unlinked and leaks no reply", async (_n, runRow) => {
    const t = tracker();
    const d = db(row, runRow as never, {}, { commentVisibilityRole: null });
    await completeIssueStatus(d, finished, { jira: t });
    const md = (t.editComment as any).mock.calls[0][2].markdown as string;
    expect(md).toContain("no longer linked to PROJ");
    expect(md).not.toContain("SECRET REPLY");
  });

  it("posts a new comment with the link's current visibility role", async () => {
    const t = tracker();
    const d = db(
      { ...row, commentId: null, visibilityRole: "Old" },
      { id: "r1", agentId: "a1" },
      {},
      {
        access: "write",
        commentVisibilityRole: "Current",
      },
    );
    await completeIssueStatus(d, finished, { jira: t }, { postIfMissing: true });
    expect(t.comment).toHaveBeenCalledWith("PROJ-1", expect.objectContaining({ visibilityRole: "Current" }));
    expect((t.comment as any).mock.calls[0][1].markdown).toContain("SECRET REPLY");
  });
});

describe("completeIssueStatus after the link was downgraded to read", () => {
  const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-9", completedAt: null };
  const finished = { id: "r1", status: "succeeded", finalText: "SECRET REPLY" } as never;
  const readLink = { access: "read", commentVisibilityRole: null };

  it("edits the comment with a status-only outcome: no reply, no spend, footer last", async () => {
    const t = tracker();
    const d = db(row, { id: "r1", agentId: "a1", costUsd: 0.5 }, {}, readLink);
    await completeIssueStatus(d, finished, { jira: t });
    expect((d as any).agentIssueProject.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ access: true }) }),
    );
    const md = (t.editComment as any).mock.calls[0][2].markdown as string;
    expect(md).toContain("this agent's link to PROJ is now read-only");
    expect(md).not.toContain("SECRET REPLY");
    expect(md).not.toContain("Agent spend");
    expect(md.trimEnd().split("\n").pop()).toMatch(/^_wardby run `r1`_$/);
    expect(isStatusComment(adfToText(markdownToAdf(md)))).toBe(true);
    expect((d as any).runIssueStatus.update).toHaveBeenCalled();
  });

  it("never posts a new comment for a read link; it completes the row", async () => {
    const t = tracker();
    const d = db({ ...row, commentId: null }, { id: "r1", agentId: "a1" }, {}, readLink);
    await completeIssueStatus(d, finished, { jira: t }, { postIfMissing: true });
    expect(t.comment).not.toHaveBeenCalled();
    expect(t.editComment).not.toHaveBeenCalled();
    expect((d as any).runIssueStatus.update).toHaveBeenCalledWith({
      where: { runId: "r1" },
      data: { commentId: null, completedAt: expect.any(Date) },
    });
  });
});

describe("postIssueWorkingStatus", () => {
  it("posts once with the row's visibility and claims the row", async () => {
    const t = tracker();
    const d = db({
      runId: "r1",
      issueKey: "PROJ-1",
      provider: "jira",
      commentId: null,
      completedAt: null,
      visibilityRole: "Developers",
    });
    await postIssueWorkingStatus(d, { jira: t }, "r1");
    expect(t.comment).toHaveBeenCalledWith("PROJ-1", expect.objectContaining({ visibilityRole: "Developers" }));
    expect((d as any).runIssueStatus.updateMany).toHaveBeenCalledWith({
      where: { runId: "r1", commentId: null, completedAt: null },
      data: { commentId: "c-1" },
    });
  });
  it("does nothing when a comment already exists", async () => {
    const t = tracker();
    await postIssueWorkingStatus(
      db({ runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "x", completedAt: null }),
      { jira: t },
      "r1",
    );
    expect(t.comment).not.toHaveBeenCalled();
  });
});

describe("completeIssueStatus", () => {
  it("edits the working comment with the outcome and completes the row", async () => {
    const t = tracker();
    const d = db({ runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null });
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: "All done" }, { jira: t });
    expect(t.editComment).toHaveBeenCalledWith("PROJ-1", "c-1", {
      markdown: expect.stringContaining("All done"),
      issueKeyProjects: ["PROJ"],
    });
    expect((d as any).runIssueStatus.update).toHaveBeenCalledWith({
      where: { runId: "r1" },
      data: { commentId: "c-1", completedAt: expect.any(Date) },
    });
  });
  it("shows the agent's answer itself on Jira (one comment per request), unquoted", async () => {
    const t = tracker();
    const d = db({ runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null });
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: "Done. Triaged as a bug." }, { jira: t });
    const { markdown } = (t.editComment as any).mock.calls[0][2];
    expect(markdown).toMatch(/^✅ Done\. Triaged as a bug\./);
    expect(markdown).not.toContain("Done. Done.");
    expect(markdown).not.toContain("> ");
    expect(markdown).not.toContain("Finished without");
  });
  it('says "Done." on Jira when the run finished without a reply', async () => {
    const t = tracker();
    const d = db({ runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null });
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: null }, { jira: t });
    const { markdown } = (t.editComment as any).mock.calls[0][2];
    expect(markdown).toMatch(/^✅ Done\./);
  });
  it("shows the tree, issue and model spend above the footer, which stays last", async () => {
    const t = tracker();
    const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null };
    const d = db(row, { id: "r1", agentId: "a1", status: "succeeded", finalText: "ok" });
    (d as any).$queryRaw = queryRaw({
      tree: [{ usd: "1.84" }],
      issue: [{ usd: "4.12" }],
      models: [
        { model: "claude-sonnet-4-6", usd: "1.52" },
        { model: "claude-haiku-4-5", usd: "0.32" },
      ],
    });
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: "ok" }, { jira: t });
    const { markdown } = (t.editComment as any).mock.calls[0][2];
    const lines = markdown.trimEnd().split("\n");
    expect(markdown).toContain(
      "Agent spend: $1.84 this run · $4.12 on this issue so far · claude-sonnet-4-6 $1.52, claude-haiku-4-5 $0.32",
    );
    expect(lines.at(-1)).toMatch(/^_wardby run `r1`_$/);
    expect(isStatusComment(adfToText(markdownToAdf(markdown)))).toBe(true);
  });
  it("treats null costs as zero and omits the issue total for an unattributed run", async () => {
    const t = tracker();
    const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null };
    const d = db(row, { id: "r1", agentId: "a1", status: "succeeded", finalText: "ok", costUsd: null });
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: "ok" }, { jira: t });
    const { markdown } = (t.editComment as any).mock.calls[0][2];
    expect(markdown).toContain("Agent spend: $0.00 this run");
    expect(markdown).not.toContain("on this issue");
  });
  it("omits the spend line but still posts the outcome when the cost lookup fails", async () => {
    const t = tracker();
    const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null };
    const d = db(row, { id: "r1", agentId: "a1", status: "succeeded", finalText: "ok" });
    (d as any).$queryRaw = vi.fn(async () => {
      throw new Error("db down");
    });
    await completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: "ok" }, { jira: t });
    const { markdown } = (t.editComment as any).mock.calls[0][2];
    expect(markdown).not.toContain("Agent spend");
    expect(markdown).toMatch(/^✅ ok/);
    expect(markdown).toContain("wardby run `r1`");
  });
  it("leaves a comment-less row to the working-status follow-up unless postIfMissing", async () => {
    const t = tracker();
    const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: null, completedAt: null };
    await completeIssueStatus(db(row), { id: "r1", status: "failed", finalText: null }, { jira: t });
    expect(t.comment).not.toHaveBeenCalled();
    await completeIssueStatus(
      db(row),
      { id: "r1", status: "failed", finalText: null },
      { jira: t },
      { postIfMissing: true },
    );
    expect(t.comment).toHaveBeenCalledOnce();
  });
  it("never throws when Jira fails", async () => {
    const t = tracker();
    (t.editComment as any).mockRejectedValue(new Error("boom"));
    const d = db({ runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-1", completedAt: null });
    await expect(
      completeIssueStatus(d, { id: "r1", status: "succeeded", finalText: null }, { jira: t }),
    ).resolves.toBeUndefined();
    expect((d as any).runIssueStatus.update).not.toHaveBeenCalled();
  });
});

describe("closeOrphanedIssueStatuses", () => {
  const NOW = new Date("2026-09-30T12:00:00.000Z");

  function orphanDb(rows: Array<Record<string, unknown>>) {
    return {
      $queryRaw: queryRaw(),
      runIssueStatus: {
        findMany: vi.fn(async () => rows.map((r) => ({ run: { id: r.runId, status: "lost", finalText: null } }))),
        findUnique: vi.fn(async ({ where }: any) => rows.find((r) => r.runId === where.runId) ?? null),
        update: vi.fn(async () => undefined),
      },
      run: { findUnique: vi.fn(async () => ({ agentId: "a1" })), findMany: vi.fn(async () => []) },
      agentIssueProject: { findUnique: vi.fn(async () => ({ access: "write", commentVisibilityRole: "Dev" })) },
    } as never;
  }

  it("queries open statuses of configured providers whose run ended 2 minutes to a day ago, newest first", async () => {
    const d = orphanDb([]);
    await closeOrphanedIssueStatuses(d, { jira: tracker() }, NOW);
    expect((d as any).runIssueStatus.findMany).toHaveBeenCalledWith({
      where: {
        completedAt: null,
        provider: { in: ["jira"] },
        run: {
          status: { notIn: ["pending", "running"] },
          finishedAt: {
            lte: new Date(NOW.getTime() - 2 * 60 * 1000),
            gte: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
          },
        },
      },
      select: { run: { select: { id: true, status: true, finalText: true } } },
      orderBy: { run: { finishedAt: "desc" } },
      take: 20,
    });
  });

  it("posts the outcome as a new comment when the run died before its working comment", async () => {
    const t = tracker();
    const d = orphanDb([
      { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: null, completedAt: null, visibilityRole: "Dev" },
    ]);
    await closeOrphanedIssueStatuses(d, { jira: t }, NOW);
    expect(t.comment).toHaveBeenCalledWith("PROJ-1", {
      markdown: expect.stringMatching(/^❌ Interrupted before it finished/),
      issueKeyProjects: ["PROJ"],
      visibilityRole: "Dev",
    });
    expect((d as any).runIssueStatus.update).toHaveBeenCalledWith({
      where: { runId: "r1" },
      data: { commentId: "c-1", completedAt: expect.any(Date) },
    });
  });

  it("never queries without a configured tracker", async () => {
    const d = orphanDb([]);
    await closeOrphanedIssueStatuses(d, undefined, NOW);
    await closeOrphanedIssueStatuses(d, {}, NOW);
    expect((d as any).runIssueStatus.findMany).not.toHaveBeenCalled();
  });
});

describe("completeIssueStatus bridging pull requests to the issue", () => {
  const row = { runId: "r1", issueKey: "PROJ-1", provider: "jira", commentId: "c-9", completedAt: null };
  const finished = { id: "r1", status: "succeeded", finalText: "ok" } as never;
  const child = (outcome = "pull_request_opened") => ({
    id: "child-1",
    status: "succeeded",
    error: null,
    codingRun: {
      failureCategory: null,
      services: null,
      result: {
        outcome,
        repository: "o/r",
        pullRequestNumber: 4,
        pullRequestUrl: "https://github.com/o/r/pull/4",
      },
    },
  });
  const withChild = (c = child()) => ({ findMany: vi.fn(async () => [c]) });
  const writeLink = (extra: Record<string, unknown> = {}) => ({
    access: "write",
    commentVisibilityRole: null,
    onPullRequestOpened: null,
    ...extra,
  });

  it("records the pair, links it on the issue and moves the status", async () => {
    const t = tracker();
    (t.transitionTo as any).mockResolvedValue({ transitionId: "1", toStatus: "In Review" });
    const d = db(row, { id: "r1", agentId: "a1" }, withChild(), writeLink({ onPullRequestOpened: "In Review" }));
    await completeIssueStatus(d, finished, { jira: t });
    expect((d as any).issuePullRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          issueProvider: "jira",
          issueKey: "PROJ-1",
          codeProvider: "github",
          repository: "o/r",
          number: 4,
          url: "https://github.com/o/r/pull/4",
          agentId: "a1",
          openedByRunId: "child-1",
        }),
      }),
    );
    expect(t.addRemoteLink).toHaveBeenCalledWith("PROJ-1", {
      globalId: "wardby:pr:github:o/r#4",
      url: "https://github.com/o/r/pull/4",
      title: "o/r#4",
    });
    expect(t.transitionTo).toHaveBeenCalledWith("PROJ-1", "In Review");
  });

  it("does not transition on an updated pull request", async () => {
    const t = tracker();
    const d = db(
      row,
      { id: "r1", agentId: "a1" },
      withChild(child("pull_request_updated")),
      writeLink({ onPullRequestOpened: "In Review" }),
    );
    await completeIssueStatus(d, finished, { jira: t });
    expect(t.addRemoteLink).toHaveBeenCalled();
    expect(t.transitionTo).not.toHaveBeenCalled();
  });

  it("does nothing for a read link or an unlinked agent", async () => {
    for (const link of [writeLink({ access: "read" }), null]) {
      const t = tracker();
      const d = db(row, { id: "r1", agentId: "a1" }, withChild(), link);
      await completeIssueStatus(d, finished, { jira: t });
      expect((d as any).issuePullRequest.create).not.toHaveBeenCalled();
      expect(t.addRemoteLink).not.toHaveBeenCalled();
      expect(t.transitionTo).not.toHaveBeenCalled();
    }
  });

  it("notes a refused move in the comment, keeps the footer last, and still completes", async () => {
    const t = tracker();
    (t.transitionTo as any).mockRejectedValue(new Error("nope"));
    const d = db(row, { id: "r1", agentId: "a1" }, withChild(), writeLink({ onPullRequestOpened: "In Review" }));
    await completeIssueStatus(d, finished, { jira: t });
    const md = (t.editComment as any).mock.calls[0][2].markdown as string;
    expect(md).toContain('Could not move PROJ-1 to "In Review"');
    expect(md).not.toContain("nope");
    expect(md.trimEnd().split("\n").pop()).toMatch(/^_wardby run `r1`_$/);
    expect(isStatusComment(adfToText(markdownToAdf(md)))).toBe(true);
    expect((d as any).runIssueStatus.update).toHaveBeenCalled();
  });

  it("survives a failing store or remote link", async () => {
    const t = tracker();
    (t.addRemoteLink as any).mockRejectedValue(new Error("x"));
    const d = db(row, { id: "r1", agentId: "a1" }, withChild(), writeLink());
    (d as any).issuePullRequest.findUnique.mockRejectedValue(new Error("db"));
    await completeIssueStatus(d, finished, { jira: t });
    expect(t.editComment).toHaveBeenCalled();
    expect((d as any).runIssueStatus.update).toHaveBeenCalled();
  });

  it("does not bridge a PR whose coding run continued another issue's pull request", async () => {
    const t = tracker();
    const d = db(
      row,
      { id: "r1", agentId: "a1" },
      withChild(child("pull_request_updated")),
      writeLink({ onPullRequestOpened: "In Review" }),
    );
    (d as any).codingRun.findMany.mockResolvedValue([
      { runId: "child-1", rootCodingRun: { issueProvider: "jira", issueKey: "PROJ-9" } },
    ]);
    await completeIssueStatus(d, finished, { jira: t });
    expect((d as any).codingRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: { in: ["child-1"] } } }),
    );
    expect((d as any).issuePullRequest.create).not.toHaveBeenCalled();
    expect(t.addRemoteLink).not.toHaveBeenCalled();
    expect(t.transitionTo).not.toHaveBeenCalled();
    expect(t.editComment).toHaveBeenCalled();
    expect((d as any).runIssueStatus.update).toHaveBeenCalled();
  });

  it("bridges a continuation of this issue's own pull request, or of one with no issue", async () => {
    for (const root of [{ issueProvider: "jira", issueKey: "PROJ-1" }, { issueProvider: null, issueKey: null }, null]) {
      const t = tracker();
      const d = db(row, { id: "r1", agentId: "a1" }, withChild(child("pull_request_updated")), writeLink());
      (d as any).codingRun.findMany.mockResolvedValue([{ runId: "child-1", rootCodingRun: root }]);
      await completeIssueStatus(d, finished, { jira: t });
      expect((d as any).issuePullRequest.create).toHaveBeenCalled();
      expect(t.addRemoteLink).toHaveBeenCalled();
    }
  });
});

describe("formatSpendLine", () => {
  it("shows the tree total, the issue total and the models by cost", () => {
    expect(
      formatSpendLine({
        treeUsd: 1.84,
        issueUsd: 4.12,
        models: [
          { model: "claude-sonnet-4-6", costUsd: 1.52 },
          { model: "claude-haiku-4-5", costUsd: 0.32 },
        ],
      }),
    ).toBe(
      "Agent spend: $1.84 this run · $4.12 on this issue so far · claude-sonnet-4-6 $1.52, claude-haiku-4-5 $0.32",
    );
  });

  it("omits the issue total when unattributed and the models when unknown", () => {
    expect(formatSpendLine({ treeUsd: 0.01, issueUsd: null, models: [] })).toBe("Agent spend: $0.01 this run");
  });

  it("shows cents for $1 and up, and 2 significant digits below $1, never in exponent form", () => {
    const line = (usd: number) => formatSpendLine({ treeUsd: usd, issueUsd: null, models: [] });
    expect(line(0.0034567)).toBe("Agent spend: $0.0035 this run");
    expect(line(0.1234)).toBe("Agent spend: $0.12 this run");
    expect(line(12.343)).toBe("Agent spend: $12.34 this run");
    expect(line(1234.5)).toBe("Agent spend: $1234.50 this run");
    expect(line(1.84)).toBe("Agent spend: $1.84 this run");
    expect(line(0.5)).toBe("Agent spend: $0.50 this run");
    expect(line(0.00000012)).toBe("Agent spend: $0.00000012 this run");
    expect(line(0)).toBe("Agent spend: $0.00 this run");
    expect(line(0.0999)).toBe("Agent spend: $0.10 this run");
    expect(line(0.0012)).toBe("Agent spend: $0.0012 this run");
  });
});
