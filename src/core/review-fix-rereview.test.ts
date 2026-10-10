import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeReviewHost, PullRequestOrigin } from "../providers/review-host/types.js";
import type { RepoAccessGate } from "./repo-access.js";

vi.mock("./host-events.js", async (orig) => ({
  ...(await orig<typeof import("./host-events.js")>()),
  startReviews: vi.fn(async () => ["review-run-2"]),
}));
import { startReviews } from "./host-events.js";
import { reReviewAfterNoChangeFix, reviewFixTaskText, type ReReviewDeps } from "./review-fix.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "o/r";
const STARTED = new Date("2026-10-10T10:00:00Z");

interface Opts {
  outcome?: string;
  status?: string;
  /** The fix agent delegated: the coding run is a child of the native fix run. */
  delegated?: boolean;
  rootTask?: string | null;
  rootAgentId?: string;
  hostStatus?: object | null;
  origin?: Partial<PullRequestOrigin>;
  fixLink?: object | null;
  reviewerLink?: object | null;
  reviewerAuthorized?: boolean;
  check?: object | null;
  claimCount?: number;
  recordFails?: boolean;
}

function fixTask(): string {
  return reviewFixTaskText({
    repository: REPO,
    prNumber: 7,
    headSha: SHA,
    round: 1,
    maxRounds: 2,
    priorRunId: "run_1",
    reviewBody: "needs work",
  });
}

function setup(opts: Opts = {}) {
  vi.mocked(startReviews).mockClear();
  const hostStatus =
    opts.hostStatus === null ? null : { provider: "github", repository: REPO, number: 7, ...(opts.hostStatus ?? {}) };
  const root = {
    id: "fix-root",
    agentId: opts.rootAgentId ?? "delivery",
    parentRunId: null,
    startedAt: STARTED,
    taskOverride: opts.rootTask === undefined ? fixTask() : opts.rootTask,
    hostStatus,
  };
  const coding = {
    id: "coding-1",
    agentId: opts.delegated === false ? root.agentId : "coder",
    parentRunId: opts.delegated === false ? null : "fix-root",
    status: opts.status ?? "succeeded",
    startedAt: STARTED,
    taskOverride: opts.delegated === false ? root.taskOverride : "delegated task",
    hostStatus: opts.delegated === false ? hostStatus : null,
    codingRun: {
      repository: REPO,
      result: { outcome: opts.outcome ?? "no_changes", summary: "The finding is wrong: CI is green on #8." },
    },
  };
  const runs: Record<string, object> = { "coding-1": coding };
  if (opts.delegated !== false) runs["fix-root"] = root;
  const addLabel = vi.fn(async (_repo: string, _n: number, label: string) => {
    if (opts.recordFails && label.startsWith("wardby-autofix-") && label !== "wardby-autofix-limit")
      throw new Error("label failed");
  });
  const host = {
    provider: "github",
    pullRequestOrigin: vi.fn(async () => ({
      headSha: SHA,
      isFork: false,
      state: "open",
      labels: ["wardby-autofix-1"],
      markerRunId: "run_1",
      ...opts.origin,
    })),
    addLabel,
    comment: vi.fn(async () => ({ url: "u", id: "1" })),
  } as unknown as CodeReviewHost;
  const fixLink =
    opts.fixLink === null
      ? null
      : {
          agentId: "delivery",
          access: "write",
          triggers: ["mention", "review_fix"],
          authorizedVia: "host_permission",
          reviewFixMaxRounds: null,
          checkName: null,
          agent: { ownerId: "p1" },
          ...opts.fixLink,
        };
  const reviewerLink =
    opts.reviewerLink === null
      ? null
      : {
          agentId: "reviewer",
          access: "write",
          triggers: ["pull_request"],
          authorizedVia: "host_permission",
          reviewFixMaxRounds: null,
          checkName: "wardby review",
          agent: { ownerId: "p1" },
          ...opts.reviewerLink,
        };
  const check =
    opts.check === null
      ? null
      : {
          runId: "review-run-1",
          provider: "github",
          repository: REPO,
          prNumber: 7,
          headSha: SHA,
          verdict: "CHANGES_REQUESTED",
          run: { agentId: "reviewer" },
          ...opts.check,
        };
  const claim = vi.fn(async () => ({ count: opts.claimCount ?? 1 }));
  const findCheck = vi.fn(async () => check);
  const repoAccess = {
    authorizeUse: vi.fn(async (req: { required: unknown }) => {
      void req;
      return opts.reviewerAuthorized === false ? { ok: false, reason: "not_authorized" } : { ok: true };
    }),
  } as unknown as RepoAccessGate;
  const deps = {
    db: {
      run: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => runs[where.id] ?? null) },
      agentRepository: {
        findFirst: vi.fn(async ({ where }: { where: { agentId?: string; triggers?: unknown } }) =>
          where.triggers ? fixLink : where.agentId === "reviewer" ? reviewerLink : null,
        ),
      },
      runHostCheck: { findFirst: findCheck, updateMany: claim },
    } as never,
    executor: {} as never,
    hosts: { github: host },
    repoAccess,
  } as ReReviewDeps;
  return { deps, host, addLabel, claim, findCheck };
}

