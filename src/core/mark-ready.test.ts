import { describe, expect, it, vi } from "vitest";
import { markReadyAfterRun, maybeMarkReady } from "./mark-ready.js";

const SHA = "a".repeat(40);

const AUTH = "host_permission";
const BUILDER = {
  agentId: "builder",
  access: "write",
  triggers: [],
  checkName: null,
  markReadyWhenPassing: true,
  authorizedVia: AUTH,
};
const REVIEWER = {
  agentId: "reviewer",
  access: "write",
  triggers: ["pull_request"],
  checkName: "wardby review",
  markReadyWhenPassing: false,
  authorizedVia: AUTH,
};
const OPENED = {
  outcome: "pull_request_opened",
  repository: "acme/web",
  pullRequestNumber: 7,
  pullRequestUrl: "https://github.com/acme/web/pull/7",
};

const rootRow = (fields: Record<string, unknown>) => ({
  runId: "root",
  repository: "acme/web",
  rootCodingRunId: null,
  markedReadyAt: null,
  result: OPENED,
  run: { agentId: "builder" },
  ...fields,
});

interface CheckView {
  status: string;
  conclusion: string | null;
}

function setup(
  over: Partial<{
    links: unknown[];
    origin: Record<string, unknown>;
    checks: Map<string, CheckView>;
    ci: Record<string, unknown>;
    root: Record<string, unknown> | null;
    claimCount: number;
    mark: "marked" | "skipped" | Error;
    hostCheck: Record<string, unknown> | null;
    runs: Record<string, { agentId: string; parentRunId: string | null }>;
    continuations: Array<{ result: unknown; run: { status: string } }>;
  }> = {},
) {
  const links = over.links ?? [BUILDER, REVIEWER];
  const db = {
    agentRepository: { findMany: vi.fn(async (_args: unknown) => links) },
    codingRun: {
      findUnique: vi.fn(async (_args: unknown): Promise<Record<string, unknown> | null> =>
        over.root === undefined ? rootRow({}) : over.root,
      ),
      updateMany: vi.fn(async (_args: unknown) => ({ count: over.claimCount ?? 1 })),
      findMany: vi.fn(async (_args: unknown) => over.continuations ?? []),
    },
    runHostCheck: {
      findUnique: vi.fn(async (_args: unknown) => (over.hostCheck === undefined ? null : over.hostCheck)),
    },
    run: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => over.runs?.[args.where.id] ?? null),
    },
  };
  const host = {
    pullRequestOrigin: vi.fn(async (_repository: string, _prNumber: number) => ({
      headSha: SHA,
      isFork: false,
      state: "open",
      draft: true,
      markerRunId: "root",
      labels: [],
      ...over.origin,
    })),
    readOwnChecks: vi.fn(
      async (_repository: string, _headSha: string, _names: string[]) =>
        over.checks ?? new Map([["wardby review", { status: "completed", conclusion: "success" }]]),
    ),
    readCi: vi.fn(async () => ({
      headSha: SHA,
      state: "passing",
      checks: [],
      truncated: false,
      statusesUnavailable: false,
      ...over.ci,
    })),
    markReadyForReview: vi.fn(
      async (_repository: string, _prNumber: number, _sha: string, _expectedMarkerRunId: string) => {
        const m = over.mark ?? "marked";
        if (m instanceof Error) throw m;
        return m;
      },
    ),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  return { db, host, log, deps: { db, hosts: { github: host }, log } as never };
}

