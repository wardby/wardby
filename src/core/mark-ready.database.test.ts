/**
 * Mark-ready's once-per-pull-request claim (CodingRun.markedReadyAt) against
 * real PostgreSQL: concurrent evaluations mark once, a later evaluation after
 * marking is final, and a host failure releases the claim; and a lead's opt-in
 * reaches the coding builder it delegated to through the run tree. The code host
 * is a fake that reports every condition passing. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { createPrismaClient } from "./db.js";
import { maybeMarkReady } from "./mark-ready.js";

describe.skipIf(!process.env.DATABASE_URL)("mark ready when passing (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const s8 = suffix.slice(0, 8);
  const id = (name: string) => `markready-${name}-${suffix}`;
  const owner = id("owner");
  const builder = id("builder");
  const reviewer = id("reviewer");
  const lead = id("lead");
  const subBuilder = id("sub-builder");
  const stranger = id("stranger");
  const otherLead = id("other-lead");
  const repository = `markready/web-${s8}`;
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  let failMark = false;
  const host = {
    provider: "github",
    pullRequestOrigin: vi.fn(async (_repository: string, prNumber: number) => ({
      headSha: SHA,
      isFork: false,
      state: "open",
      labels: [],
      draft: true,
      markerRunId: prNumber === 7 ? id("root") : id(`sub-${prNumber}`),
    })),
    readOwnChecks: vi.fn(
      async () => new Map([[`wardby review ${s8}`, { status: "completed", conclusion: "success" }]]),
    ),
    readCi: vi.fn(async () => ({
      headSha: SHA,
      state: "passing",
      checks: [],
      truncated: false,
      statusesUnavailable: false,
    })),
    markReadyForReview: vi.fn(async () => {
      // Yield so a concurrent evaluation reaches its claim while this one is "on the host".
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (failMark) throw new Error("host down");
      return "marked" as const;
    }),
  } as unknown as CodeReviewHost;
  const deps = { db, hosts: { github: host } };
  const markedReadyAt = async () =>
    (await db.codingRun.findUniqueOrThrow({ where: { runId: id("root") }, select: { markedReadyAt: true } }))
      .markedReadyAt;

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    for (const a of [builder, reviewer, lead, subBuilder, stranger, otherLead]) {
      await db.agent.create({ data: { id: a, name: a, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner } });
    }
    await db.agentRepository.create({
      data: {
        agentId: builder,
        provider: "github",
        repository,
        name: `github:${repository}`,
        access: "write",
        markReadyWhenPassing: true,
        authorizedVia: "host_permission",
      },
    });
    await db.agentRepository.create({
      data: {
        agentId: reviewer,
        provider: "github",
        repository,
        name: `github:${repository}`,
        access: "write",
        triggers: ["pull_request"],
        checkName: `wardby review ${s8}`,
        authorizedVia: "host_permission",
      },
    });
    // The lead (native, triggered by mentions) is opted in; the coding builder it delegates
    // to has no repository link at all. The stranger has the same opted-in, authorized link
    // but starts no run tree here, so it must never count for another agent's pull request.
    for (const a of [lead, stranger]) {
      await db.agentRepository.create({
        data: {
          agentId: a,
          provider: "github",
          repository,
          name: `github:${repository}`,
          access: "write",
          triggers: ["mention", "review_fix"],
          markReadyWhenPassing: true,
          authorizedVia: "host_permission",
        },
      });
    }
    const codingRun = async (runId: string, prNumber: number) =>
      db.codingRun.create({
        data: {
          runId,
          task: "t",
          repository,
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          provider: "codex",
          model: "m",
          timeoutSec: 900,
          protectedPaths: [],
          budgetReservedUsd: 1,
          result: {
            outcome: "pull_request_opened",
            repository,
            pullRequestNumber: prNumber,
            pullRequestUrl: `https://github.com/${repository}/pull/${prNumber}`,
          },
        },
      });
    await db.run.create({ data: { id: id("root"), agentId: builder, status: "succeeded" } });
    await codingRun(id("root"), 7);
    // PR 8: lead -> sub-builder. PR 9: other lead (no link here) -> sub-builder.
    await db.run.create({ data: { id: id("lead-run"), agentId: lead, status: "succeeded" } });
    await db.run.create({
      data: { id: id("sub-8"), agentId: subBuilder, status: "succeeded", parentRunId: id("lead-run") },
    });
    await codingRun(id("sub-8"), 8);
    await db.run.create({ data: { id: id("other-lead-run"), agentId: otherLead, status: "succeeded" } });
    await db.run.create({
      data: { id: id("sub-9"), agentId: subBuilder, status: "succeeded", parentRunId: id("other-lead-run") },
    });
    await codingRun(id("sub-9"), 9);
  });

  beforeEach(async () => {
    failMark = false;
    vi.mocked(host.markReadyForReview!).mockClear();
    await db.codingRun.update({ where: { runId: id("root") }, data: { markedReadyAt: null } });
  });

  afterAll(async () => {
    const agents = [builder, reviewer, lead, subBuilder, stranger, otherLead];
    await db.codingRun.deleteMany({ where: { runId: { in: [id("root"), id("sub-8"), id("sub-9")] } } });
    await db.run.deleteMany({ where: { agentId: { in: [subBuilder] } } });
    await db.run.deleteMany({ where: { agentId: { in: agents } } });
    await db.agentRepository.deleteMany({ where: { agentId: { in: agents } } });
    await db.agent.deleteMany({ where: { id: { in: agents } } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("two concurrent evaluations of one pull request mark it exactly once", async () => {
    const outcomes = await Promise.all([
      maybeMarkReady(deps, repository, 7, "github"),
      maybeMarkReady(deps, repository, 7, "github"),
    ]);
    expect(outcomes.sort()).toEqual(["marked", "skipped"]);
    expect(host.markReadyForReview).toHaveBeenCalledTimes(1);
    expect(await markedReadyAt()).toBeInstanceOf(Date);
  });

  it("after marking, a later evaluation of the same draft is skipped without touching the host", async () => {
    expect(await maybeMarkReady(deps, repository, 7, "github")).toBe("marked");
    vi.mocked(host.markReadyForReview!).mockClear();
    // A person moved it back to draft: the host still reports a draft, but marking is final.
    expect(await maybeMarkReady(deps, repository, 7, "github")).toBe("skipped");
    expect(host.markReadyForReview).not.toHaveBeenCalled();
  });

  it("a host failure releases the claim, so the next evaluation marks", async () => {
    failMark = true;
    expect(await maybeMarkReady(deps, repository, 7, "github")).toBe("failed");
    expect(await markedReadyAt()).toBeNull();
    failMark = false;
    expect(await maybeMarkReady(deps, repository, 7, "github")).toBe("marked");
    expect(await markedReadyAt()).toBeInstanceOf(Date);
  });

  it("marks a pull request a coding builder opened for an opted-in lead that delegated to it", async () => {
    expect(await maybeMarkReady(deps, repository, 8, "github")).toBe("marked");
    const row = await db.codingRun.findUniqueOrThrow({
      where: { runId: id("sub-8") },
      select: { markedReadyAt: true },
    });
    expect(row.markedReadyAt).toBeInstanceOf(Date);
  });

  it("does not mark for an opted-in agent outside the builder's run tree", async () => {
    expect(await maybeMarkReady(deps, repository, 9, "github")).toBe("not_ready");
    const row = await db.codingRun.findUniqueOrThrow({
      where: { runId: id("sub-9") },
      select: { markedReadyAt: true },
    });
    expect(row.markedReadyAt).toBeNull();
  });
});
