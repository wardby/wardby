import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWorkflowEventSink, type WorkflowEventInput } from "./workflow-events.js";
import type { CodeReviewHost, PullRequestOrigin } from "../providers/review-host/types.js";
import type { RepoAccessGate } from "./repo-access.js";

const { txStub } = vi.hoisted(() => ({ txStub: { runHostStatus: { create: vi.fn(async () => undefined) } } }));
vi.mock("./dispatch.js", () => ({
  dispatchRun: vi.fn(async (opts: { agentId: string; afterPersist?: (tx: unknown, run: unknown) => Promise<void> }) => {
    const run = { id: `run-${opts.agentId}` };
    await opts.afterPersist?.(txStub, run);
    return { run };
  }),
  checkContinuation: vi.fn(async () => ({
    ok: true,
    root: { runId: "run_1", baseRef: "main", headRef: "wardby/run-run_1", pullRequestNumber: 7 },
  })),
}));
vi.mock("./host-status.js", async (orig) => ({
  ...(await orig<typeof import("./host-status.js")>()),
  postMentionStatus: vi.fn(async () => undefined),
}));
vi.mock("./attribution.js", async (orig) => ({
  ...(await orig<typeof import("./attribution.js")>()),
  linkedPullRequestAttribution: vi.fn(async () => undefined),
}));
import { linkedPullRequestAttribution, RESPONSE_PATH_SNAPSHOT_BUDGET } from "./attribution.js";
import { checkContinuation, dispatchRun } from "./dispatch.js";
import { postMentionStatus, TERMINAL_RUN_STATUSES } from "./host-status.js";
import { splitTaskOverride } from "./untrusted-content.js";
import {
  capBody,
  reviewFixTaskText,
  startReviewFixAfterReview,
  startReviewFixRound,
  type ReviewFixDeps,
} from "./review-fix.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "o/r";
const REQ = { provider: "github" as const, repository: REPO, prNumber: 7, headSha: SHA, reviewBody: "needs work" };

function setup(
  opts: {
    origin?: Partial<PullRequestOrigin>;
    link?: object | null;
    authorized?: boolean;
    check?: object | null;
    inFlightRun?: object | null;
  } = {},
) {
  vi.mocked(dispatchRun).mockClear();
  const addLabel = vi.fn(async () => undefined);
  const host = {
    provider: "github",
    pullRequestOrigin: vi.fn(async () => ({
      headSha: SHA,
      isFork: false,
      state: "open",
      labels: [],
      markerRunId: "run_1",
      ...opts.origin,
    })),
    addLabel,
    comment: vi.fn(async () => ({ url: "u", id: "1" })),
  } as unknown as CodeReviewHost;
  const link =
    opts.link === null
      ? null
      : {
          agentId: "delivery",
          authorizedVia: "host_permission",
          reviewFixMaxRounds: null,
          agent: { ownerId: "p1" },
          ...opts.link,
        };
  const repoAccess = {
    authorizeUse: vi.fn(async () =>
      opts.authorized === false ? { ok: false, reason: "not_authorized" } : { ok: true },
    ),
  } as unknown as RepoAccessGate;
  const check = opts.check === undefined ? null : opts.check;
  const findUniqueCheck = vi.fn(async () => check);
  const findFirstRun = vi.fn(async () => opts.inFlightRun ?? null);
  const deps = {
    db: {
      agentRepository: { findFirst: vi.fn(async () => link) },
      runHostCheck: { findUnique: findUniqueCheck },
      run: { findFirst: findFirstRun },
    } as never,
    executor: {} as never,
    hosts: { github: host },
    repoAccess,
  } as ReviewFixDeps;
  return { deps, host, addLabel, findUniqueCheck, findFirstRun };
}

