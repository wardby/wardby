import { describe, expect, it, vi } from "vitest";

vi.mock("./issue-bridge.js", () => ({ handlePullRequestClosed: vi.fn(async () => undefined) }));
import { handlePullRequestClosed } from "./issue-bridge.js";
import {
  PR_STATE_SYNC_BATCH,
  PR_STATE_SYNC_MIN_AGE_MS,
  syncOpenPullRequestStates,
  type PullRequestStateSyncDb,
} from "./pull-request-state-sync.js";

const NOW = new Date("2026-10-05T12:00:00Z");
const rows = [
  { id: "r1", codeProvider: "github", repository: "acme/bff", number: 3 },
  { id: "r2", codeProvider: "github", repository: "acme/app", number: 4 },
  { id: "r3", codeProvider: "github", repository: "acme/web", number: 5 },
];

function setup(origins: Record<string, { state: string; merged?: boolean } | Error>) {
  const db = {
    issuePullRequest: {
      findMany: vi.fn(async () => rows),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentIssueProject: {},
  } as unknown as PullRequestStateSyncDb & {
    issuePullRequest: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  };
  const host = {
    pullRequestOrigin: vi.fn(async (repository: string, n: number) => {
      const o = origins[`${repository}#${n}`];
      if (o instanceof Error) throw o;
      return { headSha: "a".repeat(40), isFork: false, labels: [], ...o };
    }),
  };
  return { db, host, hosts: { github: host } as never, trackers: { jira: {} } as never };
}

describe("syncOpenPullRequestStates", () => {
  it("reads the least recently checked open rows, settles merged/closed ones via the pr_closed path, touches the rest", async () => {
    vi.mocked(handlePullRequestClosed).mockClear();
    const { db, hosts, trackers } = setup({
      "acme/bff#3": { state: "closed", merged: true },
      "acme/app#4": { state: "open" },
      "acme/web#5": { state: "closed", merged: false },
    });
    expect(await syncOpenPullRequestStates(db, hosts, trackers, NOW)).toBe(2);
    expect(db.issuePullRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { state: "open", updatedAt: { lt: new Date(NOW.getTime() - PR_STATE_SYNC_MIN_AGE_MS) } },
        orderBy: { updatedAt: "asc" },
        take: PR_STATE_SYNC_BATCH,
      }),
    );
    expect(vi.mocked(handlePullRequestClosed).mock.calls.map((c) => c[2])).toEqual([
      { codeProvider: "github", repository: "acme/bff", number: 3, merged: true },
      { codeProvider: "github", repository: "acme/web", number: 5, merged: false },
    ]);
    expect(db.issuePullRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "r2", state: "open" },
      data: { updatedAt: NOW },
    });
  });

  it("touches a row the host can't answer for and keeps going, never throwing", async () => {
    vi.mocked(handlePullRequestClosed).mockClear();
    const { db, hosts, trackers } = setup({
      "acme/bff#3": new Error("github_api_error:404"),
      "acme/app#4": { state: "closed", merged: true },
      "acme/web#5": { state: "open" },
    });
    vi.mocked(handlePullRequestClosed).mockRejectedValueOnce(new Error("db blip"));
    await expect(syncOpenPullRequestStates(db, hosts, trackers, NOW)).resolves.toBe(0);
    expect(db.issuePullRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", state: "open" },
      data: { updatedAt: NOW },
    });
    db.issuePullRequest.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(syncOpenPullRequestStates(db, hosts, trackers, NOW)).resolves.toBe(0);
  });

  it("does nothing without hosts", async () => {
    const { db, trackers } = setup({});
    await syncOpenPullRequestStates(db, undefined, trackers, NOW);
    expect(db.issuePullRequest.findMany).not.toHaveBeenCalled();
  });

  it("still settles rows without trackers (a GitHub issue's pairs need none)", async () => {
    vi.mocked(handlePullRequestClosed).mockClear();
    const { db, hosts } = setup({
      "acme/bff#3": { state: "closed", merged: true },
      "acme/app#4": { state: "open" },
      "acme/web#5": { state: "open" },
    });
    expect(await syncOpenPullRequestStates(db, hosts, undefined, NOW)).toBe(1);
    expect(vi.mocked(handlePullRequestClosed).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [undefined, { codeProvider: "github", repository: "acme/bff", number: 3, merged: true }],
    ]);
  });
});
