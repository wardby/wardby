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
  let otherActive = 0;

  beforeAll(async () => {
    otherActive = await db.codingRun.count({
      where: { jobBackend: { not: null }, run: { status: { in: ["pending", "running"] } } },
    });
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
    // One of our seeded runs holds a slot; leave room for exactly one more.
    const result = await drainCodingQueue({
      db,
      executor: recordingExecutor(started),
      maxConcurrent: otherActive + 2,
      queueTimeoutSec: 3600,
      now: () => now,
    });

    expect(result.timedOut).toBe(1);
    const expired = await db.run.findUniqueOrThrow({ where: { id: ids.expired } });
    expect(expired.status).toBe("failed");
    expect(expired.error).toBe(CODING_QUEUE_TIMEOUT_ERROR);
    expect((await db.codingRun.findUniqueOrThrow({ where: { runId: ids.expired } })).failureCategory).toBe(
      CODING_QUEUE_TIMEOUT_ERROR,
    );

    expect(started).toEqual([ids.oldest]);
    expect(result.started).toEqual([ids.oldest]);
  });

  it("starts nothing when every slot is taken", async () => {
    const started: string[] = [];
    const result = await drainCodingQueue({
      db,
      executor: recordingExecutor(started),
      maxConcurrent: otherActive + 1,
      queueTimeoutSec: 3600,
      now: () => now,
    });
    expect(started).toEqual([]);
    expect(result.started).toEqual([]);
  });
});