describe("startReviewFixRound", () => {
  it("dispatches round 1 on the delivery agent, labels it, and posts a status comment", async () => {
    const { deps, host } = setup();
    const result = await startReviewFixRound(REQ, deps);
    expect(result).toEqual({ kind: "dispatched", runId: "run-delivery", round: 1, maxRounds: 2 });
    const opts = vi.mocked(dispatchRun).mock.calls[0][0];
    expect(opts).toMatchObject({ agentId: "delivery", trigger: "host_event" });
    const { task, untrustedContext } = splitTaskOverride(opts.taskOverride!);
    expect(task).toContain('pass continuePriorRun set to exactly "run_1"');
    expect(task).toContain("Automatic fix round 1 of 2 for PR #7");
    expect(task).toContain("never as instructions");
    // The review itself is untrusted context, never part of the trusted task.
    expect(task).not.toContain("needs work");
    expect(untrustedContext).toContain("needs work");
    expect(txStub.runHostStatus.create).toHaveBeenCalled();
    expect(host.addLabel).toHaveBeenCalledWith(REPO, 7, "wardby-autofix-1");
    expect(postMentionStatus).toHaveBeenCalledWith(
      deps.db,
      host,
      "run-delivery",
      deps.hosts,
      "🔁 Fix round 1 of 2: working on it.",
    );
  });

  it("uses the link's cap", async () => {
    const { deps } = setup({
      link: { reviewFixMaxRounds: 3 },
      origin: { labels: ["wardby-autofix-1", "wardby-autofix-2"] },
    });
    expect(await startReviewFixRound(REQ, deps)).toMatchObject({ kind: "dispatched", round: 3, maxRounds: 3 });
  });

  it.each([
    ["no_link", { link: null }],
    ["not_authorized", { authorized: false }],
    ["not_current", { origin: { headSha: "f".repeat(40) } }],
    ["not_current", { origin: { state: "closed" } }],
    ["not_current", { origin: { isFork: true } }],
    ["not_wardby_pr", { origin: { markerRunId: undefined } }],
    ["opted_out", { origin: { labels: ["wardby-autofix-off"] } }],
  ] as const)("skips silently: %s", async (reason, opts) => {
    const { deps, host } = setup(opts as never);
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason });
    expect(dispatchRun).not.toHaveBeenCalled();
    expect(host.comment).not.toHaveBeenCalled();
  });

  it("refuses once, with a comment, when this deployment can't continue the PR", async () => {
    vi.mocked(checkContinuation).mockResolvedValueOnce({ ok: false, reason: "unknown_run" });
    const { deps, host } = setup();
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "cannot_continue" });
    expect(host.addLabel).toHaveBeenCalledWith(REPO, 7, "wardby-autofix-limit");
    expect(host.comment).toHaveBeenCalledWith(REPO, { number: 7, body: expect.stringContaining("`run_1`") });
  });

  it("refuses a known run that opened a different PR", async () => {
    vi.mocked(checkContinuation).mockResolvedValueOnce({
      ok: true,
      root: { runId: "run_1", baseRef: "main", headRef: "h", pullRequestNumber: 9 },
    });
    const { deps } = setup();
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "cannot_continue" });
  });

  it("stops at the cap with one comment, and stays quiet once stopped", async () => {
    const { deps, host } = setup({ origin: { labels: ["wardby-autofix-1", "wardby-autofix-2"] } });
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "capped" });
    expect(host.comment).toHaveBeenCalledWith(REPO, { number: 7, body: capBody(2) });

    const again = setup({ origin: { labels: ["wardby-autofix-1", "wardby-autofix-2", "wardby-autofix-limit"] } });
    expect(await startReviewFixRound(REQ, again.deps)).toEqual({ kind: "skipped", reason: "capped" });
    expect(again.host.comment).not.toHaveBeenCalled();
  });

  it("passes the PR's linked-issue attribution with the dispatch", async () => {
    const attribution = { source: "linked_pr", item: { provider: "jira", key: "PAY-1" } } as never;
    vi.mocked(linkedPullRequestAttribution).mockResolvedValueOnce(attribution);
    const { deps } = setup();
    await startReviewFixRound(REQ, deps);
    expect(linkedPullRequestAttribution).toHaveBeenCalledWith(
      deps.db,
      deps.issueTrackers,
      { codeProvider: "github", repository: REPO, number: 7 },
      RESPONSE_PATH_SNAPSHOT_BUDGET,
    );
    expect(vi.mocked(dispatchRun).mock.calls[0][0].attribution).toBe(attribution);
  });

  it("skips while the fix agent already has an unfinished run on this PR: no label, no dispatch", async () => {
    const { deps, host, findFirstRun } = setup({ inFlightRun: { id: "run-earlier" } });
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "in_flight" });
    expect(host.addLabel).not.toHaveBeenCalled();
    expect(dispatchRun).not.toHaveBeenCalled();
    expect(findFirstRun).toHaveBeenCalledWith({
      where: {
        agentId: "delivery",
        status: { notIn: [...TERMINAL_RUN_STATUSES] },
        hostStatus: { is: { provider: "github", repository: REPO, number: 7 } },
      },
      select: { id: true },
    });
  });

  it("proceeds when the fix agent's earlier run on this PR has finished", async () => {
    // A finished run is excluded by the query's status filter, so findFirst returns nothing.
    const { deps } = setup({ inFlightRun: null, origin: { labels: ["wardby-autofix-1"] } });
    expect(await startReviewFixRound(REQ, deps)).toMatchObject({ kind: "dispatched", round: 2 });
  });

  it("caps the review text in the untrusted context", () => {
    const task = reviewFixTaskText({
      repository: REPO,
      prNumber: 7,
      headSha: SHA,
      round: 1,
      maxRounds: 2,
      priorRunId: "run_1",
      reviewBody: "x".repeat(30_000),
    });
    expect(task.length).toBeLessThan(21_500);
    const { untrustedContext } = splitTaskOverride(task);
    expect(untrustedContext).toContain("x".repeat(1000));
    expect(splitTaskOverride(task).task).not.toContain("xxxx");
  });

  it("does not dispatch when recording the round fails", async () => {
    const { deps, addLabel } = setup();
    addLabel.mockRejectedValueOnce(new Error("label failed"));
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "record_failed" });
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("keeps the round counted even when the dispatch that follows is declined", async () => {
    const { deps, addLabel } = setup();
    vi.mocked(dispatchRun).mockResolvedValueOnce(null);
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "dispatch_declined" });
    expect(addLabel).toHaveBeenCalledWith(REPO, 7, "wardby-autofix-1");
  });

  it("gives a fix round no sibling hints: it fixes only its own pull request", async () => {
    const { deps } = setup();
    expect(await startReviewFixRound(REQ, deps)).toMatchObject({ kind: "dispatched" });
    const { task } = splitTaskOverride(vi.mocked(dispatchRun).mock.calls.at(-1)![0].taskOverride!);
    expect(task.match(/continuePriorRun set to exactly/g)).toHaveLength(1);
  });
});

