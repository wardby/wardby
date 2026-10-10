import { describe, expect, it, vi } from "vitest";
import {
  collectRelatedPullRequests,
  openSiblings,
  openSiblingsForIssue,
  openSiblingsOf,
  updateRelatedPullRequests,
  type RelatedPullRequestsDb,
} from "./related-pull-requests.js";
import type { CodeReviewHost } from "../providers/review-host/types.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute));
const opened = (repository: string, n: number) => ({
  outcome: "pull_request_opened",
  repository,
  pullRequestNumber: n,
  pullRequestUrl: `https://github.com/${repository}/pull/${n}`,
});

interface Row {
  runId: string;
  result: unknown;
  rootCodingRunId: string | null;
  issueProvider: string | null;
  issueKey: string | null;
  startedAt: Date;
  mergeOrder?: number | null;
}

/**
 * $queryRaw answers per call from `passes`; issuePullRequest.findMany from `issueRows`;
 * codingRun.findMany (the reverse continuation lookup) from `continuedBy`: opener runId -> continuing runIds.
 */
function db(passes: Row[][], issueRows: unknown[] = [], continuedBy: Record<string, string[]> = {}) {
  const queryRaw = vi.fn(async () => passes.shift() ?? []);
  const continuations = vi.fn(async ({ where }: { where: { rootCodingRunId: { in: string[] } } }) =>
    where.rootCodingRunId.in.flatMap((root) => (continuedBy[root] ?? []).map((runId) => ({ runId }))),
  );
  return {
    db: {
      $queryRaw: queryRaw,
      issuePullRequest: { findMany: vi.fn(async () => issueRows) },
      codingRun: { findMany: continuations },
    } as unknown as RelatedPullRequestsDb,
    queryRaw,
    continuations,
  };
}

const row = (runId: string, result: unknown, minute: number, extra: Partial<Row> = {}): Row => ({
  runId,
  result,
  rootCodingRunId: null,
  issueProvider: "jira",
  issueKey: "PROJ-13",
  startedAt: at(minute),
  ...extra,
});

