/**
 * Whether the last push to a pull request stopped at its budget, for a writable extra
 * repository's pull request (#537), against real PostgreSQL: the extra's result is read from each
 * run's row of that name, never from the run's own (default repository's) result. Skipped without
 * DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunStatus } from "#prisma";
import { lastPusher, lastPushStoppedAtBudget } from "./budget-stopped-head.js";
import { createPrismaClient } from "./db.js";

describe.skipIf(!process.env.DATABASE_URL)("lastPushStoppedAtBudget for an extra repository (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const id = (name: string) => `bsh-${name}-${suffix}`;
  const owner = id("owner");
  const agentId = id("agent");
  const FORK = "your-org/your-fork";
  const TOOLS = "your-org/tools";
  let minute = 0;

  const result = (outcome: string, repository: string, number?: number, sha = "a") => ({
    schemaVersion: 1,
    outcome,
    repository,
    baseRef: "main",
    ...(number !== undefined
      ? {
          headRef: "wardby/run-x",
          commitSha: sha.repeat(40),
          pullRequestUrl: `https://github.com/${repository}/pull/${number}`,
          pullRequestNumber: number,
        }
      : {}),
    summary: "Did the work.",
    tests: [],
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  });

  /** A coding run with its `tools` row (`toolsResult` when that repository published). */
  async function codingRun(
    runId: string,
    input: { result: object; toolsResult?: object & { pullRequestNumber?: number }; status: RunStatus; root?: string },
  ): Promise<void> {
    minute += 1;
    const at = new Date(Date.UTC(2026, 10, 12, 12, minute));
    await db.run.create({ data: { id: runId, agentId, status: input.status, startedAt: at } });
    await db.codingRun.create({
      data: {
        runId,
        task: "t",
        repository: FORK,
        baseRef: "main",
        headRef: `wardby/run-${input.root ?? runId}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        result: input.result,
        createdAt: at,
        ...(input.root ? { rootCodingRunId: input.root } : {}),
      },
    });
    await db.codingRunRepository.create({
      data: {
        runId,
        position: 1,
        name: "tools",
        access: "write",
        provider: "github",
        repository: TOOLS,
        baseRef: "main",
        headRef: `wardby/run-${input.root ?? runId}`,
        createdAt: at,
        ...(input.toolsResult
          ? { result: input.toolsResult, pullRequestNumber: input.toolsResult.pullRequestNumber ?? null }
          : {}),
      },
    });
  }

  const rootOf = (runId: string) =>
    db.codingRun.findUniqueOrThrow({
      where: { runId },
      select: { runId: true, result: true, run: { select: { status: true } } },
    });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 10, ownerId: owner },
    });
    // root: default PR 7 and tools PR 3, finished. Its continuation pushed tools PR 3 and stopped at its budget.
    await codingRun(id("root"), {
      result: result("pull_request_opened", FORK, 7),
      toolsResult: result("pull_request_opened", TOOLS, 3),
      status: "succeeded",
    });
    await codingRun(id("cont"), {
      result: result("no_changes", FORK),
      toolsResult: result("pull_request_updated", TOOLS, 3, "c"),
      status: "budget_exhausted",
      root: id("root"),
    });
    // twin: default PR 7, and its tools PR is also number 7; a budget-stopped continuation pushed only tools #7.
    await codingRun(id("twin"), { result: result("pull_request_opened", FORK, 7), status: "succeeded" });
    await codingRun(id("twinCont"), {
      result: result("no_changes", FORK),
      toolsResult: result("pull_request_opened", TOOLS, 7),
      status: "budget_exhausted",
      root: id("twin"),
    });
  });

  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.delete({ where: { id: agentId } });
    await db.principal.delete({ where: { id: owner } });
    await db.$disconnect();
  });

  it("is true for the extra's pull request a budget-stopped continuation pushed, false for the default's", async () => {
    const root = await rootOf(id("root"));
    expect(await lastPushStoppedAtBudget(db, root, 3, "tools")).toBe(true);
    expect(await lastPusher(db, root, 3, "tools")).toEqual({ status: "budget_exhausted", commitSha: "c".repeat(40) });
    expect(await lastPushStoppedAtBudget(db, root, 7)).toBe(false);
  });

  it("never matches an extra's pull request that shares the default's number", async () => {
    const root = await rootOf(id("twin"));
    expect(await lastPushStoppedAtBudget(db, root, 7)).toBe(false);
    expect(await lastPushStoppedAtBudget(db, root, 7, "tools")).toBe(true);
  });
});