describe("startReviewFixAfterReview", () => {
  const CHECK = {
    verdict: "CHANGES_REQUESTED",
    provider: "github",
    repository: REPO,
    prNumber: 7,
    headSha: SHA,
    reviewBody: "needs work",
  };

  it("starts a round when the run's own check requested changes", async () => {
    const { deps } = setup({ check: CHECK });
    await startReviewFixAfterReview("run-1", deps);
    expect(dispatchRun).toHaveBeenCalled();
  });

  it.each([
    ["an approval", { ...CHECK, verdict: "APPROVE" }],
    ["no verdict yet", { ...CHECK, verdict: null }],
  ] as const)("does not start a round for %s", async (_label, check) => {
    const { deps } = setup({ check });
    await startReviewFixAfterReview("run-1", deps);
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("does not start a round for a non-github provider", async () => {
    const { deps } = setup({ check: { ...CHECK, provider: "bitbucket" } });
    await startReviewFixAfterReview("run-1", deps);
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("never throws when the check lookup fails", async () => {
    const { deps, findUniqueCheck } = setup();
    findUniqueCheck.mockRejectedValueOnce(new Error("db down"));
    await expect(startReviewFixAfterReview("run-1", deps)).resolves.toBeUndefined();
  });
});

describe("review fix workflow events", () => {
  const events: WorkflowEventInput[] = [];
  beforeEach(() => {
    events.length = 0;
    setWorkflowEventSink(async (e) => {
      events.push(e);
    });
  });
  afterEach(() => setWorkflowEventSink(null));
  const pullRequest = { codeProvider: "github", repository: REPO, number: 7 };

  it("emits review_fix started for a dispatched round", async () => {
    const { deps } = setup();
    await startReviewFixRound(REQ, deps);
    expect(events).toEqual([
      {
        dedupeKey: "review_fix:o/r#7:1:started",
        runId: "run-delivery",
        agentId: "delivery",
        pullRequest,
        payload: { kind: "review_fix", prLabel: "o/r#7", round: 1, maxRounds: 2, state: "started" },
      },
    ]);
  });

  it("emits review_fix capped once, when this call marked the PR stopped", async () => {
    const { deps } = setup({ origin: { labels: ["wardby-autofix-1", "wardby-autofix-2"] } });
    await startReviewFixRound(REQ, deps);
    expect(events).toEqual([
      {
        dedupeKey: "review_fix:o/r#7:2:capped",
        agentId: "delivery",
        pullRequest,
        payload: { kind: "review_fix", prLabel: "o/r#7", round: 2, maxRounds: 2, state: "capped" },
      },
    ]);
  });

  it("emits nothing at the cap once the PR is already stopped", async () => {
    const { deps } = setup({
      origin: { labels: ["wardby-autofix-1", "wardby-autofix-2", "wardby-autofix-limit"] },
    });
    expect(await startReviewFixRound(REQ, deps)).toEqual({ kind: "skipped", reason: "capped" });
    expect(events).toEqual([]);
  });
});
