/**
 * Deferred reviews (waitForCi) against real PostgreSQL: recording a deferral
 * is idempotent per head and reviewer (the unique key plus skipDuplicates),
 * and claiming by delete starts each review once even when two sweeps race.
 * Dispatch is stubbed. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { createPrismaClient } from "./db.js";
import {
  DEFERRED_REVIEW_MAX_AGE_MS,
  DEFERRED_REVIEW_MAX_WAIT_MS,
  requestLeadRunId,
  routeHostEvent,
  startDeferredForRequest,
  startDeferredReviews,
  type HostEvent,
} from "./host-events.js";
import type { RepoAccessGate } from "./repo-access.js";

vi.mock("./dispatch.js", () => ({
  dispatchRun: vi.fn(async (opts: { agentId: string }) => ({ run: { id: `run-${opts.agentId}-${randomUUID()}` } })),
  checkContinuation: vi.fn(),
}));
import { dispatchRun } from "./dispatch.js";

describe.skipIf(!process.env.DATABASE_URL)("deferred reviews (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const owner = `deferdb-owner-${suffix}`;
  const agentId = `deferdb-agent-${suffix}`;
  const repository = `deferdb/repo-${suffix.slice(0, 8)}`;
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  let ci = "pending";

  const host = {
    provider: "github",
    pullRequestHead: vi.fn(async () => ({ headSha: SHA, isFork: false, state: "open" })),
    readCi: vi.fn(async () => ({ headSha: SHA, state: ci, checks: [], truncated: false, statusesUnavailable: false })),
    startCheck: vi.fn(async () => ({ checkId: "1" })),
    completeCheck: vi.fn(async () => undefined),
  } as unknown as CodeReviewHost;
  const repoAccess = {
    authorizeUse: vi.fn(async () => ({ ok: true })),
    authorizeHostUser: vi.fn(async () => ({ ok: true })),
    authorizePrincipal: vi.fn(),
  } as unknown as RepoAccessGate;
  const deps = {
    db,
    executor: {} as never,
    hosts: { github: host },
    repoAccess,
    mentionHandle: "wardby",
  };
  const pushed: HostEvent = {
    kind: "pr_updated",
    provider: "github",
    repository,
    prNumber: 3,
    headSha: SHA,
    isFork: false,
  };
  const rows = () => db.deferredReview.findMany({ where: { repository } });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
    });
    await db.agentRepository.create({
      data: {
        agentId,
        provider: "github",
        repository,
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
        waitForCi: true,
        authorizedVia: "host_permission",
      },
    });
  });

  afterAll(async () => {
    await db.deferredReview.deleteMany({ where: { repository } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("records one row per head and reviewer however often the push is delivered", async () => {
    ci = "pending";
    await expect(routeHostEvent(pushed, deps)).resolves.toEqual({ runIds: [], followUps: [] });
    await expect(routeHostEvent(pushed, deps)).resolves.toEqual({ runIds: [], followUps: [] });
    expect(await rows()).toHaveLength(1);
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("starts the review once when two sweeps race for the same row", async () => {
    vi.mocked(dispatchRun).mockClear();
    const later = new Date(Date.now() + DEFERRED_REVIEW_MAX_WAIT_MS + 60_000);
    const [a, b] = await Promise.all([startDeferredReviews(deps, later), startDeferredReviews(deps, later)]);
    expect([...a, ...b]).toHaveLength(1);
    expect(dispatchRun).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(0);
  });
});

/**
 * Request deferrals (#259) against real PostgreSQL: a review of a pull request
 * a delegated coding run opened waits until the run tree's root lead run is
 * terminal (then CI, for waitForCi links), released by the lead's finalizer
 * (startDeferredForRequest) or the reconciler sweep, and started once.
 */