describe("maybeMarkReady", () => {
  it("marks when every condition holds", async () => {
    const { deps, host, db, log } = setup();
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
    expect(host.markReadyForReview).toHaveBeenCalledWith("acme/web", 7, SHA, "root");
    expect(host.readOwnChecks).toHaveBeenCalledWith("acme/web", SHA, ["wardby merge order", "wardby review"]);
    expect(db.codingRun.updateMany).toHaveBeenCalledTimes(1);
    const claim = (db.codingRun.updateMany.mock.calls[0] as unknown[])[0] as {
      where: { runId: string; markedReadyAt: null };
      data: { markedReadyAt: Date };
    };
    expect(claim.where).toEqual({ runId: "root", markedReadyAt: null });
    expect(claim.data.markedReadyAt).toBeInstanceOf(Date);
    expect(log.info).toHaveBeenCalled();
  });

  describe("work a run stopped at its budget", () => {
    const UPDATED = { ...OPENED, outcome: "pull_request_updated" };

    it("never marks a pull request whose opening run stopped at its budget", async () => {
      const { deps, host, db } = setup({ root: rootRow({ run: { agentId: "builder", status: "budget_exhausted" } }) });
      expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
      expect(host.markReadyForReview).not.toHaveBeenCalled();
      expect(db.codingRun.updateMany).not.toHaveBeenCalled();
    });

    it("never marks one whose latest pushing continuation stopped at its budget", async () => {
      const { deps, host } = setup({
        root: rootRow({ run: { agentId: "builder", status: "succeeded" } }),
        continuations: [
          { result: { outcome: "no_changes" }, run: { status: "succeeded" } },
          { result: UPDATED, run: { status: "budget_exhausted" } },
          { result: UPDATED, run: { status: "succeeded" } },
        ],
      });
      expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
      expect(host.markReadyForReview).not.toHaveBeenCalled();
    });

    it("marks it once a later continuation finished the work", async () => {
      const { deps, db } = setup({
        root: rootRow({ run: { agentId: "builder", status: "budget_exhausted" } }),
        continuations: [{ result: UPDATED, run: { status: "succeeded" } }],
      });
      expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
      expect(db.codingRun.findMany).toHaveBeenCalledWith({
        where: { rootCodingRunId: "root" },
        select: { result: true, run: { select: { status: true } } },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  it("is off with no host reads when no write link opted in", async () => {
    const { deps, host } = setup({
      links: [{ ...BUILDER, markReadyWhenPassing: false }],
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("off");
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("is off when only a read link opted in", async () => {
    const { deps, host } = setup({
      links: [{ ...BUILDER, access: "read" }],
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("off");
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("is off with no host reads when the opted-in builder link is unauthorized", async () => {
    const { deps, host } = setup({ links: [{ ...BUILDER, authorizedVia: null }, REVIEWER] });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("off");
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("a second, unauthorized reviewer whose check is missing does not block marking", async () => {
    const { deps, host } = setup({
      links: [BUILDER, REVIEWER, { ...REVIEWER, agentId: "rogue", checkName: "rogue review", authorizedVia: null }],
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
    expect(host.readOwnChecks).toHaveBeenCalledWith("acme/web", SHA, ["wardby merge order", "wardby review"]);
  });

  it("still reads the merge order check with 9 authorized reviewer check names", async () => {
    const reviewers = Array.from({ length: 9 }, (_, i) => ({
      ...REVIEWER,
      agentId: `reviewer-${i}`,
      checkName: `review-${i}`,
    }));
    const names = reviewers.map((r) => r.checkName);
    const checks = new Map<string, CheckView>([
      ...names.map((name): [string, CheckView] => [name, { status: "completed", conclusion: "success" }]),
      ["wardby merge order", { status: "completed", conclusion: "success" }],
    ]);
    const { deps, host } = setup({ links: [BUILDER, ...reviewers], checks });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
    expect(host.readOwnChecks).toHaveBeenCalledWith("acme/web", SHA, ["wardby merge order", ...names]);
  });

  it("is not_ready with 10 authorized reviewer check names, without reading the host at all", async () => {
    const reviewers = Array.from({ length: 10 }, (_, i) => ({
      ...REVIEWER,
      agentId: `reviewer-${i}`,
      checkName: `review-${i}`,
    }));
    const { deps, host } = setup({ links: [BUILDER, ...reviewers] });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
    expect(host.readOwnChecks).not.toHaveBeenCalled();
  });

  it("is off when the provider has no host", async () => {
    const { deps } = setup();
    expect(await maybeMarkReady(deps, "acme/web", 7, "local")).toBe("off");
  });

  it.each([
    ["no reviewer link", { links: [BUILDER] }],
    ["not a draft", { origin: { draft: false } }],
    ["closed", { origin: { state: "closed" } }],
    ["a fork", { origin: { isFork: true } }],
    ["no Wardby marker", { origin: { markerRunId: undefined } }],
    ["review failed", { checks: new Map([["wardby review", { status: "completed", conclusion: "failure" }]]) }],
    ["review missing", { checks: new Map() }],
    ["review in progress", { checks: new Map([["wardby review", { status: "in_progress", conclusion: null }]]) }],
    [
      "merge order waiting",
      {
        checks: new Map([
          ["wardby review", { status: "completed", conclusion: "success" }],
          ["wardby merge order", { status: "in_progress", conclusion: null }],
        ]),
      },
    ],
    ["CI pending", { ci: { state: "pending" } }],
    ["CI failing", { ci: { state: "failing" } }],
    ["CI unavailable", { ci: { state: "unavailable" } }],
    ["CI truncated", { ci: { truncated: true } }],
    ["the marker names no coding run", { root: null }],
    ["opened by another agent", { root: rootRow({ run: { agentId: "someone-else" } }) }],
    ["opener repository differs", { root: rootRow({ repository: "acme/other" }) }],
    ["the only reviewer link is unauthorized", { links: [BUILDER, { ...REVIEWER, authorizedVia: null }] }],
    [
      "the opener recorded a different pull request",
      { root: rootRow({ result: { ...OPENED, pullRequestNumber: 8 } }) },
    ],
    ["the opener recorded no pull request", { root: rootRow({ result: null }) }],
  ])("is not ready when %s", async (_why, over) => {
    const { deps, host } = setup(over);
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("accepts a repository with no CI", async () => {
    const { deps } = setup({ ci: { state: "none" } });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
  });

  it("accepts a successful merge order check", async () => {
    const { deps } = setup({
      checks: new Map([
        ["wardby review", { status: "completed", conclusion: "success" }],
        ["wardby merge order", { status: "completed", conclusion: "success" }],
      ]),
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
  });

  it("matches the opener's repository case-insensitively", async () => {
    const { deps } = setup({ root: rootRow({ repository: "Acme/Web" }) });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
  });

  it("skips when already marked once", async () => {
    const { deps, host } = setup({ root: rootRow({ markedReadyAt: new Date() }) });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("skipped");
    expect(host.readOwnChecks).not.toHaveBeenCalled();
  });

  it("skips when another evaluation won the claim", async () => {
    const { deps, host } = setup({ claimCount: 0 });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("skipped");
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("releases its claim when the host skips or fails", async () => {
    for (const mark of ["skipped", new Error("boom")] as const) {
      const { deps, db } = setup({ mark });
      expect(await maybeMarkReady(deps, "acme/web", 7)).toBe(mark === "skipped" ? "skipped" : "failed");
      expect(db.codingRun.updateMany).toHaveBeenCalledTimes(2);
      const claim = (db.codingRun.updateMany.mock.calls[0] as unknown[])[0] as { data: { markedReadyAt: Date } };
      const release = (db.codingRun.updateMany.mock.calls[1] as unknown[])[0] as {
        where: { markedReadyAt: Date };
        data: { markedReadyAt: null };
      };
      expect(release.data.markedReadyAt).toBeNull();
      expect(release.where.markedReadyAt).toBeInstanceOf(Date);
      expect(release.where.markedReadyAt).toBe(claim.data.markedReadyAt);
    }
  });

  it("resolves a continuation's root coding run", async () => {
    const { deps, db } = setup();
    db.codingRun.findUnique
      .mockResolvedValueOnce({
        runId: "cont",
        repository: "acme/web",
        rootCodingRunId: "root",
        markedReadyAt: null,
        run: { agentId: "fixer" },
      })
      .mockResolvedValueOnce(rootRow({}));
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
    expect(db.codingRun.findUnique).toHaveBeenCalledTimes(2);
    expect((db.codingRun.findUnique.mock.calls[1] as unknown[])[0]).toMatchObject({ where: { runId: "root" } });
    const claim = (db.codingRun.updateMany.mock.calls[0] as unknown[])[0] as { where: { runId: string } };
    expect(claim.where.runId).toBe("root");
  });

  it("is not ready when a continuation's root is missing", async () => {
    const { deps, db, host } = setup();
    db.codingRun.findUnique
      .mockResolvedValueOnce({
        runId: "cont",
        repository: "acme/web",
        rootCodingRunId: "root",
        markedReadyAt: null,
        run: { agentId: "builder" },
      })
      .mockResolvedValueOnce(null);
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("is not ready when a continuation in this repository has its root in another", async () => {
    const { deps, db, host } = setup();
    db.codingRun.findUnique
      .mockResolvedValueOnce({
        runId: "cont",
        repository: "acme/web",
        rootCodingRunId: "root",
        markedReadyAt: null,
        result: { ...OPENED, outcome: "pull_request_updated" },
        run: { agentId: "builder" },
      })
      .mockResolvedValueOnce(rootRow({ repository: "acme/other", result: { ...OPENED, repository: "acme/other" } }));
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
    expect(host.readOwnChecks).not.toHaveBeenCalled();
    expect(db.codingRun.updateMany).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    const { deps, host, log } = setup();
    host.pullRequestOrigin.mockRejectedValueOnce(new Error("down"));
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("failed");
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("maybeMarkReady with a delegating lead", () => {
  // A native lead (triggered by mention / review_fix) delegates to a coding builder sub-agent,
  // which opens the pull request. Coding agents cannot link repositories, so the opt-in lives
  // on the lead's write link.
  const LEAD = {
    agentId: "lead",
    access: "write",
    triggers: ["mention", "review_fix"],
    checkName: null,
    markReadyWhenPassing: true,
    authorizedVia: AUTH,
  };
  const delegated = rootRow({ run: { agentId: "builder", parentRunId: "lead-run" } });
  const leadRuns = { "lead-run": { agentId: "lead", parentRunId: null } };

  it("marks when the builder's ancestor lead has an opted-in write link", async () => {
    const { deps, host, db } = setup({ links: [LEAD, REVIEWER], root: delegated, runs: leadRuns });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
    expect(host.markReadyForReview).toHaveBeenCalledWith("acme/web", 7, SHA, "root");
    expect((db.run.findUnique.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { id: "lead-run" } });
  });

  it("marks through several delegation hops", async () => {
    const { deps } = setup({
      links: [LEAD, REVIEWER],
      root: rootRow({ run: { agentId: "builder", parentRunId: "mid-run" } }),
      runs: { "mid-run": { agentId: "planner", parentRunId: "lead-run" }, ...leadRuns },
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
  });

  it("is off with no host reads when the lead's link is not opted in", async () => {
    const { deps, host } = setup({
      links: [{ ...LEAD, markReadyWhenPassing: false }, REVIEWER],
      root: delegated,
      runs: leadRuns,
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("off");
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("is not ready when the lead is not opted in but an agent outside the run tree is", async () => {
    const { deps, host } = setup({
      links: [{ ...LEAD, markReadyWhenPassing: false }, { ...LEAD, agentId: "stranger" }, REVIEWER],
      root: delegated,
      runs: leadRuns,
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("is not ready when the lead's opted-in link is unauthorized", async () => {
    const { deps, host } = setup({
      links: [{ ...LEAD, authorizedVia: null }, { ...LEAD, agentId: "stranger" }, REVIEWER],
      root: delegated,
      runs: leadRuns,
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("does not walk the run tree when the opener itself is opted in", async () => {
    const { deps, db } = setup({ root: rootRow({ run: { agentId: "builder", parentRunId: "lead-run" } }) });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
    expect(db.run.findUnique).not.toHaveBeenCalled();
  });

  // A chain where the lead's run is `hops` parent links above the builder's run.
  const chainTo = (hops: number) => {
    const runs: Record<string, { agentId: string; parentRunId: string | null }> = {};
    for (let i = 1; i < hops; i++) runs[`run-${i}`] = { agentId: `mid-${i}`, parentRunId: `run-${i + 1}` };
    runs[`run-${hops}`] = { agentId: "lead", parentRunId: null };
    return setup({
      links: [LEAD, REVIEWER],
      root: rootRow({ run: { agentId: "builder", parentRunId: "run-1" } }),
      runs,
    });
  };

  it("finds an opted-in lead exactly 10 hops up the run tree", async () => {
    const { deps, db } = chainTo(10);
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("marked");
    expect(db.run.findUnique).toHaveBeenCalledTimes(10);
  });

  it("bounds the walk: an opted-in lead 11 hops up does not count", async () => {
    const { deps, db, host } = chainTo(11);
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
    expect(db.run.findUnique).toHaveBeenCalledTimes(10);
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("stops on a cycle in the run tree", async () => {
    const { deps, db } = setup({
      links: [LEAD, REVIEWER],
      root: rootRow({ run: { agentId: "builder", parentRunId: "a" } }),
      runs: { a: { agentId: "x", parentRunId: "b" }, b: { agentId: "y", parentRunId: "a" } },
    });
    expect(await maybeMarkReady(deps, "acme/web", 7)).toBe("not_ready");
    expect(db.run.findUnique.mock.calls.length).toBeLessThanOrEqual(10);
  });
});

describe("markReadyAfterRun", () => {
  it("is null when the run reviewed no pull request", async () => {
    const { deps, host } = setup();
    expect(await markReadyAfterRun(deps, "run-1")).toBeNull();
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("is null when the row has no pull request number", async () => {
    const { deps } = setup({
      hostCheck: { provider: "github", repository: "acme/web", prNumber: null, verdict: "APPROVE" },
    });
    expect(await markReadyAfterRun(deps, "run-1")).toBeNull();
  });

  it("is null when the run published no verdict", async () => {
    const { deps, host } = setup({
      hostCheck: { provider: "github", repository: "acme/web", prNumber: 7, verdict: null },
    });
    expect(await markReadyAfterRun(deps, "run-1")).toBeNull();
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("delegates to maybeMarkReady for the reviewed pull request", async () => {
    const { deps, db, host } = setup({
      hostCheck: { provider: "github", repository: "acme/web", prNumber: 7, verdict: "APPROVE" },
    });
    expect(await markReadyAfterRun(deps, "run-1")).toBe("marked");
    expect((db.runHostCheck.findUnique.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { runId: "run-1" } });
    expect(host.markReadyForReview).toHaveBeenCalledWith("acme/web", 7, SHA, "root");
  });

  it("never throws", async () => {
    const { deps, db } = setup();
    db.runHostCheck.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await markReadyAfterRun(deps, "run-1")).toBe("failed");
  });
});
