import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWorkflowEventSink, type WorkflowEventInput } from "./workflow-events.js";
import { Prisma } from "#prisma";
import { projectOf, type IssueTracker } from "../providers/issue-tracker/types.js";
import {
  githubIssueKey,
  handlePullRequestClosed,
  recordIssuePullRequests,
  recordPullRequests,
  type BridgedPullRequest,
} from "./issue-bridge.js";

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
    transitionTo: vi.fn(async (_k: string, to: string) => ({ transitionId: "31", toStatus: to })),
    editableFields: vi.fn(),
    editFields: vi.fn(),
    linkTypes: vi.fn(),
    linkIssues: vi.fn(),
    addRemoteLink: vi.fn(async () => undefined),
    getProperty: vi.fn(),
    setProperty: vi.fn(),
    getIssue: vi.fn(),
    issueProject: vi.fn(),
    snapshotIssue: vi.fn(async (key: string) => ({
      key,
      url: `https://example.test/browse/${key}`,
      scopeKey: key.slice(0, key.lastIndexOf("-")),
    })),
    search: vi.fn(),
    matchesJql: vi.fn(),
    comment: vi.fn(async () => ({ id: "c-1", url: "u" })),
    editComment: vi.fn(),
    readComment: vi.fn(),
    issueUrl: (k) => `https://your-site.atlassian.net/browse/${k}`,
  };
}

const REPO = "your-org/your-repo";
const ROW = {
  id: "ipr-1",
  issueProvider: "jira",
  issueKey: "PROJ-7",
  codeProvider: "github",
  repository: REPO,
  number: 12,
  url: `https://github.com/${REPO}/pull/12`,
  agentId: "a1",
  openedByRunId: "r-code",
  state: "open",
};
const LINK = { access: "write", commentVisibilityRole: null, onPullRequestMerged: "Done" };

function db(rows: Array<Record<string, unknown>> = [ROW], link: Record<string, unknown> | null = LINK, claimed = 1) {
  return {
    issuePullRequest: {
      findMany: vi.fn(async () => rows),
      updateMany: vi.fn(async () => ({ count: claimed })),
    },
    agentIssueProject: { findUnique: vi.fn(async () => link) },
  };
}

const closed = (merged: boolean) => ({ codeProvider: "github", repository: REPO, number: 12, merged });