describe.skipIf(!process.env.DATABASE_URL)("request deferrals (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const id = (name: string) => `reqdefer-${name}-${suffix}`;
  const owner = id("owner");
  const waiter = id("waiter"); // linked with waitForCi
  const plain = id("plain"); // linked without waitForCi
  const repository = `reqdefer/repo-${suffix.slice(0, 8)}`;
  const otherRepository = `reqdefer/other-${suffix.slice(0, 8)}`;
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  let ci = "pending";
  /** PR number → the Wardby marker run id its body carries (absent: a human PR). */
  const markers = new Map<number, string>();

  const host = {
    provider: "github",
    pullRequestHead: vi.fn(async () => ({ headSha: SHA, isFork: false, state: "open" })),
    pullRequestOrigin: vi.fn(async (_repo: string, prNumber: number) => ({
      headSha: SHA,
      isFork: false,
      state: "open",
      labels: [],
      ...(markers.has(prNumber) ? { markerRunId: markers.get(prNumber) } : {}),
    })),
    readCi: vi.fn(async () => ({ headSha: SHA, state: ci, checks: [], truncated: false, statusesUnavailable: false })),
    startCheck: vi.fn(async () => ({ checkId: "1" })),
    completeCheck: vi.fn(async () => undefined),
  } as unknown as CodeReviewHost;
  const repoAccess = {
    authorizeUse: vi.fn(async () => ({ ok: true })),
    authorizeHostUser: vi.fn(async () => ({ ok: true })),
    authorizePrincipal: vi.fn(),
  } as unknown as RepoAccessGate;
  const deps = { db, executor: {} as never, hosts: { github: host }, repoAccess, mentionHandle: "wardby" };
  const pushed = (prNumber: number): HostEvent => ({
    kind: "pr_updated",
    provider: "github",
    repository,
    prNumber,
    headSha: SHA,
    isFork: false,
  });
  const ciDone = (prNumber: number): HostEvent => ({
    kind: "ci_completed",
    provider: "github",
    repository,
    headSha: SHA,
    prNumbers: [prNumber],
  });
  const rowsFor = (prNumber: number) =>
    db.deferredReview.findMany({
      where: { repository, prNumber },
      select: { agentId: true, reason: true, leadRunId: true },
      orderBy: { agentId: "asc" },
    });
  const dispatchedAgents = () =>
    vi
      .mocked(dispatchRun)
      .mock.calls.map((c) => c[0].agentId)
      .sort();

  async function run(runId: string, status: "running" | "succeeded" | "failed", parentRunId?: string) {
    await db.run.create({ data: { id: runId, agentId: waiter, status, ...(parentRunId ? { parentRunId } : {}) } });
  }
  async function coding(runId: string, rootCodingRunId?: string, inRepository = repository) {
    await db.codingRun.create({
      data: {
        runId,
        task: "t",
        repository: inRepository,
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        ...(rootCodingRunId ? { rootCodingRunId } : {}),
      },
    });
  }
  /** A lead (optionally under a nested native parent) that delegated one coding run, which opened PR `prNumber`. */
  async function delegatedPr(name: string, prNumber: number, leadStatus: "running" | "succeeded" | "failed") {
    await run(id(`${name}-lead`), leadStatus);
    await run(id(`${name}-mid`), "succeeded", id(`${name}-lead`));
    await run(id(`${name}-coder`), "succeeded", id(`${name}-mid`));
    await coding(id(`${name}-coder`));
    markers.set(prNumber, id(`${name}-coder`));
    return id(`${name}-lead`);
  }
  const finish = (runId: string, status: "succeeded" | "failed") =>
    db.run.update({ where: { id: runId }, data: { status, finishedAt: new Date() } });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    for (const agentId of [waiter, plain]) {
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
      });
      await db.agentRepository.create({
        data: {
          agentId,
          provider: "github",
          repository,
          access: "write",
          triggers: ["pull_request"],
          checkName: agentId === waiter ? "wardby review" : "security",
          waitForCi: agentId === waiter,
          authorizedVia: "host_permission",
        },
      });
    }
  });

  beforeEach(() => {
    vi.mocked(dispatchRun).mockClear();
  });

  afterAll(async () => {
    await db.deferredReview.deleteMany({ where: { repository } });
    await db.codingRun.deleteMany({ where: { repository: { in: [repository, otherRepository] } } });
    await db.run.updateMany({ where: { agentId: waiter }, data: { parentRunId: null } });
    await db.run.deleteMany({ where: { agentId: waiter } });
    await db.agent.deleteMany({ where: { id: { in: [waiter, plain] } } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("defers every reviewer of a delegated PR until the lead finishes, with or without waitForCi", async () => {
    const lead = await delegatedPr("defer", 10, "running");
    ci = "passing";
    await expect(routeHostEvent(pushed(10), deps)).resolves.toEqual({ runIds: [], followUps: [] });
    await expect(routeHostEvent(pushed(10), deps)).resolves.toEqual({ runIds: [], followUps: [] });
    expect(dispatchRun).not.toHaveBeenCalled();
    expect(await rowsFor(10)).toEqual([
      { agentId: plain, reason: "request", leadRunId: lead },
      { agentId: waiter, reason: "request", leadRunId: lead },
    ]);
    await expect(requestLeadRunId(db, id("defer-coder"))).resolves.toBe(lead);
  });

  it("resolves a continuation run to the tree root through its root coding run", async () => {
    await run(id("cont"), "running");
    await coding(id("cont"), id("defer-coder"));
    await expect(requestLeadRunId(db, id("cont"))).resolves.toBe(id("defer-lead"));
  });

  it("reviews as today once the lead is terminal: now, or after CI for waitForCi links", async () => {
    await delegatedPr("done", 11, "succeeded");
    ci = "pending";
    await expect(requestLeadRunId(db, id("done-coder"))).resolves.toBeNull();
    await routeHostEvent(pushed(11), deps);
    expect(dispatchedAgents()).toEqual([plain]);
    expect(await rowsFor(11)).toEqual([{ agentId: waiter, reason: "ci", leadRunId: null }]);
    await db.deferredReview.deleteMany({ where: { repository, prNumber: 11 } });
  });

  it("never follows a marker whose CodingRun opened in another repository", async () => {
    await run(id("elsewhere-lead"), "running");
    await run(id("elsewhere-coder"), "succeeded", id("elsewhere-lead"));
    await coding(id("elsewhere-coder"), undefined, otherRepository);
    // Unscoped, and scoped to its own repository (any case), the marker resolves to the running lead...
    await expect(requestLeadRunId(db, id("elsewhere-coder"))).resolves.toBe(id("elsewhere-lead"));
    await expect(requestLeadRunId(db, id("elsewhere-coder"), otherRepository.toUpperCase())).resolves.toBe(
      id("elsewhere-lead"),
    );
    // ...but a pull request in this repository carrying that marker resolves to nothing.
    await expect(requestLeadRunId(db, id("elsewhere-coder"), repository)).resolves.toBeNull();
    markers.set(14, id("elsewhere-coder"));
    ci = "passing";
    await routeHostEvent(pushed(14), deps);
    expect(dispatchedAgents()).toEqual([plain, waiter].sort());
    expect(await rowsFor(14)).toEqual([]);
  });

  it("leaves non-delegated coding PRs and human PRs unchanged", async () => {
    await run(id("solo"), "running");
    await coding(id("solo"));
    markers.set(12, id("solo"));
    ci = "passing";
    await expect(requestLeadRunId(db, id("solo"))).resolves.toBeNull();
    await routeHostEvent(pushed(12), deps);
    expect(dispatchedAgents()).toEqual([plain, waiter].sort());
    vi.mocked(dispatchRun).mockClear();
    await routeHostEvent(pushed(13), deps); // no marker: a human PR
    expect(dispatchedAgents()).toEqual([plain, waiter].sort());
    expect([...(await rowsFor(12)), ...(await rowsFor(13))]).toEqual([]);
  });

  it("ci_completed never starts a request row while its lead runs", async () => {
    ci = "passing";
    await expect(routeHostEvent(ciDone(10), deps)).resolves.toEqual({ runIds: [], followUps: [] });
    expect(dispatchRun).not.toHaveBeenCalled();
    expect(await rowsFor(10)).toHaveLength(2);
  });

  it("on the lead's finish: starts links without waitForCi, hands waitForCi links to CI, then CI starts them", async () => {
    ci = "pending";
    await finish(id("defer-lead"), "succeeded");
    await startDeferredForRequest(deps, id("defer-lead"));
    expect(dispatchedAgents()).toEqual([plain]);
    expect(await rowsFor(10)).toEqual([{ agentId: waiter, reason: "ci", leadRunId: id("defer-lead") }]);
    vi.mocked(dispatchRun).mockClear();
    ci = "passing";
    await routeHostEvent(ciDone(10), deps);
    expect(dispatchedAgents()).toEqual([waiter]);
    expect(await rowsFor(10)).toEqual([]);
  });

  it("releases the reviews when the lead failed, too", async () => {
    const lead = await delegatedPr("failed", 14, "running");
    ci = "passing";
    await routeHostEvent(pushed(14), deps);
    expect(dispatchRun).not.toHaveBeenCalled();
    await finish(lead, "failed");
    await startDeferredForRequest(deps, lead);
    expect(dispatchedAgents()).toEqual([plain, waiter].sort());
    expect(await rowsFor(14)).toEqual([]);
  });

  it("starts each review once when two releases race", async () => {
    const lead = await delegatedPr("race", 15, "running");
    ci = "passing";
    await routeHostEvent(pushed(15), deps);
    await finish(lead, "succeeded");
    await Promise.all([startDeferredForRequest(deps, lead), startDeferredForRequest(deps, lead)]);
    expect(dispatchedAgents()).toEqual([plain, waiter].sort());
    expect(await rowsFor(15)).toEqual([]);
  });

  it("sweep: starts request rows older than 15 min once the lead is terminal, keeps them while it runs, drops them after 24 h", async () => {
    const running = await delegatedPr("sweep-running", 16, "running");
    const lost = await delegatedPr("sweep-lost", 17, "running");
    ci = "passing";
    await routeHostEvent(pushed(16), deps);
    await routeHostEvent(pushed(17), deps);
    // The lead was lost: no finalizer ran, so only the sweep can release its rows.
    await db.run.update({ where: { id: lost }, data: { status: "lost", finishedAt: new Date() } });
    const later = new Date(Date.now() + DEFERRED_REVIEW_MAX_WAIT_MS + 60_000);
    await startDeferredReviews(deps, later);
    expect(dispatchedAgents()).toEqual([plain, waiter].sort());
    expect(await rowsFor(17)).toEqual([]);
    expect(await rowsFor(16)).toHaveLength(2);
    vi.mocked(dispatchRun).mockClear();
    await startDeferredReviews(deps, new Date(Date.now() + DEFERRED_REVIEW_MAX_AGE_MS + 60_000));
    expect(dispatchRun).not.toHaveBeenCalled();
    expect(await rowsFor(16)).toEqual([]);
    expect(running).toBe(id("sweep-running-lead"));
  });
});
