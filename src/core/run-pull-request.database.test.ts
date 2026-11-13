/**
 * Which root run and which of its repositories a wardby pull request belongs to (#537 §4), against
 * real PostgreSQL: the default repository's PR on the root (or a continuation that first opened it),
 * an extra's PR on any row of the root family, and one follow-up in flight per root run. Skipped
 * without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunStatus } from "#prisma";
import { createPrismaClient } from "./db.js";
import { resolveRunPullRequest, rootFollowUpInFlight } from "./run-pull-request.js";

describe.skipIf(!process.env.DATABASE_URL)("resolveRunPullRequest and rootFollowUpInFlight (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const id = (name: string) => `runpr-${name}-${suffix}`;
  const owner = id("owner");
  const agentId = id("agent");
  const FORK = "your-org/your-fork";
  const TOOLS = "your-org/tools";
  const UPSTREAM = "upstream-org/upstream";
  let minute = 0;

  const result = (outcome: string, repository: string, number?: number) => ({
    schemaVersion: 1,
    outcome,
    repository,
    baseRef: "main",
    ...(number !== undefined
      ? {
          headRef: "wardby/run-x",
          commitSha: "a".repeat(40),
          pullRequestUrl: `https://github.com/${repository}/pull/${number}`,
          pullRequestNumber: number,
        }
      : {}),
    summary: "Did the work.",
    tests: [],
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  });

  async function codingRun(
    runId: string,
    input: { result: object | null; rootCodingRunId?: string; status?: RunStatus; agent?: string },
  ): Promise<void> {
    minute += 1;
    await db.run.create({
      data: {
        id: runId,
        agentId: input.agent ?? agentId,
        status: input.status ?? "succeeded",
        startedAt: new Date(Date.UTC(2026, 10, 12, 12, minute)),
      },
    });
    await db.codingRun.create({
      data: {
        runId,
        task: "t",
        repository: FORK,
        baseRef: "main",
        headRef: `wardby/run-${input.rootCodingRunId ?? runId}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        ...(input.result ? { result: input.result } : {}),
        createdAt: new Date(Date.UTC(2026, 10, 12, 12, minute)),
        ...(input.rootCodingRunId ? { rootCodingRunId: input.rootCodingRunId } : {}),
      },
    });
  }

  /** The set's rows: `base` (read, upstream) and `tools` (write, with `toolsPr` when it opened one). */
  async function rows(runId: string, toolsPr: number | null): Promise<void> {
    await db.codingRunRepository.createMany({
      data: [
        {
          runId,
          position: 0,
          name: "base",
          access: "read",
          provider: "github",
          repository: UPSTREAM,
          resolvedSha: "b".repeat(40),
        },
        {
          runId,
          position: 1,
          name: "tools",
          access: "write",
          provider: "github",
          repository: TOOLS,
          resolvedSha: "c".repeat(40),
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          pullRequestNumber: toolsPr,
          result: toolsPr === null ? undefined : result("pull_request_opened", TOOLS, toolsPr),
        },
      ],
    });
  }

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 10, ownerId: owner },
    });
    // root: default PR 7, tools PR 3; a finished continuation of it.
    await codingRun(id("root"), { result: result("pull_request_opened", FORK, 7) });
    await rows(id("root"), 3);
    await codingRun(id("cont"), { result: result("pull_request_updated", FORK, 7), rootCodingRunId: id("root") });
    await rows(id("cont"), 3);
    // toolsOnly: the default had no changes; only tools opened a PR (5).
    await codingRun(id("toolsOnly"), { result: result("no_changes", FORK) });
    await rows(id("toolsOnly"), 5);
    // retried: the default had no changes; a continuation opened the default PR 9.
    await codingRun(id("retried"), { result: result("no_changes", FORK) });
    await rows(id("retried"), 6);
    await codingRun(id("retriedCont"), {
      result: result("pull_request_opened", FORK, 9),
      rootCodingRunId: id("retried"),
    });
    await rows(id("retriedCont"), null);
  });

  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.delete({ where: { id: agentId } });
    await db.principal.delete({ where: { id: owner } });
    await db.$disconnect();
  });

  const resolve = (input: Partial<Parameters<typeof resolveRunPullRequest>[1]>) =>
    resolveRunPullRequest(db, { markerRunId: id("cont"), provider: "github", repository: TOOLS, ...input });

  it("resolves an extra's pull request, named by a continuation's marker, to the root and its row", async () => {
    expect(await resolve({ pullRequestNumber: 3 })).toEqual({
      ok: true,
      root: { runId: id("root"), baseRef: "main", headRef: `wardby/run-${id("root")}` },
      repo: { kind: "extra", name: "tools", repository: TOOLS, pullRequestNumber: 3 },
    });
  });

  it("resolves the default repository's pull request", async () => {
    expect(await resolve({ repository: FORK, pullRequestNumber: 7 })).toMatchObject({
      ok: true,
      root: { runId: id("root") },
      repo: { kind: "default", repository: FORK, pullRequestNumber: 7 },
    });
    // Repository names compare the way the host does.
    expect(await resolve({ repository: "Your-Org/Your-Fork", pullRequestNumber: 7 })).toMatchObject({ ok: true });
  });

  it("never targets a read repository", async () => {
    expect(await resolve({ repository: UPSTREAM })).toEqual({ ok: false, reason: "other_repository" });
  });

  it("refuses a number the repository's pull request does not have", async () => {
    expect(await resolve({ pullRequestNumber: 4 })).toEqual({ ok: false, reason: "no_pull_request" });
    expect(await resolve({ repository: FORK, pullRequestNumber: 8 })).toEqual({ ok: false, reason: "no_pull_request" });
  });

  it("matches on the provider too, never the repository alone", async () => {
    expect(await resolve({ provider: "bitbucket", pullRequestNumber: 3 })).toEqual({
      ok: false,
      reason: "other_repository",
    });
    expect(await resolve({ provider: "bitbucket", repository: FORK, pullRequestNumber: 7 })).toEqual({
      ok: false,
      reason: "other_repository",
    });
  });

  it("refuses an unknown marker", async () => {
    expect(await resolve({ markerRunId: id("nope") })).toEqual({ ok: false, reason: "unknown_run" });
  });

  it("resolves an extra's pull request on a root whose default repository opened none", async () => {
    expect(await resolve({ markerRunId: id("toolsOnly"), pullRequestNumber: 5 })).toMatchObject({
      ok: true,
      root: { runId: id("toolsOnly") },
      repo: { kind: "extra", name: "tools", pullRequestNumber: 5 },
    });
    expect(await resolve({ markerRunId: id("toolsOnly"), repository: FORK })).toEqual({
      ok: false,
      reason: "no_pull_request",
    });
  });

  it("finds a default pull request a continuation first opened (newestDefaultPullRequest)", async () => {
    for (const markerRunId of [id("retried"), id("retriedCont")]) {
      expect(await resolve({ markerRunId, repository: FORK, pullRequestNumber: 9 })).toEqual({
        ok: true,
        root: { runId: id("retried"), baseRef: "main", headRef: `wardby/run-${id("retried")}` },
        repo: { kind: "default", repository: FORK, pullRequestNumber: 9 },
      });
    }
  });

  it("fails closed against another owner, or a null one", async () => {
    expect(await resolve({ pullRequestNumber: 3, dispatchingOwnerId: "someone-else" })).toEqual({
      ok: false,
      reason: "other_owner",
    });
    expect(await resolve({ pullRequestNumber: 3, dispatchingOwnerId: null })).toEqual({
      ok: false,
      reason: "other_owner",
    });
    expect(await resolve({ pullRequestNumber: 3, dispatchingOwnerId: owner })).toMatchObject({ ok: true });
  });

  describe("rootFollowUpInFlight", () => {
    async function hostRun(name: string, status: RunStatus, provider: string, repository: string, number: number) {
      await db.run.create({ data: { id: id(name), agentId, status } });
      await db.runHostStatus.create({
        data: { runId: id(name), provider, repository, number, commentKind: "conversation" },
      });
    }

    it("is false with nothing running for the root's pull requests", async () => {
      expect(await rootFollowUpInFlight(db, id("root"))).toBe(false);
    });

    it("is true while a run for one of its pull requests is still going, on that provider only", async () => {
      await hostRun("otherHost", "running", "bitbucket", TOOLS, 3);
      await hostRun("doneTools", "succeeded", "github", TOOLS, 3);
      expect(await rootFollowUpInFlight(db, id("root"))).toBe(false);

      await hostRun("onTools", "running", "github", TOOLS, 3);
      expect(await rootFollowUpInFlight(db, id("root"))).toBe(true);
      await db.run.update({ where: { id: id("onTools") }, data: { status: "succeeded" } });
      expect(await rootFollowUpInFlight(db, id("root"))).toBe(false);

      await hostRun("onDefault", "pending", "github", FORK, 7);
      expect(await rootFollowUpInFlight(db, id("root"))).toBe(true);
      await db.run.update({ where: { id: id("onDefault") }, data: { status: "cancelled" } });
    });

    it("counts a default pull request a continuation opened", async () => {
      expect(await rootFollowUpInFlight(db, id("retried"))).toBe(false);
      await hostRun("onRetried", "running", "github", FORK, 9);
      expect(await rootFollowUpInFlight(db, id("retried"))).toBe(true);
      await db.run.update({ where: { id: id("onRetried") }, data: { status: "failed" } });
    });

    it("is true while a coding continuation of the root is not finished", async () => {
      await codingRun(id("cont2"), {
        result: null,
        rootCodingRunId: id("root"),
        status: "running",
      });
      expect(await rootFollowUpInFlight(db, id("root"))).toBe(true);
      expect(await rootFollowUpInFlight(db, id("toolsOnly"))).toBe(false);
      await db.run.update({ where: { id: id("cont2") }, data: { status: "succeeded" } });
      expect(await rootFollowUpInFlight(db, id("root"))).toBe(false);
    });
  });
});