describe("handlePullRequestClosed", () => {
  it("merged: marks the row, resolves the web link, moves the issue and comments", async () => {
    const t = tracker();
    const d = db();
    await handlePullRequestClosed(d as never, { jira: t }, closed(true));
    expect(d.issuePullRequest.findMany).toHaveBeenCalledWith({
      where: { codeProvider: "github", repository: REPO, number: 12, state: "open" },
    });
    expect(d.issuePullRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "ipr-1", state: "open" },
      data: { state: "merged" },
    });
    expect(d.agentIssueProject.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId_provider_projectKey: { agentId: "a1", provider: "jira", projectKey: "PROJ" } },
      }),
    );
    expect(t.addRemoteLink).toHaveBeenCalledWith("PROJ-7", {
      globalId: `wardby:pr:github:${REPO}#12`,
      url: ROW.url,
      title: `${REPO}#12`,
      status: { resolved: true },
    });
    expect(t.transitionTo).toHaveBeenCalledWith("PROJ-7", "Done");
    expect(t.comment).toHaveBeenCalledWith("PROJ-7", {
      markdown: `✅ Pull request [${REPO}#12](${ROW.url}) was merged. Moved to Done.`,
    });
  });

  it("merged without a configured status: comments only, no move", async () => {
    const t = tracker();
    await handlePullRequestClosed(
      db([ROW], { ...LINK, onPullRequestMerged: null }) as never,
      { jira: t },
      closed(true),
    );
    expect(t.transitionTo).not.toHaveBeenCalled();
    expect(t.comment).toHaveBeenCalledWith("PROJ-7", {
      markdown: `✅ Pull request [${REPO}#12](${ROW.url}) was merged.`,
    });
  });

  it("closed unmerged: comments only, in the link's visibility role", async () => {
    const t = tracker();
    const d = db([ROW], { ...LINK, commentVisibilityRole: "Developers" });
    await handlePullRequestClosed(d as never, { jira: t }, closed(false));
    expect(d.issuePullRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { state: "closed" } }));
    expect(t.transitionTo).not.toHaveBeenCalled();
    expect(t.addRemoteLink).not.toHaveBeenCalled();
    expect(t.comment).toHaveBeenCalledWith("PROJ-7", {
      markdown: `Pull request [${REPO}#12](${ROW.url}) was closed without merging.`,
      visibilityRole: "Developers",
    });
  });

  it("an unknown PR (no open row) is a no-op", async () => {
    const t = tracker();
    const d = db([]);
    await handlePullRequestClosed(d as never, { jira: t }, closed(true));
    expect(d.issuePullRequest.updateMany).not.toHaveBeenCalled();
    expect(t.comment).not.toHaveBeenCalled();
  });

  it("a concurrent duplicate that loses the claim does nothing", async () => {
    const t = tracker();
    const d = db([ROW], LINK, 0);
    await handlePullRequestClosed(d as never, { jira: t }, closed(true));
    expect(d.agentIssueProject.findUnique).not.toHaveBeenCalled();
    expect(t.comment).not.toHaveBeenCalled();
    expect(t.transitionTo).not.toHaveBeenCalled();
  });

  it("an unlinked or read-only agent: the row is still marked, but Jira is never called", async () => {
    for (const link of [null, { ...LINK, access: "read" }]) {
      const t = tracker();
      const d = db([ROW], link);
      await handlePullRequestClosed(d as never, { jira: t }, closed(true));
      expect(d.issuePullRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { state: "merged" } }),
      );
      expect(t.comment).not.toHaveBeenCalled();
      expect(t.transitionTo).not.toHaveBeenCalled();
      expect(t.addRemoteLink).not.toHaveBeenCalled();
    }
  });

  it("a refused move is noted in the comment; nothing throws", async () => {
    const t = tracker();
    vi.mocked(t.transitionTo).mockRejectedValue(new Error("no such transition"));
    vi.mocked(t.addRemoteLink).mockRejectedValue(new Error("boom"));
    await expect(handlePullRequestClosed(db() as never, { jira: t }, closed(true))).resolves.toBeUndefined();
    expect(t.comment).toHaveBeenCalledWith("PROJ-7", {
      markdown: `✅ Pull request [${REPO}#12](${ROW.url}) was merged. Could not move PROJ-7 to "Done"; it may need a manual move.`,
    });
  });

  it("handles every issue the PR is linked to, and survives a failing one", async () => {
    const t = tracker();
    vi.mocked(t.comment).mockRejectedValueOnce(new Error("jira down"));
    const d = db([ROW, { ...ROW, id: "ipr-2", issueKey: "PROJ-8" }]);
    await expect(handlePullRequestClosed(d as never, { jira: t }, closed(false))).resolves.toBeUndefined();
    expect(t.comment).toHaveBeenCalledTimes(2);
    expect(vi.mocked(t.comment).mock.calls[1][0]).toBe("PROJ-8");
  });

  it("no trackers: still marks the row, and calls no tracker", async () => {
    const d = db();
    await handlePullRequestClosed(d as never, undefined, closed(true));
    expect(d.issuePullRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "ipr-1", state: "open" },
      data: { state: "merged" },
    });
    expect(d.agentIssueProject.findUnique).not.toHaveBeenCalled();
  });

  it("a GitHub issue's pair is marked on merge and on close, with or without trackers", async () => {
    const githubRow = { ...ROW, issueProvider: "github", issueKey: `${REPO}#5` };
    for (const [trackers, merged] of [
      [undefined, true],
      [{ jira: tracker() }, false],
    ] as const) {
      const d = db([githubRow]);
      await handlePullRequestClosed(d as never, trackers, closed(merged));
      expect(d.issuePullRequest.updateMany).toHaveBeenCalledWith({
        where: { id: "ipr-1", state: "open" },
        data: { state: merged ? "merged" : "closed" },
      });
      expect(d.agentIssueProject.findUnique).not.toHaveBeenCalled();
    }
  });

  it("a failing lookup (before any row is claimed) throws, so the delivery is rolled back and redelivered", async () => {
    const t = tracker();
    const d = db();
    d.issuePullRequest.findMany.mockRejectedValue(new Error("db"));
    await expect(handlePullRequestClosed(d as never, { jira: t }, closed(true))).rejects.toThrow("db");
    expect(d.issuePullRequest.updateMany).not.toHaveBeenCalled();
    expect(t.comment).not.toHaveBeenCalled();
  });

  it("a failure after the row is claimed never throws", async () => {
    const t = tracker();
    const d = db();
    d.agentIssueProject.findUnique.mockRejectedValue(new Error("db"));
    await expect(handlePullRequestClosed(d as never, { jira: t }, closed(true))).resolves.toBeUndefined();
  });

  it("an issue provider with no configured tracker still marks the row", async () => {
    const d = db([{ ...ROW, issueProvider: "linear" }]);
    await handlePullRequestClosed(d as never, { jira: tracker() }, closed(false));
    expect(d.issuePullRequest.updateMany).toHaveBeenCalled();
    expect(d.agentIssueProject.findUnique).not.toHaveBeenCalled();
  });
});

