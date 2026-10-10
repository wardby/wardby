/**
 * The `wardby merge order` check's triggers against real PostgreSQL: the
 * lead's finish, pr_closed (merged and unmerged), a new head (pr_updated,
 * including a head whose review is held for the delegating run), and the
 * reconciler sweep for missed events. The code host is a fake that records
 * every check it is asked to post. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeReviewHost, PullRequestOrigin, UpsertNamedCheckInput } from "../providers/review-host/types.js";
import { createPrismaClient } from "./db.js";
import { routeHostEvent, type HostEvent } from "./host-events.js";
import {
  MERGE_ORDER_CHECK_NAME,
  resetMergeOrderSweepForTests,
  sweepMergeOrderChecks,
  syncMergeOrderChecks,
  syncMergeOrderChecksAfterRun,
} from "./merge-order-check.js";
import { runTreeRoot } from "./related-pull-requests.js";
import type { RepoAccessGate } from "./repo-access.js";

vi.mock("./dispatch.js", () => ({
  dispatchRun: vi.fn(async (opts: { agentId: string }) => ({ run: { id: `run-${opts.agentId}-${randomUUID()}` } })),
  checkContinuation: vi.fn(),
}));

describe.skipIf(!process.env.DATABASE_URL)("wardby merge order check (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const s8 = suffix.slice(0, 8);
  const id = (name: string) => `mocheck-${name}-${suffix}`;
  const owner = id("owner");
  const agentId = id("agent");
  const reviewer = id("reviewer");
  const repoA = `mocheck/a-${s8}`;
  const repoB = `mocheck/b-${s8}`;
  const repoC = `mocheck/c-${s8}`;
  const repoD = `mocheck/d-${s8}`;
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const NEW_SHA = "fedcba9876543210fedcba9876543210fedcba98";

  interface FakePr {
    state: "open" | "closed";
    merged?: boolean;
    draft?: boolean;
    headSha: string;
    markerRunId?: string;
  }
  const prs = new Map<string, FakePr>();
  const failRead = new Set<string>();
  let failUpsert = false;
  const posted: Array<{ repository: string; input: UpsertNamedCheckInput }> = [];

  const host = {
    provider: "github",
    pullRequestHead: vi.fn(async () => ({ headSha: SHA, isFork: false, state: "open" })),
    pullRequestOrigin: vi.fn(async (repository: string, prNumber: number): Promise<PullRequestOrigin> => {
      const key = `${repository}#${prNumber}`;
      if (failRead.has(key)) throw new Error("host down");
      const pr = prs.get(key);
      if (!pr) throw new Error(`unknown ${key}`);
      return {
        headSha: pr.headSha,
        isFork: false,
        state: pr.state,
        labels: [],
        merged: pr.merged === true,
        draft: pr.draft === true,
        ...(pr.markerRunId ? { markerRunId: pr.markerRunId } : {}),
      };
    }),
    upsertNamedCheck: vi.fn(async (repository: string, input: UpsertNamedCheckInput) => {
      if (failUpsert) throw new Error("checks down");
      posted.push({ repository, input });
    }),
    readCi: vi.fn(async () => ({
      headSha: SHA,
      state: "passing",
      checks: [],
      truncated: false,
      statusesUnavailable: false,
    })),
    startCheck: vi.fn(async () => ({ checkId: "1" })),
    completeCheck: vi.fn(async () => undefined),
  } as unknown as CodeReviewHost;
  const repoAccess = {
    authorizeUse: vi.fn(async () => ({ ok: true })),
    authorizeHostUser: vi.fn(async () => ({ ok: true })),
    authorizePrincipal: vi.fn(),
  } as unknown as RepoAccessGate;
  const deps = { db, executor: {} as never, hosts: { github: host }, repoAccess, mentionHandle: "wardby" };

  /** The checks posted since the last reset, as `repo#n status/conclusion`, in posting order. */
  const verdicts = () =>
    posted.map(
      ({ repository, input }) =>
        `${repository} ${input.status}${input.status === "completed" ? `/${input.conclusion}` : ""}`,
    );
  const summaryFor = (repository: string) => posted.find((p) => p.repository === repository)?.input.summary ?? "";

  async function run(runId: string, status: "running" | "succeeded", parentRunId?: string) {
    await db.run.create({ data: { id: runId, agentId, status, ...(parentRunId ? { parentRunId } : {}) } });
  }
  async function coder(
    name: string,
    leadId: string,
    repository: string,
    number: number,
    mergeOrder: number | null,
    marker = true,
  ) {
    await run(id(name), "succeeded", leadId);
    await db.codingRun.create({
      data: {
        runId: id(name),
        task: "t",
        repository,
        baseRef: "main",
        headRef: `wardby/run-${id(name)}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        ...(mergeOrder !== null ? { mergeOrder } : {}),
        result: {
          outcome: "pull_request_opened",
          repository,
          pullRequestNumber: number,
          pullRequestUrl: `https://github.com/${repository}/pull/${number}`,
        },
      },
    });
    prs.set(`${repository}#${number}`, { state: "open", headSha: SHA, ...(marker ? { markerRunId: id(name) } : {}) });
  }

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    for (const a of [agentId, reviewer]) {
      await db.agent.create({ data: { id: a, name: a, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner } });
    }
    // A lead still running whose step 1 already merged: step 2 waits for the lead, not for step 1.
    await run(id("hold"), "running");
    await coder("hx", id("hold"), repoD, 20, 1);
    await coder("hy", id("hold"), repoD, 21, 2);
    prs.get(`${repoD}#20`)!.state = "closed";
    prs.get(`${repoD}#20`)!.merged = true;
    // A finished original request (E#40 step 1, merged; F#41 step 2) and a follow-up request, still
    // running, that continued F#41: the set spans two run trees.
    await run(id("orig"), "succeeded");
    await coder("ce", id("orig"), repoD, 40, 1);
    await coder("cf", id("orig"), repoD, 41, 2);
    Object.assign(prs.get(`${repoD}#40`)!, { state: "closed", merged: true });
    await run(id("fu"), "running");
    await run(id("cf2"), "succeeded", id("fu"));
    await db.codingRun.create({
      data: {
        runId: id("cf2"),
        task: "t",
        repository: repoD,
        baseRef: "main",
        headRef: `wardby/run-${id("cf")}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        mergeOrder: 2,
        rootCodingRunId: id("cf"),
        result: { outcome: "pull_request_updated", repository: repoD, pullRequestNumber: 41 },
      },
    });
    // Lead with three ordered steps: A#1 (1) -> B#2 (2) -> C#3 (3).
    await run(id("lead"), "running");
    await coder("ca", id("lead"), repoA, 1, 1);
    await coder("cb", id("lead"), repoB, 2, 2);
    await coder("cc", id("lead"), repoC, 3, 3);
    await coder("cn", id("lead"), repoD, 30, null); // no order: never read, never checked
    // A lead whose two PRs share one step: nothing to gate.
    await run(id("flat"), "succeeded");
    await coder("fa", id("flat"), repoD, 10, 1);
    await coder("fb", id("flat"), repoD, 11, 1);
  });

  beforeEach(() => {
    posted.length = 0;
    failRead.clear();
    failUpsert = false;
    vi.mocked(host.pullRequestOrigin!).mockClear();
  });

  afterAll(async () => {
    await db.deferredReview.deleteMany({ where: { repository: { in: [repoA, repoB, repoC, repoD] } } });
    await db.agentRepository.deleteMany({ where: { agentId: reviewer } });
    await db.codingRun.deleteMany({ where: { runId: { startsWith: "mocheck-", endsWith: suffix } } });
    await db.run.updateMany({ where: { agentId }, data: { parentRunId: null } });
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: { in: [agentId, reviewer] } } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("runTreeRoot finds the root whatever its status, and guards the repository", async () => {
    await expect(runTreeRoot(db, id("cb"), repoB.toUpperCase())).resolves.toMatchObject({
      id: id("lead"),
      status: "running",
      isOpener: false,
    });
    await expect(runTreeRoot(db, id("cb"), repoA)).resolves.toBeNull();
    await expect(runTreeRoot(db, id("flat"), repoD)).resolves.toBeNull(); // not a coding run
  });

  it("at the lead's end posts one check per ordered PR: success for step 1, in_progress for the rest", async () => {
    await db.run.update({ where: { id: id("lead") }, data: { status: "succeeded", finishedAt: new Date() } });
    await syncMergeOrderChecksAfterRun({ db, hosts: deps.hosts }, { id: id("lead"), parentRunId: null });
    expect(verdicts()).toEqual([`${repoA} completed/success`, `${repoB} in_progress`, `${repoC} in_progress`]);
    expect(posted.every((p) => p.input.name === MERGE_ORDER_CHECK_NAME && p.input.headSha === SHA)).toBe(true);
    expect(summaryFor(repoB)).toContain(`[${repoA}#1](https://github.com/${repoA}/pull/1)`);
    expect(summaryFor(repoC)).toContain(`[${repoB}#2](https://github.com/${repoB}/pull/2)`);
    const reads = vi.mocked(host.pullRequestOrigin!).mock.calls.map((c) => `${c[0]}#${c[1]}`);
    expect(reads).not.toContain(`${repoD}#30`);
  });

  it("a delegated (non-root) run's end posts nothing", async () => {
    await syncMergeOrderChecksAfterRun({ db, hosts: deps.hosts }, { id: id("ca"), parentRunId: id("lead") });
    expect(posted).toEqual([]);
  });

  it("pr_closed merged for step 1: step 2 succeeds, step 3 still waits for step 2", async () => {
    prs.get(`${repoA}#1`)!.state = "closed";
    prs.get(`${repoA}#1`)!.merged = true;
    const closed: HostEvent = { kind: "pr_closed", provider: "github", repository: repoA, prNumber: 1, merged: true };
    const routed = await routeHostEvent(closed, deps);
    for (const followUp of routed.followUps) await followUp();
    expect(verdicts()).toEqual([`${repoB} completed/success`, `${repoC} in_progress`]);
    expect(summaryFor(repoC)).toContain(`${repoB}#2`);
    expect(summaryFor(repoC)).not.toContain(`[${repoA}#1]`);
    // The event says A#1 merged: it is not read again.
    expect(vi.mocked(host.pullRequestOrigin!).mock.calls.map((c) => `${c[0]}#${c[1]}`)).not.toContain(`${repoA}#1`);
  });

  it("pr_closed unmerged for step 1: steps 2 and 3 fail, naming it", async () => {
    prs.get(`${repoA}#1`)!.merged = false;
    const closed: HostEvent = { kind: "pr_closed", provider: "github", repository: repoA, prNumber: 1, merged: false };
    const routed = await routeHostEvent(closed, deps);
    for (const followUp of routed.followUps) await followUp();
    expect(verdicts()).toEqual([`${repoB} completed/failure`, `${repoC} completed/failure`]);
    expect(summaryFor(repoB)).toContain(`[${repoA}#1](https://github.com/${repoA}/pull/1)`);
    expect(summaryFor(repoC)).toContain(`[${repoA}#1](https://github.com/${repoA}/pull/1)`);
  });

  it("a reopened dependency (pr_updated) takes its dependents from failure back to in_progress", async () => {
    prs.get(`${repoA}#1`)!.state = "open";
    const reopened: HostEvent = {
      kind: "pr_updated",
      provider: "github",
      repository: repoA,
      prNumber: 1,
      headSha: SHA,
      isFork: false,
    };
    const routed = await routeHostEvent(reopened, deps);
    for (const followUp of routed.followUps) await followUp();
    expect(verdicts()).toEqual([`${repoA} completed/success`, `${repoB} in_progress`, `${repoC} in_progress`]);
    expect(summaryFor(repoB)).toContain(`Waiting for: [${repoA}#1]`);
  });

  it("re-posts on a new head (pr_updated), also when the head's review is held for the delegating run", async () => {
    // Step 1 reopened; the lead is running again (a re-delegation), and C has a reviewer.
    prs.get(`${repoA}#1`)!.state = "open";
    await db.run.update({ where: { id: id("lead") }, data: { status: "running", finishedAt: null } });
    await db.agentRepository.create({
      data: {
        agentId: reviewer,
        provider: "github",
        repository: repoC,
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
        authorizedVia: "host_permission",
      },
    });
    prs.get(`${repoC}#3`)!.headSha = NEW_SHA;
    const pushed: HostEvent = {
      kind: "pr_updated",
      provider: "github",
      repository: repoC,
      prNumber: 3,
      headSha: NEW_SHA,
      isFork: false,
    };
    const routed = await routeHostEvent(pushed, deps);
    expect(routed.runIds).toEqual([]); // held for the lead
    expect(await db.deferredReview.count({ where: { repository: repoC } })).toBe(1);
    for (const followUp of routed.followUps) await followUp();
    const onC = posted.filter((p) => p.repository === repoC);
    expect(onC).toHaveLength(1);
    expect(onC[0].input).toMatchObject({ headSha: NEW_SHA, status: "in_progress" });
    // C#3 was read once in this event: the deferral's read is reused.
    const reads = vi.mocked(host.pullRequestOrigin!).mock.calls.map((c) => `${c[0]}#${c[1]}`);
    expect(reads.filter((r) => r === `${repoC}#3`)).toHaveLength(1);
    await db.run.update({ where: { id: id("lead") }, data: { status: "succeeded", finishedAt: new Date() } });
  });

  it("the reconciler sweep fixes a set whose pr_closed was missed", async () => {
    prs.get(`${repoA}#1`)!.state = "closed";
    prs.get(`${repoA}#1`)!.merged = true;
    prs.get(`${repoB}#2`)!.state = "closed";
    prs.get(`${repoB}#2`)!.merged = true;
    resetMergeOrderSweepForTests();
    await sweepMergeOrderChecks({ db, hosts: deps.hosts });
    // The finished hold set is swept too; of this set only C is still open.
    expect(verdicts().filter((v) => !v.startsWith(repoD))).toEqual([`${repoC} completed/success`]);
    // Throttled: a second pass right away does nothing.
    posted.length = 0;
    await sweepMergeOrderChecks({ db, hosts: deps.hosts });
    expect(posted).toEqual([]);
  });

  it("holds a later step's success as in_progress while the delegating run runs; the lead's end posts success", async () => {
    await syncMergeOrderChecks({ db, hosts: deps.hosts }, id("hold"));
    expect(verdicts()).toEqual([`${repoD} in_progress`]);
    expect(posted[0].input.headSha).toBe(SHA);
    expect(summaryFor(repoD)).toContain("delegating run is still running");
    expect(summaryFor(repoD)).toContain(`Merged: [${repoD}#20]`);
    posted.length = 0;
    await db.run.update({ where: { id: id("hold") }, data: { status: "succeeded", finishedAt: new Date() } });
    await syncMergeOrderChecksAfterRun({ db, hosts: deps.hosts }, { id: id("hold"), parentRunId: null });
    expect(verdicts()).toEqual([`${repoD} completed/success`]);
  });

  it("a set spanning a finished and a running tree holds its later steps, from either root, written once per event", async () => {
    for (const seed of [id("orig"), id("fu")]) {
      posted.length = 0;
      await syncMergeOrderChecks({ db, hosts: deps.hosts }, seed);
      expect(verdicts()).toEqual([`${repoD} in_progress`]);
      expect(summaryFor(repoD)).toContain("delegating run is still running");
    }
    // F#41 has a coding run with an order in each tree: two roots, one set, one write.
    posted.length = 0;
    const pushed: HostEvent = {
      kind: "pr_updated",
      provider: "github",
      repository: repoD,
      prNumber: 41,
      headSha: SHA,
      isFork: false,
    };
    const routed = await routeHostEvent(pushed, deps);
    for (const followUp of routed.followUps) await followUp();
    expect(verdicts()).toEqual([`${repoD} in_progress`]);
    // The follow-up's lead finishes: success.
    posted.length = 0;
    await db.run.update({ where: { id: id("fu") }, data: { status: "succeeded", finishedAt: new Date() } });
    await syncMergeOrderChecksAfterRun({ db, hosts: deps.hosts }, { id: id("fu"), parentRunId: null });
    expect(verdicts()).toEqual([`${repoD} completed/success`]);
  });

  it("a running top-level coding run that continued a PR (review fix, @mention) never holds the set", async () => {
    // A finished lead (G#50 step 1, merged; H#51 step 2) and a review fix round on H#51 that is
    // itself a top-level coding run, still running: only a native lead declares merge order.
    await run(id("orig3"), "succeeded");
    await coder("cg", id("orig3"), repoD, 50, 1);
    await coder("ch", id("orig3"), repoD, 51, 2);
    Object.assign(prs.get(`${repoD}#50`)!, { state: "closed", merged: true });
    await run(id("fix"), "running");
    await db.codingRun.create({
      data: {
        runId: id("fix"),
        task: "t",
        repository: repoD,
        baseRef: "main",
        headRef: `wardby/run-${id("ch")}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        rootCodingRunId: id("ch"),
        result: { outcome: "pull_request_updated", repository: repoD, pullRequestNumber: 51 },
      },
    });
    for (const seed of [id("orig3"), id("fix")]) {
      posted.length = 0;
      await syncMergeOrderChecks({ db, hosts: deps.hosts }, seed);
      expect(verdicts()).toEqual([`${repoD} completed/success`]);
      expect(summaryFor(repoD)).toContain(`Merged: [${repoD}#50]`);
    }
    await db.run.update({ where: { id: id("fix") }, data: { status: "succeeded", finishedAt: new Date() } });
  });

  it("the lowest step still succeeds while the delegating run runs", async () => {
    await db.run.update({ where: { id: id("lead") }, data: { status: "running", finishedAt: null } });
    for (const key of [`${repoA}#1`, `${repoB}#2`]) Object.assign(prs.get(key)!, { state: "open", merged: false });
    await syncMergeOrderChecks({ db, hosts: deps.hosts }, id("lead"));
    expect(verdicts()).toEqual([`${repoA} completed/success`, `${repoB} in_progress`, `${repoC} in_progress`]);
    await db.run.update({ where: { id: id("lead") }, data: { status: "succeeded", finishedAt: new Date() } });
  });

  it("posts nothing, and reads nothing, for a set with one distinct order", async () => {
    await syncMergeOrderChecks({ db, hosts: deps.hosts }, id("flat"));
    expect(posted).toEqual([]);
    expect(host.pullRequestOrigin).not.toHaveBeenCalled();
  });

  it("never posts on a PR without this deployment's marker, nor on a merged or closed one", async () => {
    prs.get(`${repoA}#1`)!.state = "open";
    prs.get(`${repoA}#1`)!.merged = false;
    prs.get(`${repoB}#2`)!.state = "open";
    prs.get(`${repoB}#2`)!.merged = false;
    prs.get(`${repoB}#2`)!.markerRunId = id("ca"); // a real run here, but recorded for another repository
    prs.get(`${repoC}#3`)!.state = "closed";
    await syncMergeOrderChecks({ db, hosts: deps.hosts }, id("lead"));
    expect(verdicts()).toEqual([`${repoA} completed/success`]);
    prs.get(`${repoB}#2`)!.markerRunId = id("cb");
    prs.get(`${repoC}#3`)!.state = "open";
  });

  it("logs host errors and never throws; a dependency that cannot be read holds back only its dependents", async () => {
    failRead.add(`${repoB}#2`);
    await expect(syncMergeOrderChecks({ db, hosts: deps.hosts }, id("lead"))).resolves.toBeUndefined();
    // A has no dependencies; C depends on the unreadable B; B itself was not read.
    expect(verdicts()).toEqual([`${repoA} completed/success`]);
    failRead.clear();
    failUpsert = true;
    await expect(syncMergeOrderChecks({ db, hosts: deps.hosts }, id("lead"))).resolves.toBeUndefined();
    const closed: HostEvent = { kind: "pr_closed", provider: "github", repository: repoA, prNumber: 1, merged: true };
    const routed = await routeHostEvent(closed, deps);
    for (const followUp of routed.followUps) await expect(followUp()).resolves.toBeUndefined();
    await expect(
      syncMergeOrderChecksAfterRun({ db, hosts: deps.hosts }, { id: id("lead"), parentRunId: null }),
    ).resolves.toBeUndefined();
  });
});
