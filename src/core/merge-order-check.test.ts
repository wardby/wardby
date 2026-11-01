// src/core/merge-order-check.test.ts
import { describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import {
  mergeOrderVerdict,
  syncMergeOrderChecks,
  type MergeOrderDb,
  type MergeOrderMember,
} from "./merge-order-check.js";

vi.mock("./mark-ready.js", () => ({ maybeMarkReady: vi.fn(async () => "off") }));
import { maybeMarkReady } from "./mark-ready.js";

function member(partial: Partial<MergeOrderMember> & { repository: string; number: number }): MergeOrderMember {
  return { mergeOrder: null, state: "open", ...partial };
}

describe("mergeOrderVerdict", () => {
  it("skips when the set has fewer than 2 distinct non-null orders", () => {
    const self = member({ repository: "a/b", number: 1, mergeOrder: 1 });
    const peer = member({ repository: "a/c", number: 2, mergeOrder: 1 });
    expect(mergeOrderVerdict(self, [self, peer])).toEqual({ status: "skip" });
  });

  it("skips when the set has no non-null orders at all", () => {
    const self = member({ repository: "a/b", number: 1, mergeOrder: null });
    const peer = member({ repository: "a/c", number: 2, mergeOrder: null });
    expect(mergeOrderVerdict(self, [self, peer])).toEqual({ status: "skip" });
  });

  it("skips when self has no order, even though the set has distinct orders", () => {
    const self = member({ repository: "a/b", number: 1, mergeOrder: null });
    const dep = member({ repository: "a/c", number: 2, mergeOrder: 1, state: "merged" });
    const other = member({ repository: "a/d", number: 3, mergeOrder: 2 });
    expect(mergeOrderVerdict(self, [self, dep, other])).toEqual({ status: "skip" });
  });

  it("succeeds with no dependencies for the lowest step", () => {
    const self = member({ repository: "a/b", number: 1, mergeOrder: 1 });
    const later = member({ repository: "a/c", number: 2, mergeOrder: 2 });
    expect(mergeOrderVerdict(self, [self, later])).toEqual({ status: "success", dependencies: [] });
  });

  it("succeeds when every lower-order dependency has merged", () => {
    const self = member({ repository: "a/b", number: 2, mergeOrder: 2 });
    const dep1 = member({ repository: "a/c", number: 1, mergeOrder: 1, state: "merged" });
    const dep0 = member({ repository: "a/e", number: 0, mergeOrder: 0, state: "merged" });
    expect(mergeOrderVerdict(self, [self, dep1, dep0])).toEqual({
      status: "success",
      dependencies: [dep1, dep0],
    });
  });

  it("is in_progress, listing the unmerged lower-order dependency, when one dep is still open", () => {
    const self = member({ repository: "a/b", number: 2, mergeOrder: 2 });
    const dep = member({ repository: "a/c", number: 1, mergeOrder: 1, state: "open" });
    expect(mergeOrderVerdict(self, [self, dep])).toEqual({ status: "in_progress", waitingFor: [dep] });
  });

  it("is in_progress for a draft lower-order dependency too", () => {
    const self = member({ repository: "a/b", number: 2, mergeOrder: 2 });
    const dep = member({ repository: "a/c", number: 1, mergeOrder: 1, state: "draft" });
    expect(mergeOrderVerdict(self, [self, dep])).toEqual({ status: "in_progress", waitingFor: [dep] });
  });

  it("fails, naming the closed-unmerged dependency, when a lower-order dep closed unmerged", () => {
    const self = member({ repository: "a/b", number: 2, mergeOrder: 2 });
    const dep = member({ repository: "a/c", number: 1, mergeOrder: 1, state: "closed" });
    expect(mergeOrderVerdict(self, [self, dep])).toEqual({ status: "failure", closedUnmerged: [dep] });
  });

  it("prefers failure over in_progress when one dep is closed unmerged and another is still pending", () => {
    const self = member({ repository: "a/b", number: 3, mergeOrder: 3 });
    const closedDep = member({ repository: "a/c", number: 1, mergeOrder: 1, state: "closed" });
    const pendingDep = member({ repository: "a/d", number: 2, mergeOrder: 2, state: "open" });
    expect(mergeOrderVerdict(self, [self, closedDep, pendingDep])).toEqual({
      status: "failure",
      closedUnmerged: [closedDep],
    });
  });

  it("does not treat an equal-order peer as a dependency", () => {
    const self = member({ repository: "a/b", number: 2, mergeOrder: 2 });
    const peer = member({ repository: "a/f", number: 5, mergeOrder: 2, state: "open" });
    const dep = member({ repository: "a/c", number: 1, mergeOrder: 1, state: "merged" });
    expect(mergeOrderVerdict(self, [self, peer, dep])).toEqual({ status: "success", dependencies: [dep] });
  });

  it("counts self's own order toward the distinct orders when the set omits self", () => {
    const self = member({ repository: "a/b", number: 2, mergeOrder: 2 });
    const dep = member({ repository: "a/c", number: 1, mergeOrder: 1, state: "open" });
    expect(mergeOrderVerdict(self, [dep])).toEqual({ status: "in_progress", waitingFor: [dep] });
    const first = member({ repository: "a/c", number: 1, mergeOrder: 1 });
    const later = member({ repository: "a/b", number: 2, mergeOrder: 2 });
    expect(mergeOrderVerdict(first, [later])).toEqual({ status: "success", dependencies: [] });
  });

  it("never treats a null-order member as a dependency", () => {
    const self = member({ repository: "a/b", number: 2, mergeOrder: 2 });
    const noOrder = member({ repository: "a/g", number: 9, mergeOrder: null, state: "open" });
    const dep = member({ repository: "a/c", number: 1, mergeOrder: 1, state: "merged" });
    expect(mergeOrderVerdict(self, [self, noOrder, dep])).toEqual({ status: "success", dependencies: [dep] });
  });
});

describe("syncMergeOrderChecks across hosts", () => {
  const SHA = "a".repeat(40);

  /** A host whose every pull request is open and carries the marker of the run recorded for it. */
  function checkHost(provider: string) {
    return {
      provider,
      pullRequestOrigin: vi.fn(async (_repository: string, number: number) => ({
        headSha: SHA,
        isFork: false,
        state: "open",
        labels: [],
        markerRunId: `run-${number}`,
      })),
      upsertNamedCheck: vi.fn(async () => undefined),
    } as unknown as CodeReviewHost & {
      pullRequestOrigin: ReturnType<typeof vi.fn>;
      upsertNamedCheck: ReturnType<typeof vi.fn>;
    };
  }

  /** The collector's reads: one tree holding these pull requests, each opened by `run-<number>`. */
  function dbWithSet(prs: Array<{ repository: string; number: number; mergeOrder: number }>) {
    const repositoryOf = (runId: string) => prs.find((pr) => `run-${pr.number}` === runId)?.repository;
    return {
      $queryRaw: vi.fn(async () =>
        prs.map((pr) => ({
          runId: `run-${pr.number}`,
          result: { outcome: "pull_request_opened", repository: pr.repository, pullRequestNumber: pr.number },
          rootCodingRunId: null,
          issueProvider: null,
          issueKey: null,
          startedAt: new Date(Date.UTC(2026, 10, 1, 12, pr.number)),
          mergeOrder: pr.mergeOrder,
        })),
      ),
      issuePullRequest: { findMany: vi.fn(async () => []) },
      codingRun: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async ({ where }: { where: { runId: string } }) => ({
          repository: repositoryOf(where.runId),
        })),
      },
    } as unknown as MergeOrderDb;
  }

  it("reads and writes each pull request through its own host", async () => {
    const github = checkHost("github");
    const bitbucket = checkHost("bitbucket");
    const db = dbWithSet([
      { repository: "acme/api", number: 1, mergeOrder: 1 },
      { repository: "bitbucket:acme/web", number: 2, mergeOrder: 2 },
    ]);
    await syncMergeOrderChecks({ db, hosts: { github, bitbucket } }, "seed", {});
    expect(github.pullRequestOrigin).toHaveBeenCalledWith("acme/api", 1);
    expect(bitbucket.pullRequestOrigin).toHaveBeenCalledWith("bitbucket:acme/web", 2);
    expect(github.upsertNamedCheck).toHaveBeenCalledWith("acme/api", expect.anything());
    expect(bitbucket.upsertNamedCheck).toHaveBeenCalledWith("bitbucket:acme/web", expect.anything());
    expect(github.pullRequestOrigin).not.toHaveBeenCalledWith("bitbucket:acme/web", 2);
    expect(github.upsertNamedCheck).not.toHaveBeenCalledWith("bitbucket:acme/web", expect.anything());
  });

  it("treats a member whose host is missing like one that could not be read", async () => {
    const github = checkHost("github");
    const db = dbWithSet([
      { repository: "bitbucket:acme/web", number: 1, mergeOrder: 1 },
      { repository: "acme/api", number: 2, mergeOrder: 2 },
      { repository: "acme/ui", number: 3, mergeOrder: 3 },
    ]);
    await syncMergeOrderChecks({ db, hosts: { github } }, "seed", {});
    // Its later steps depend on it, so their checks are held back; nothing is written to the wrong host.
    expect(github.pullRequestOrigin).not.toHaveBeenCalledWith("bitbucket:acme/web", 1);
    expect(github.upsertNamedCheck).not.toHaveBeenCalled();
  });

  it("marks ready through the host that passed the check", async () => {
    const bitbucket = checkHost("bitbucket");
    const github = checkHost("github");
    vi.mocked(maybeMarkReady).mockClear();
    const db = dbWithSet([
      { repository: "bitbucket:acme/web", number: 1, mergeOrder: 1 },
      { repository: "acme/api", number: 2, mergeOrder: 2 },
    ]);
    await syncMergeOrderChecks({ db, hosts: { github, bitbucket } }, "seed", {});
    expect(vi.mocked(maybeMarkReady).mock.calls.map((call) => call.slice(1))).toEqual([
      ["bitbucket:acme/web", 1, "bitbucket"],
    ]);
  });
});