type StoredPair = Record<string, unknown> & { state: string; url: string };

/** A stateful stand-in for the IssuePullRequest table, keyed like its unique constraint. */
function pairStore(initial: StoredPair[] = []) {
  const rows = [...initial];
  const keyOf = (r: Record<string, unknown>) =>
    JSON.stringify([r.codeProvider, r.repository, r.number, r.issueProvider, r.issueKey]);
  const find = (where: Record<string, Record<string, unknown>>) => {
    const k = keyOf(where.codeProvider_repository_number_issueProvider_issueKey);
    return rows.find((r) => keyOf(r) === k) ?? null;
  };
  return {
    rows,
    issuePullRequest: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, Record<string, unknown>> }) => find(where)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (rows.some((r) => keyOf(r) === keyOf(data))) {
          throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
        }
        const row: StoredPair = { id: `ipr-${rows.length + 1}`, state: "open", url: "", ...data };
        rows.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: Record<string, Record<string, unknown>>; data: Record<string, unknown> }) => {
          const row = find(where);
          if (!row) throw new Error("not found");
          Object.assign(row, data);
          return row;
        },
      ),
    },
  };
}

const opened = (n: number, outcome: BridgedPullRequest["outcome"] = "pull_request_opened"): BridgedPullRequest => ({
  codeProvider: "github",
  repository: REPO,
  number: n,
  url: `https://github.com/${REPO}/pull/${n}`,
  openedByRunId: `r-code-${n}`,
  outcome,
});

const recordInput = (pullRequests: BridgedPullRequest[]) => ({
  issueKey: "PROJ-7",
  issueProvider: "jira",
  agentId: "a1",
  onPullRequestOpened: "In Review",
  pullRequests,
});