describe("reReviewAfterNoChangeFix", () => {
  beforeEach(() => vi.mocked(startReviews).mockClear());

  it("starts one review of the current head for the reviewer that requested changes, with the fix summary", async () => {
    const { deps, host, addLabel, claim } = setup();
    await reReviewAfterNoChangeFix("coding-1", deps);
    expect(startReviews).toHaveBeenCalledTimes(1);
    const [, usedHost, repository, prNumber, headSha, targets, skipReviewed, context] =
      vi.mocked(startReviews).mock.calls[0];
    expect(usedHost).toBe(host);
    expect([repository, prNumber, headSha]).toEqual([REPO, 7, SHA]);
    expect(targets).toEqual([{ agentId: "reviewer", checkName: "wardby review" }]);
    // The head was already reviewed (the fix changed nothing): the re-review must not be skipped as a repeat.
    expect(skipReviewed).toBe(false);
    expect(context?.untrustedContext).toBe(
      "A review-fix round concluded that no code change is needed: The finding is wrong: CI is green on #8.. " +
        "Re-check your earlier finding against the current code and related pull requests.",
    );
    // The model-written summary never reaches the trusted task part.
    expect(context?.task).not.toContain("CI is green");
    expect(context?.task).toContain(
      "Re-check your earlier finding against the current code and related pull requests.",
    );
    // Claimed on the requesting review's check, then the round recorded, both before the dispatch.
    expect(claim).toHaveBeenCalledWith({
      where: { runId: "review-run-1", ciRereviewAt: null },
      data: { ciRereviewAt: expect.any(Date) },
    });
    expect(addLabel).toHaveBeenCalledWith(REPO, 7, "wardby-autofix-2");
    expect(addLabel.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(startReviews).mock.invocationCallOrder[0]);
    expect(claim.mock.invocationCallOrder[0]).toBeLessThan(addLabel.mock.invocationCallOrder[0]);
  });

  it("works when the review_fix agent is itself the coding run (no delegation)", async () => {
    const { deps } = setup({ delegated: false });
    await reReviewAfterNoChangeFix("coding-1", deps);
    expect(startReviews).toHaveBeenCalledTimes(1);
  });

  it("looks up the review that requested changes before the fix round started", async () => {
    const { deps, findCheck } = setup();
    await reReviewAfterNoChangeFix("coding-1", deps);
    expect(findCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "github",
          repository: REPO,
          prNumber: 7,
          verdict: "CHANGES_REQUESTED",
          completedAt: { lte: STARTED },
        }),
        orderBy: { completedAt: "desc" },
      }),
    );
  });

  it("bounds the summary and keeps it out of the trusted task", async () => {
    const { deps } = setup();
    const long = "x".repeat(10_000);
    vi.mocked(deps.db.run.findUnique).mockImplementationOnce((async () => ({
      id: "coding-1",
      agentId: "delivery",
      parentRunId: null,
      status: "succeeded",
      startedAt: STARTED,
      taskOverride: fixTask(),
      hostStatus: { provider: "github", repository: REPO, number: 7 },
      codingRun: { repository: REPO, result: { outcome: "no_changes", summary: long } },
    })) as never);
    await reReviewAfterNoChangeFix("coding-1", deps);
    const context = vi.mocked(startReviews).mock.calls[0][7];
    expect(context!.untrustedContext.length).toBeLessThan(4200);
  });

  it("at the cap: posts the cap comment, labels the PR stopped, and does not re-review", async () => {
    const { deps, host, addLabel } = setup({ origin: { labels: ["wardby-autofix-1", "wardby-autofix-2"] } });
    await reReviewAfterNoChangeFix("coding-1", deps);
    expect(startReviews).not.toHaveBeenCalled();
    expect(addLabel).toHaveBeenCalledWith(REPO, 7, "wardby-autofix-limit");
    expect(host.comment).toHaveBeenCalledWith(REPO, { number: 7, body: expect.stringContaining("after 2 automatic") });
  });

  it("uses the review_fix link's own cap", async () => {
    const { deps } = setup({
      fixLink: { reviewFixMaxRounds: 3 },
      origin: { labels: ["wardby-autofix-1", "wardby-autofix-2"] },
    });
    await reReviewAfterNoChangeFix("coding-1", deps);
    expect(startReviews).toHaveBeenCalledTimes(1);
  });

  it("does not re-review when recording the round fails (fails closed)", async () => {
    const { deps } = setup({ recordFails: true });
    await reReviewAfterNoChangeFix("coding-1", deps);
    expect(startReviews).not.toHaveBeenCalled();
  });

  it("starts nothing when the claim was already taken (a replay or a duplicate terminal write)", async () => {
    const { deps, addLabel } = setup({ claimCount: 0 });
    await reReviewAfterNoChangeFix("coding-1", deps);
    expect(startReviews).not.toHaveBeenCalled();
    expect(addLabel).not.toHaveBeenCalled();
  });

  it.each([
    ["changes_ready (the push starts a review)", { outcome: "pull_request_updated" }],
    ["budget exhausted", { outcome: "budget_exhausted", status: "budget_exhausted" }],
    ["a failed run", { status: "failed" }],
    ["a run not started as a fix round", { rootTask: "Review pull request #7 in o/r." }],
    [
      "a mention run on the PR",
      { rootTask: "[GitHub PR #7]\nRepository: o/r\nRequested by @alice\n\nRequest comment:\nhi" },
    ],
    ["a fix task for a different PR", { hostStatus: { number: 8 } }],
    ["a root run that is not the review_fix agent's", { rootAgentId: "someone-else" }],
    ["no review_fix link any more", { fixLink: null }],
    ["no status row on the root", { hostStatus: null }],
    ["a closed PR", { origin: { state: "closed" } }],
    ["a moved head", { origin: { headSha: "f".repeat(40) } }],
    ["a fork", { origin: { isFork: true } }],
    ["an opted-out PR", { origin: { labels: ["wardby-autofix-off"] } }],
    ["no review requested changes", { check: null }],
    ["the reviewer link is gone", { reviewerLink: null }],
    ["the reviewer link no longer reviews", { reviewerLink: { triggers: ["mention"] } }],
    ["the reviewer link is unauthorized", { reviewerAuthorized: false }],
  ] as const)("does nothing for %s", async (_name, opts) => {
    const { deps, addLabel, host } = setup(opts as Opts);
    await reReviewAfterNoChangeFix("coding-1", deps);
    expect(startReviews).not.toHaveBeenCalled();
    expect(addLabel).not.toHaveBeenCalled();
    expect(host.comment).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    const { deps } = setup();
    vi.mocked(deps.db.run.findUnique).mockRejectedValueOnce(new Error("db down"));
    await expect(reReviewAfterNoChangeFix("coding-1", deps)).resolves.toBeUndefined();
  });
});