describe("collectRelatedPullRequests", () => {
  it("lists the tree's opened pull requests in dispatch order, deduplicated, with the tree's issue", async () => {
    const { db: fake } = db([
      [
        row("c1", opened("acme/order-service", 2), 1),
        row("c2", opened("acme/notification-service", 2), 2),
        row("c3", { outcome: "no_changes" }, 3),
        row("c4", opened("acme/app", 4), 4),
      ],
    ]);
    const group = await collectRelatedPullRequests(fake, "parent");
    expect(group.pullRequests.map((p) => `${p.repository}#${p.number}`)).toEqual([
      "acme/order-service#2",
      "acme/notification-service#2",
      "acme/app#4",
    ]);
    expect(group.issue).toEqual({ provider: "jira", key: "PROJ-13" });
  });

  it("follows a continuation back to the original request's tree (second pass) so the set is not lost", async () => {
    const { db: fake, queryRaw } = db([
      [row("follow", { ...opened("acme/app", 4), outcome: "pull_request_updated" }, 30, { rootCodingRunId: "c4" })],
      [row("c1", opened("acme/order-service", 2), 1), row("c4", opened("acme/app", 4), 4)],
    ]);
    const group = await collectRelatedPullRequests(fake, "mention-run");
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(group.pullRequests.map((p) => `${p.repository}#${p.number}`)).toEqual([
      "acme/order-service#2",
      "acme/app#4",
    ]);
  });

  it("adds pull requests recorded for the same issue by other runs, ordered by when they were recorded", async () => {
    const { db: fake } = db(
      [[row("c4", opened("acme/app", 4), 40)]],
      [
        { repository: "acme/bff", number: 3, createdAt: at(10), openedByRunId: "old1", state: "merged" },
        { repository: "ACME/App", number: 4, createdAt: at(41), openedByRunId: "later", state: "open" },
        { repository: "acme/web", number: 9, createdAt: at(12), openedByRunId: "old2", state: "weird" },
      ],
    );
    const group = await collectRelatedPullRequests(fake, "parent");
    // Merged ones stay in the set; the tree's own opener wins over the issue row's; a stored state is kept.
    expect(group.pullRequests).toEqual([
      { repository: "acme/bff", number: 3, openedAt: at(10), openedByRunId: "old1", state: "merged" },
      { repository: "acme/web", number: 9, openedAt: at(12), openedByRunId: "old2" },
      { repository: "acme/app", number: 4, openedAt: at(40), openedByRunId: "c4", state: "open" },
    ]);
  });

  it("ignores malformed results and malformed issue keys, and skips the issue query without a key", async () => {
    const { db: fake } = db([
      [
        row("c1", { outcome: "pull_request_opened", repository: "acme/x", pullRequestNumber: -1 }, 1, {
          issueKey: "bad",
        }),
        row("c2", opened("not a repo", 2), 2, { issueKey: null }),
      ],
    ]);
    const group = await collectRelatedPullRequests(fake, "parent");
    expect(group).toEqual({ pullRequests: [] });
    expect(fake.issuePullRequest.findMany).not.toHaveBeenCalled();
  });

  it("sorts entries with orders [2, null, 1, 2] and increasing openedAt to 1, 2, 2, null (ties by openedAt, then repository#number)", async () => {
    const { db: fake } = db([
      [
        row("c1", opened("acme/r1", 1), 1, { mergeOrder: 2 }),
        row("c2", opened("acme/r2", 1), 2, { mergeOrder: null }),
        row("c3", opened("acme/r3", 1), 3, { mergeOrder: 1 }),
        row("c4", opened("acme/r4", 1), 4, { mergeOrder: 2 }),
      ],
    ]);
    const group = await collectRelatedPullRequests(fake, "parent");
    expect(group.pullRequests.map((p) => `${p.repository}#${p.number}`)).toEqual([
      "acme/r3#1",
      "acme/r1#1",
      "acme/r4#1",
      "acme/r2#1",
    ]);
    expect(group.pullRequests.map((p) => p.mergeOrder)).toEqual([1, 2, 2, undefined]);
  });

  it("uses the newest non-null mergeOrder among a PR's opener and a later continuation that overrode it", async () => {
    const { db: fake } = db([
      [
        row("c1", opened("acme/x", 1), 1, { mergeOrder: 2 }),
        row("c2", { ...opened("acme/x", 1), outcome: "pull_request_updated" }, 5, {
          mergeOrder: 1,
          rootCodingRunId: "c1",
        }),
      ],
    ]);
    const group = await collectRelatedPullRequests(fake, "parent");
    expect(group.pullRequests).toEqual([expect.objectContaining({ repository: "acme/x", number: 1, mergeOrder: 1 })]);
  });

  it("keeps the opener's mergeOrder when an (unrealistic) earlier-timestamped continuation row is seen first", async () => {
    const { db: fake } = db([
      [
        row("c0", { ...opened("acme/z", 9), outcome: "pull_request_updated" }, 1, {
          mergeOrder: 5,
          rootCodingRunId: "c1",
        }),
        row("c1", opened("acme/z", 9), 2, { mergeOrder: 4 }),
      ],
    ]);
    const group = await collectRelatedPullRequests(fake, "parent");
    expect(group.pullRequests).toEqual([expect.objectContaining({ repository: "acme/z", number: 9, mergeOrder: 4 })]);
  });

  it("leaves mergeOrder unset for an IssuePullRequest-only row (not from any CodingRun)", async () => {
    const { db: fake } = db(
      [[row("c1", opened("acme/r1", 1), 1, { mergeOrder: 3 })]],
      [{ repository: "acme/r2", number: 2, createdAt: at(5), openedByRunId: "old", state: "open" }],
    );
    const group = await collectRelatedPullRequests(fake, "parent");
    const r2 = group.pullRequests.find((p) => p.repository === "acme/r2");
    expect(r2?.mergeOrder).toBeUndefined();
  });
});

function host(origins: Record<string, { state: string; merged?: boolean; draft?: boolean; markerRunId?: string }>) {
  return {
    provider: "github",
    pullRequestOrigin: vi.fn(async (repository: string, n: number) => {
      const o = origins[`${repository}#${n}`];
      if (!o) throw new Error("github_api_error:404");
      return { headSha: "a".repeat(40), isFork: false, labels: [], ...o };
    }),
    replaceRelatedSection: vi.fn(async () => "updated" as const),
  } as unknown as CodeReviewHost & {
    pullRequestOrigin: ReturnType<typeof vi.fn>;
    replaceRelatedSection: ReturnType<typeof vi.fn>;
  };
}