describe("recordPullRequests", () => {
  it("records, links and moves once; a repeat call (a retried completion) moves nothing", async () => {
    const t = tracker();
    const store = pairStore();
    await recordPullRequests(store as never, t, recordInput([opened(12)]));
    expect(store.rows).toHaveLength(1);
    expect(t.addRemoteLink).toHaveBeenCalledTimes(1);
    expect(t.transitionTo).toHaveBeenCalledTimes(1);

    await recordPullRequests(store as never, t, recordInput([opened(12)]));
    expect(store.rows).toHaveLength(1);
    expect(t.transitionTo).toHaveBeenCalledTimes(1);
  });

  it("never re-links a pair that has since merged (which would un-resolve its web link)", async () => {
    const t = tracker();
    const store = pairStore();
    await recordPullRequests(store as never, t, recordInput([opened(12)]));
    store.rows[0].state = "merged";
    vi.mocked(t.addRemoteLink).mockClear();
    await recordPullRequests(store as never, t, recordInput([opened(12)]));
    expect(t.addRemoteLink).not.toHaveBeenCalled();
    expect(t.transitionTo).toHaveBeenCalledTimes(1);
  });

  it("refreshes the url and link of a still-open existing pair without moving the issue", async () => {
    const t = tracker();
    const store = pairStore([{ ...ROW, url: "https://github.com/old" }]);
    await recordPullRequests(store as never, t, recordInput([opened(12)]));
    expect(store.rows[0].url).toBe(`https://github.com/${REPO}/pull/12`);
    expect(t.addRemoteLink).toHaveBeenCalledTimes(1);
    expect(t.transitionTo).not.toHaveBeenCalled();
  });

  it("moves the issue exactly once for several newly opened pull requests", async () => {
    const t = tracker();
    const store = pairStore();
    await recordPullRequests(store as never, t, recordInput([opened(12), opened(13), opened(14)]));
    expect(store.rows).toHaveLength(3);
    expect(t.addRemoteLink).toHaveBeenCalledTimes(3);
    expect(t.transitionTo).toHaveBeenCalledTimes(1);
  });

  it("does not move the issue for a newly recorded pull_request_updated pair", async () => {
    const t = tracker();
    const store = pairStore();
    await recordPullRequests(store as never, t, recordInput([opened(12, "pull_request_updated")]));
    expect(store.rows).toHaveLength(1);
    expect(t.transitionTo).not.toHaveBeenCalled();
  });

  it("a lost create race (P2002) counts as existing: no move", async () => {
    const t = tracker();
    const store = pairStore();
    store.issuePullRequest.findUnique.mockResolvedValueOnce(null);
    store.rows.push({ ...ROW, id: "ipr-race", state: "open" });
    await recordPullRequests(store as never, t, recordInput([opened(12)]));
    expect(store.rows).toHaveLength(1);
    expect(t.transitionTo).not.toHaveBeenCalled();
  });

  it("a failing store never throws and does not move the issue", async () => {
    const t = tracker();
    const store = pairStore();
    store.issuePullRequest.findUnique.mockRejectedValue(new Error("db"));
    await expect(recordPullRequests(store as never, t, recordInput([opened(12)]))).resolves.toEqual({ notes: [] });
    expect(t.transitionTo).not.toHaveBeenCalled();
  });
});

describe("githubIssueKey", () => {
  it("is <owner>/<repo>#<number>, the repository normalised", () => {
    expect(githubIssueKey("Your-Org/Your-Repo", 5)).toBe("your-org/your-repo#5");
    expect(githubIssueKey(`https://github.com/${REPO}`, 12)).toBe(`${REPO}#12`);
  });

  it("its project is the repository (a Jira key's stays its project key)", () => {
    expect(projectOf(githubIssueKey("my-org/my-repo", 5))).toBe("my-org/my-repo");
    expect(projectOf("PROJ-7")).toBe("PROJ");
    expect(projectOf("MY_PROJ-12")).toBe("MY_PROJ");
  });
});

describe("recordIssuePullRequests", () => {
  const pr = (n: number) => ({
    codeProvider: "github",
    repository: REPO,
    number: n,
    url: `https://github.com/${REPO}/pull/${n}`,
    agentId: "a1",
    openedByRunId: `r-code-${n}`,
  });
  const issue = { provider: "github", key: `${REPO}#5` };

  it("records one open row per pair, and a repeat adds none", async () => {
    const store = pairStore();
    await recordIssuePullRequests(store as never, issue, [pr(12), pr(13)]);
    await recordIssuePullRequests(store as never, issue, [pr(12)]);
    expect(store.rows).toEqual([
      expect.objectContaining({ issueProvider: "github", issueKey: `${REPO}#5`, number: 12, state: "open" }),
      expect.objectContaining({ issueProvider: "github", issueKey: `${REPO}#5`, number: 13, state: "open" }),
    ]);
    expect(store.rows[0]).toMatchObject({ codeProvider: "github", repository: REPO, agentId: "a1" });
    expect(store.rows[0].openedByRunId).toBe("r-code-12");
  });

  it("never reopens a settled pair; never throws", async () => {
    const store = pairStore([{ ...ROW, issueProvider: "github", issueKey: `${REPO}#5`, state: "merged" }]);
    await recordIssuePullRequests(store as never, issue, [pr(12)]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].state).toBe("merged");
    store.issuePullRequest.findUnique.mockRejectedValue(new Error("db"));
    await expect(recordIssuePullRequests(store as never, issue, [pr(14)])).resolves.toBeUndefined();
  });
});

