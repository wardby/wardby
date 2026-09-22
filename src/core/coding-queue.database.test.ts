import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { CODING_QUEUE_TIMEOUT_ERROR, drainCodingQueue } from "./coding-queue.js";

const db = new PrismaClient();
const suffix = randomUUID();
const principalId = `cq-principal-${suffix}`;
const agentId = `cq-agent-${suffix}`;
const ids = {
  active: `cq-active-${suffix}`,
  expired: `cq-expired-${suffix}`,
  oldest: `cq-oldest-${suffix}`,
  newer: `cq-newer-${suffix}`,
};
const all = Object.values(ids);

function recordingExecutor(started: string[]): Executor {
  return {
    async start(runId) {
      started.push(runId);
    },
    async stop() {},
  };
}

async function seed(id: string, opts: { status?: "pending" | "running"; queuedAt?: Date | null; jobBackend?: string }) {
  await db.run.create({ data: { id, agentId, executionManaged: true, status: opts.status ?? "pending" } });
  await db.codingRun.create({
    data: {
      runId: id,
      task: "Fix it.",
      repository: "openai/example",
      baseRef: "main",
      headRef: `wardby/run-${id}`,
      provider: "codex",
      model: "gpt-5.6-luna",
      timeoutSec: 900,
      allowedEgress: [],
      protectedPaths: ["CODEOWNERS"],
      budgetReservedUsd: 1,
      queuedAt: opts.queuedAt ?? null,
      jobBackend: opts.jobBackend ?? null,
      jobHandle: opts.jobBackend ? `handle-${id}` : null,
    },
  });
}

describe.skipIf(!process.env.DATABASE_URL)("drainCodingQueue (PostgreSQL)", () => {
  const now = new Date();

  // Re-measured immediately before each drainCodingQueue call, rather than
  // once in beforeAll, so a DB test file running in parallel that
  // creates/finishes its own active coding runs between beforeAll and this
  // test's turn can't skew maxConcurrent out from under us. By the time
  // this is called, ids.active (this file's own running/jobBackend-set
  // CodingRun) is already seeded and counted in the result.
  async function activeSlotCount(): Promise<number> {
    return db.codingRun.count({
      where: { jobBackend: { not: null }, run: { status: { in: ["pending", "running"] } } },
    });
  }

  beforeAll(async () => {
    await db.principal.create({ data: { id: principalId, subject: principalId } });
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "code safely",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        kind: "coding",
        ownerId: principalId,
      },
    });
    await seed(ids.active, { status: "running", jobBackend: "docker" });
    await seed(ids.expired, { queuedAt: new Date(now.getTime() - 2 * 3600_000) });
    await seed(ids.oldest, { queuedAt: new Date(now.getTime() - 60_000) });
    await seed(ids.newer, { queuedAt: new Date(now.getTime() - 30_000) });
  });

  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: { in: all } } });
    await db.run.deleteMany({ where: { id: { in: all } } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: principalId } });
    await db.$disconnect();
  });

  it("times out stale queued runs and starts the oldest into the free slots only", async () => {
    const started: string[] = [];
    // ids.active already counts toward activeSlotCount(); +1 leaves room
    // for exactly one more of this file's own queued runs to start,
    // regardless of how many *other* active coding runs exist right now.
    const active = await activeSlotCount();
    const result = await drainCodingQueue({
      db,
      executor: recordingExecutor(started),
      maxConcurrent: active + 1,
      queueTimeoutSec: 3600,
      now: () => now,
    });

    expect(result.timedOut).toBeGreaterThanOrEqual(1);
    const expired = await db.run.findUniqueOrThrow({ where: { id: ids.expired } });
    expect(expired.status).toBe("failed");
    expect(expired.error).toBe(CODING_QUEUE_TIMEOUT_ERROR);
    expect((await db.codingRun.findUniqueOrThrow({ where: { runId: ids.expired } })).failureCategory).toBe(
      CODING_QUEUE_TIMEOUT_ERROR,
    );

    expect(started).toContain(ids.oldest);
    expect(started).not.toContain(ids.newer);
    expect(result.started).toContain(ids.oldest);
    expect(result.started).not.toContain(ids.newer);
  });

  it("starts nothing when every slot is taken", async () => {
    const started: string[] = [];
    // No "+1" this time: every currently active slot (including
    // ids.active) is already accounted for by maxConcurrent, so free <= 0.
    const active = await activeSlotCount();
    const result = await drainCodingQueue({
      db,
      executor: recordingExecutor(started),
      maxConcurrent: active,
      queueTimeoutSec: 3600,
      now: () => now,
    });

    expect(started).not.toContain(ids.oldest);
    expect(started).not.toContain(ids.newer);
    expect(result.started).not.toContain(ids.oldest);
    expect(result.started).not.toContain(ids.newer);
    // ids.expired was already failed by the previous test; a second drain
    // must not re-process (or re-count) it.
    expect(result.timedOut).toBe(0);
    const expired = await db.run.findUniqueOrThrow({ where: { id: ids.expired } });
    expect(expired.status).toBe("failed");
    expect(expired.error).toBe(CODING_QUEUE_TIMEOUT_ERROR);
  });
});