/** `passes`: the collector's $queryRaw answers in order (a second pass only for a continuation). */
function finalizerDb(
  passes: Row[][],
  recorded: Record<string, string>,
  issueRows: unknown[] = [],
  continuedBy: Record<string, string[]> = {},
) {
  const { db: base } = db(passes, issueRows, continuedBy);
  Object.assign(base.codingRun, {
    findUnique: vi.fn(async ({ where }: { where: { runId: string } }) =>
      recorded[where.runId] ? { repository: recorded[where.runId] } : null,
    ),
  });
  return Object.assign(base, {
    run: { findFirst: vi.fn(async () => ({ id: "child" })) },
  }) as unknown as RelatedPullRequestsDb;
}

describe("updateRelatedPullRequests", () => {
  const rows = [
    row("c1", opened("acme/order-service", 2), 1),
    row("c2", opened("acme/bff", 3), 2),
    row("c3", opened("acme/app", 4), 3),
  ];
  const recorded = { c1: "acme/order-service", c2: "acme/bff", c3: "acme/app" };
  const trackers = { jira: { issueUrl: (k: string) => `https://example.atlassian.net/browse/${k}` } } as never;

  it("rewrites every open App-authored PR with live states, marking itself, and leaves merged ones alone", async () => {
    const h = host({
      "acme/order-service#2": { state: "closed", merged: true, markerRunId: "c1" },
      "acme/bff#3": { state: "open", draft: true, markerRunId: "c2" },
      "acme/app#4": { state: "open", markerRunId: "c3" },
    });
    await updateRelatedPullRequests(finalizerDb([rows], recorded), { id: "lead" }, { github: h }, trackers);
    expect(h.replaceRelatedSection).toHaveBeenCalledTimes(2);
    const [repo, n, input] = h.replaceRelatedSection.mock.calls[1];
    expect([repo, n, input.expectedMarkerRunId]).toEqual(["acme/app", 4, "c3"]);
    expect(input.block).toContain("1. [acme/bff#3](https://github.com/acme/bff/pull/3) — draft");
    expect(input.block).toContain("2. **This pull request** — open");
    expect(input.block).toContain("- [acme/order-service#2](https://github.com/acme/order-service/pull/2) — merged");
    expect(input.block).toContain("[PROJ-13](https://example.atlassian.net/browse/PROJ-13)");
  });

  it("never edits a PR whose marker run this deployment did not record for that repository", async () => {
    const h = host({
      "acme/order-service#2": { state: "open", markerRunId: "c1" },
      "acme/bff#3": { state: "open", markerRunId: "someone-else" },
      "acme/app#4": { state: "open" },
    });
    await updateRelatedPullRequests(finalizerDb([rows], recorded), { id: "lead" }, { github: h }, undefined);
    expect(h.replaceRelatedSection.mock.calls.map((c) => c[0])).toEqual(["acme/order-service"]);
  });

  it("does nothing for a set of one, a run without children, or without a capable host — and never throws", async () => {
    const h = host({ "acme/app#4": { state: "open", markerRunId: "c3" } });
    await updateRelatedPullRequests(finalizerDb([[rows[2]]], recorded), { id: "lead" }, { github: h }, undefined);
    const childless = finalizerDb([rows], recorded);
    (childless.run.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await updateRelatedPullRequests(childless, { id: "lead" }, { github: h }, undefined);
    await updateRelatedPullRequests(finalizerDb([rows], recorded), { id: "lead" }, undefined, undefined);
    expect(h.replaceRelatedSection).not.toHaveBeenCalled();
    const broken = finalizerDb([rows], recorded);
    (broken.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    await expect(updateRelatedPullRequests(broken, { id: "lead" }, { github: h }, undefined)).resolves.toBeUndefined();
  });

  it("keeps going when one PR can't be read or written", async () => {
    const h = host({
      "acme/bff#3": { state: "open", markerRunId: "c2" },
      "acme/app#4": { state: "open", markerRunId: "c3" },
    });
    h.replaceRelatedSection.mockRejectedValueOnce(new Error("github_api_error:500"));
    await updateRelatedPullRequests(finalizerDb([rows], recorded), { id: "lead" }, { github: h }, undefined);
    expect(h.replaceRelatedSection).toHaveBeenCalledTimes(2);
    // order-service#2 couldn't be read: listed without a state, never written
    expect(h.replaceRelatedSection.mock.calls[1][2].block).toContain(
      "1. [acme/order-service#2](https://github.com/acme/order-service/pull/2)\n",
    );
  });

  // Decision 4c: a follow-up run (a mention or a fix round on app#4) whose coding child pushed to a
  // sibling refreshes the whole set, through the continuation's second pass.
  it("refreshes every open PR of the original request when a follow-up run pushed to a sibling", async () => {
    const h = host({
      "acme/order-service#2": { state: "open", markerRunId: "c1" },
      "acme/bff#3": { state: "open", markerRunId: "c2" },
      "acme/app#4": { state: "open", markerRunId: "c3" },
    });
    const followUp = [
      row("f1", { ...opened("acme/bff", 3), outcome: "pull_request_updated" }, 50, { rootCodingRunId: "c2" }),
    ];
    await updateRelatedPullRequests(
      finalizerDb([followUp, rows], recorded),
      { id: "mention-run" },
      { github: h },
      undefined,
    );
    expect(h.replaceRelatedSection.mock.calls.map((c) => `${c[0]}#${c[1]}`)).toEqual([
      "acme/order-service#2",
      "acme/bff#3",
      "acme/app#4",
    ]);
    expect(h.replaceRelatedSection.mock.calls[2][2].block).toContain(
      "1. [acme/order-service#2](https://github.com/acme/order-service/pull/2) — open\n2. [acme/bff#3](https://github.com/acme/bff/pull/3) — open\n3. **This pull request** — open",
    );
  });

  it("uses a stored merged/closed state without reading the PR, and falls back to a stored open state", async () => {
    const h = host({ "acme/app#4": { state: "open", markerRunId: "c3" } });
    const fake = finalizerDb([[rows[2]]], { c3: "acme/app" }, [
      { repository: "acme/bff", number: 3, createdAt: at(0), openedByRunId: "old", state: "merged" },
      { repository: "acme/web", number: 5, createdAt: at(1), openedByRunId: "old2", state: "closed" },
      { repository: "acme/api", number: 6, createdAt: at(2), openedByRunId: "old3", state: "open" }, // 404s live
    ]);
    await updateRelatedPullRequests(fake, { id: "lead" }, { github: h }, undefined);
    // Stored merged/closed: never read. Stored open (and the tree's own app#4): read live.
    expect(h.pullRequestOrigin.mock.calls.map((c) => `${c[0]}#${c[1]}`)).toEqual(["acme/api#6", "acme/app#4"]);
    expect(h.replaceRelatedSection).toHaveBeenCalledTimes(1);
    const block = h.replaceRelatedSection.mock.calls[0][2].block as string;
    expect(block).toContain("1. [acme/api#6](https://github.com/acme/api/pull/6) — open");
    expect(block).toContain("- [acme/bff#3](https://github.com/acme/bff/pull/3) — merged");
    expect(block).toContain("- [acme/web#5](https://github.com/acme/web/pull/5) — closed");
  });

  it("never edits a PR whose marker names a coding run this deployment recorded for a different repository", async () => {
    const h = host({
      "acme/order-service#2": { state: "open", markerRunId: "c1" },
      // The marker names c1, a real run here, but c1 was recorded for acme/order-service, not acme/bff.
      "acme/bff#3": { state: "open", markerRunId: "c1" },
      "acme/app#4": { state: "open", markerRunId: "c3" },
    });
    await updateRelatedPullRequests(finalizerDb([rows], recorded), { id: "lead" }, { github: h }, undefined);
    expect(h.replaceRelatedSection.mock.calls.map((c) => `${c[0]}#${c[1]}`)).toEqual([
      "acme/order-service#2",
      "acme/app#4",
    ]);
  });

  // Decision 9 (parallel delegations): a lead's concurrent batch admits several coding children at
  // once, so each child's own PR-opened result is written with the batch still in flight — every
  // sibling PR's creation-time Related section lists only the siblings opened before it. The
  // lead-end refresh must still land the full set on every one of them, regardless of what each
  // one saw when it was opened.
  it("parallel delegations: PRs opened at the same moment (each saw a partial list) all get the full set at lead end", async () => {
    const same = [
      row("p1", opened("acme/order-service", 7), 1),
      row("p2", opened("acme/bff", 8), 1),
      row("p3", opened("acme/app", 9), 1),
    ];
    const h = host({
      "acme/order-service#7": { state: "open", markerRunId: "p1" },
      "acme/bff#8": { state: "open", markerRunId: "p2" },
      "acme/app#9": { state: "open", markerRunId: "p3" },
    });
    await updateRelatedPullRequests(
      finalizerDb([same], { p1: "acme/order-service", p2: "acme/bff", p3: "acme/app" }),
      { id: "lead" },
      { github: h },
      undefined,
    );
    expect(h.replaceRelatedSection).toHaveBeenCalledTimes(3);
    for (const [, , input] of h.replaceRelatedSection.mock.calls) {
      for (const n of [7, 8, 9]) {
        expect(input.block.includes(`#${n}`) || input.block.includes("**This pull request**")).toBe(true);
      }
    }
  });
});

// A request without a tracked issue: lead opens A#1 and B#2; a mention on A#1 starts follow-up F,
// which continues A#1 and opens C#3; later a mention on B#2 starts G, which continues B#2 only.
// The set reached from B (or G) must still include C#3: the collector walks forward to the lead's
// tree, then reverse from the lead's openers to F's tree.
describe("continuations in both directions (no tracked issue)", () => {
  const none = { issueProvider: null, issueKey: null };
  const a = row("a", opened("acme/a", 1), 1, none);
  const b = row("b", opened("acme/b", 2), 2, none);
  const f1 = row("f1", { ...opened("acme/a", 1), outcome: "pull_request_updated" }, 10, {
    ...none,
    rootCodingRunId: "a",
  });
  const f2 = row("f2", opened("acme/c", 3), 11, none);
  const g1 = row("g1", { ...opened("acme/b", 2), outcome: "pull_request_updated" }, 20, {
    ...none,
    rootCodingRunId: "b",
  });
  const continuedBy = { a: ["f1"], b: ["g1"] };

  it("G's finalizer writes the section on A#1, B#2 and C#3, each listing all three", async () => {
    const h = host({
      "acme/a#1": { state: "open", markerRunId: "a" },
      "acme/b#2": { state: "open", markerRunId: "b" },
      "acme/c#3": { state: "open", markerRunId: "f2" },
    });
    const fake = finalizerDb(
      [[g1], [a, b], [f1, f2]], // G's tree, forward to the lead's tree, reverse to F's tree
      { a: "acme/a", b: "acme/b", f2: "acme/c" },
      [],
      continuedBy,
    );
    await updateRelatedPullRequests(fake, { id: "G" }, { github: h }, undefined);
    expect(h.replaceRelatedSection.mock.calls.map((c) => `${c[0]}#${c[1]}`)).toEqual([
      "acme/a#1",
      "acme/b#2",
      "acme/c#3",
    ]);
    expect(h.replaceRelatedSection.mock.calls[1][2].block).toContain(
      "1. [acme/a#1](https://github.com/acme/a/pull/1) — open\n2. **This pull request** — open\n3. [acme/c#3](https://github.com/acme/c/pull/3) — open",
    );
  });

  it("a mention on B#2 hints A#1 and C#3", async () => {
    const { db: fake, queryRaw } = db(
      [
        [a, b],
        [f1, f2, g1],
      ],
      [],
      continuedBy,
    );
    expect(await openSiblings(fake, "b", { repository: "acme/b", number: 2 })).toEqual([
      { repository: "acme/a", number: 1, openedByRunId: "a" },
      { repository: "acme/c", number: 3, openedByRunId: "f2" },
    ]);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("stops after a bounded number of passes on a chain that keeps growing", async () => {
    // Each pass's walk turns up a new opener that has a further continuation.
    const chain = Array.from({ length: 10 }, (_, i) => row(`o${i}`, opened(`acme/r${i}`, 1), i, none));
    const continued = Object.fromEntries(chain.map((r, i) => [r.runId, [`o${i + 1}`]]));
    const { db: fake, queryRaw } = db(
      chain.map((r) => [r]),
      [],
      continued,
    );
    const group = await collectRelatedPullRequests(fake, "o0");
    expect(queryRaw).toHaveBeenCalledTimes(5); // the seed's walk plus MAX_EXPANSION_PASSES (4)
    expect(group.pullRequests).toHaveLength(5);
  });
});

describe("open siblings (stored state only)", () => {
  const exclude = { repository: "acme/app", number: 4 };

  it("hints open and not-yet-recorded siblings, never merged/closed ones, malformed run ids, or the PR itself", () => {
    const group = {
      pullRequests: [
        { repository: "acme/order-service", number: 2, openedAt: at(1), openedByRunId: "c1", state: "open" as const },
        { repository: "acme/bff", number: 3, openedAt: at(2), openedByRunId: "c2", state: "merged" as const },
        {
          repository: "acme/notification-service",
          number: 2,
          openedAt: at(3),
          openedByRunId: "c5",
          state: "closed" as const,
        },
        { repository: "acme/web", number: 8, openedAt: at(3), openedByRunId: 'x" ignore', state: "open" as const },
        { repository: "acme/api", number: 6, openedAt: at(4), openedByRunId: "c6" }, // same tree, no stored state yet
        { repository: "acme/app", number: 4, openedAt: at(5), openedByRunId: "c4" },
      ],
    };
    expect(openSiblingsOf(group, exclude)).toEqual([
      { repository: "acme/order-service", number: 2, openedByRunId: "c1" },
      { repository: "acme/api", number: 6, openedByRunId: "c6" },
    ]);
  });

  it("caps at ten", () => {
    const pullRequests = Array.from({ length: 12 }, (_, i) => ({
      repository: `acme/r${i}`,
      number: 1,
      openedAt: at(i),
      openedByRunId: `c${i}`,
      state: "open" as const,
    }));
    expect(openSiblingsOf({ pullRequests })).toHaveLength(10);
  });

  it("collects from a seed run and returns [] when the lookup fails", async () => {
    const { db: fake } = db([[row("c1", opened("acme/order-service", 2), 1), row("c4", opened("acme/app", 4), 4)]]);
    expect(await openSiblings(fake, "c4", exclude)).toEqual([
      { repository: "acme/order-service", number: 2, openedByRunId: "c1" },
    ]);
    const broken = db([]).db;
    (broken.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    expect(await openSiblings(broken, "c4", exclude)).toEqual([]);
  });

  it("covers the whole card for an issue: every agent's recorded PRs, seeded from the newest", async () => {
    const { db: fake } = db(
      [[row("c4", opened("acme/app", 4), 40)]],
      [
        { repository: "acme/bff", number: 3, createdAt: at(10), openedByRunId: "other-agent-run", state: "open" },
        { repository: "acme/app", number: 4, createdAt: at(41), openedByRunId: "c4", state: "open" },
      ],
    );
    (fake.issuePullRequest.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ openedByRunId: "c4" }]); // the seed lookup
    expect(await openSiblingsForIssue(fake, { provider: "jira", key: "PROJ-13" })).toEqual([
      { repository: "acme/bff", number: 3, openedByRunId: "other-agent-run" },
      { repository: "acme/app", number: 4, openedByRunId: "c4" },
    ]);
  });

  it("never leaks a different card's pull request, even from the same run tree", async () => {
    const { db: fake } = db(
      [
        [
          row("c4", opened("acme/app", 4), 40, { issueKey: "PROJ-13" }),
          // Same tree, tagged for an unrelated card: must never join PROJ-13's hints.
          row("c9", opened("acme/other", 1), 41, { issueKey: "PROJ-99" }),
        ],
      ],
      [{ repository: "acme/app", number: 4, createdAt: at(40), openedByRunId: "c4", state: "open" }],
    );
    (fake.issuePullRequest.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ openedByRunId: "c4" }]); // the seed lookup
    expect(await openSiblingsForIssue(fake, { provider: "jira", key: "PROJ-13" })).toEqual([
      { repository: "acme/app", number: 4, openedByRunId: "c4" },
    ]);
  });

  it("scopes the issue join to exactly the event's issue key, not every issue key the tree carries", async () => {
    const { db: fake } = db(
      [
        [
          row("c4", opened("acme/app", 4), 40, { issueKey: "PROJ-13" }),
          row("c9", { outcome: "no_changes" }, 41, { issueKey: "PROJ-99" }),
        ],
      ],
      [{ repository: "acme/app", number: 4, createdAt: at(40), openedByRunId: "c4", state: "open" }],
    );
    (fake.issuePullRequest.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ openedByRunId: "c4" }]); // the seed lookup
    await openSiblingsForIssue(fake, { provider: "jira", key: "PROJ-13" });
    expect(fake.issuePullRequest.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ issueProvider: "jira", issueKey: "PROJ-13" }] }),
      }),
    );
  });
});