describe("workflow events", () => {
  const events: WorkflowEventInput[] = [];
  beforeEach(() => {
    events.length = 0;
    setWorkflowEventSink(async (e) => {
      events.push(e);
    });
  });
  afterEach(() => setWorkflowEventSink(null));

  const prClosed = (merged: boolean, movedTo: string | null) => ({
    dedupeKey: `pr_closed:github:${REPO}#12`,
    agentId: "a1",
    workItem: { provider: "jira", key: "PROJ-7" },
    pullRequest: { codeProvider: "github", repository: REPO, number: 12 },
    payload: { kind: "pr_closed", prLabel: `${REPO}#12`, prUrl: ROW.url, merged, movedTo },
  });

  it("pr_closed: a merge with onPullRequestMerged emits movedTo; a second delivery emits nothing", async () => {
    await handlePullRequestClosed(db() as never, { jira: tracker() }, closed(true));
    expect(events).toEqual([prClosed(true, "Done")]);
    await handlePullRequestClosed(db([]) as never, { jira: tracker() }, closed(true));
    await handlePullRequestClosed(db([ROW], LINK, 0) as never, { jira: tracker() }, closed(true));
    expect(events).toHaveLength(1);
  });

  it("pr_closed: emits once with movedTo null when the link is not write, or the tracker is not configured", async () => {
    await handlePullRequestClosed(db([ROW], { ...LINK, access: "read" }) as never, { jira: tracker() }, closed(true));
    await handlePullRequestClosed(db() as never, {}, closed(false));
    expect(events).toEqual([prClosed(true, null), prClosed(false, null)]);
  });

  it("pr_closed: still emits exactly once, with movedTo, when the comment throws after a merged claim", async () => {
    const t = tracker();
    vi.mocked(t.comment).mockRejectedValue(new Error("jira down"));
    await handlePullRequestClosed(db() as never, { jira: t }, closed(true));
    expect(events).toEqual([prClosed(true, "Done")]);
  });

  it("pr_closed: still emits once when the link lookup throws after the claim", async () => {
    const d = db();
    d.agentIssueProject.findUnique.mockRejectedValue(new Error("db down"));
    await handlePullRequestClosed(d as never, { jira: tracker() }, closed(false));
    expect(events).toEqual([prClosed(false, null)]);
  });

  it("pr_closed: a failed move still emits, with movedTo null", async () => {
    const t = tracker();
    vi.mocked(t.transitionTo).mockRejectedValue(new Error("no such transition"));
    await handlePullRequestClosed(db() as never, { jira: t }, closed(true));
    expect(events).toEqual([prClosed(true, null)]);
  });

  it("pr_opened: one event per newly recorded opened PR, with the move; a retry emits nothing", async () => {
    const t = tracker();
    const store = pairStore();
    await recordPullRequests(store as never, t, recordInput([opened(12), opened(13, "pull_request_updated")]));
    expect(events).toEqual([
      {
        dedupeKey: `pr_opened:github:${REPO}#12`,
        runId: "r-code-12",
        agentId: "a1",
        workItem: { provider: "jira", key: "PROJ-7" },
        pullRequest: { codeProvider: "github", repository: REPO, number: 12 },
        payload: {
          kind: "pr_opened",
          prLabel: `${REPO}#12`,
          prUrl: `https://github.com/${REPO}/pull/12`,
          movedTo: "In Review",
        },
      },
    ]);
    await recordPullRequests(store as never, t, recordInput([opened(12)]));
    expect(events).toHaveLength(1);
  });

  it("pr_opened: movedTo is null when the move fails or none is configured", async () => {
    const t = tracker();
    vi.mocked(t.transitionTo).mockRejectedValue(new Error("no such transition"));
    await recordPullRequests(pairStore() as never, t, recordInput([opened(12)]));
    await recordPullRequests(pairStore() as never, tracker(), {
      ...recordInput([opened(14)]),
      onPullRequestOpened: null,
    });
    expect(events.map((e) => (e.payload as { movedTo: string | null }).movedTo)).toEqual([null, null]);
  });
});
