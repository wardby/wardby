/**
 * Every PostgreSQL test that depends on (or perturbs) the GLOBAL coding
 * concurrency state lives in this one file: the active-slot count, the
 * global oldest-queued ordering, and the reconciler's view of queued runs.
 * Vitest runs files in parallel but tests within a file sequentially, so
 * keeping them together is what stops them from racing each other. Each
 * test retires its own rows when done (see retire()) so the next one starts
 * from the same global baseline. Do not add tests that create active or
 * queued coding runs to any other database test file.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { PrismaContainerExecutionStore } from "../providers/executor/container.js";
import { CODING_QUEUE_TIMEOUT_ERROR, drainCodingQueue } from "./coding-queue.js";
import { reconcileOnce } from "./reconciler.js";

const db = new PrismaClient();
/** Every row this file creates starts with this, so beforeAll can clear leftovers of an aborted earlier run. */
const PREFIX = "ccq-";
const suffix = randomUUID();
const principalId = `${PREFIX}principal-${suffix}`;
const agentId = `${PREFIX}agent-${suffix}`;
const id = (name: string) => `${PREFIX}${name}-${suffix}`;

async function cleanupByPrefix(): Promise<void> {
  await db.codingRun.deleteMany({ where: { runId: { startsWith: PREFIX } } });
  await db.run.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await db.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await db.principal.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

async function seed(
  runId: string,
  opts: {
    status?: "pending" | "running";
    queuedAt?: Date | null;
    jobBackend?: string;
    startedAt?: Date;
    workerImage?: string;
  } = {},
): Promise<void> {
  await db.run.create({
    data: {
      id: runId,
      agentId,
      executionManaged: true,
      status: opts.status ?? "pending",
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
    },
  });
  await db.codingRun.create({
    data: {
      runId,
      task: "Fix it.",
      repository: "openai/example",
      baseRef: "main",
      headRef: `wardby/run-${runId}`,
      provider: "codex",
      model: "gpt-5.6-luna",
      timeoutSec: 900,
      allowedEgress: [],
      protectedPaths: ["CODEOWNERS"],
      budgetReservedUsd: 1,
      queuedAt: opts.queuedAt ?? null,
      jobBackend: opts.jobBackend ?? null,
      jobHandle: opts.jobBackend ? `handle-${runId}` : null,
      workerImage: opts.workerImage ?? null,
    },
  });
}

/** Moves this test's runs out of pending/running so they stop holding slots or queue positions. */
async function retire(runIds: string[]): Promise<void> {
  await db.run.updateMany({
    where: { id: { in: runIds }, status: { in: ["pending", "running"] } },
    data: { status: "cancelled", finishedAt: new Date() },
  });
}

/** Coding runs holding a slot right now, across the whole database (the same rule claimProvisioning uses). */
async function activeSlotCount(): Promise<number> {
  return db.codingRun.count({
    where: { jobBackend: { not: null }, run: { status: { in: ["pending", "running"] } } },
  });
}

/** Coding runs waiting in the queue right now, across the whole database. */
async function queuedCount(): Promise<number> {
  return db.codingRun.count({ where: { queuedAt: { not: null }, jobBackend: null, run: { status: "pending" } } });
}

function recordingExecutor(started: string[]): Executor {
  return {
    async start(runId) {
      started.push(runId);
    },
    async stop() {},
  };
}

describe.skipIf(!process.env.DATABASE_URL)("coding concurrency (PostgreSQL, global slot/queue state)", () => {
  beforeAll(async () => {
    await cleanupByPrefix();
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
  });

  afterAll(async () => {
    await cleanupByPrefix();
    await db.$disconnect();
  });

  it("admits one provisioning owner and atomically persists its handle and terminal result", async () => {
    const runId = id("owner");
    const workerImage = `sha256:realdbtest${"0".repeat(50)}`;
    await seed(runId, { workerImage });

    const store = new PrismaContainerExecutionStore(db);
    await expect(store.load(runId)).resolves.toMatchObject({ workerImage });
    const [first, second] = await Promise.all([
      store.claimProvisioning(runId, "claim-a"),
      store.claimProvisioning(runId, "claim-b"),
    ]);
    expect([first, second].filter((o) => o === "claimed")).toHaveLength(1);
    const winner = first === "claimed" ? "claim-a" : "claim-b";
    await expect(
      store.persistHandle(runId, winner === "claim-a" ? "claim-b" : "claim-a", { backend: "docker", id: "job-1" }),
    ).rejects.toThrow("coding_job_handle_conflict");
    await store.persistHandle(runId, winner, { backend: "docker", id: "job-1" });
    await expect(store.load(runId)).resolves.toMatchObject({
      status: "running",
      provisioningClaim: null,
      jobHandle: { backend: "docker", id: "job-1" },
    });

    const result = {
      schemaVersion: 1 as const,
      outcome: "no_changes" as const,
      repository: "openai/example",
      baseRef: "main",
      summary: "Nothing to change.",
      tests: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    };
    await store.complete(runId, "succeeded", result);
    await store.complete(runId, "succeeded", result);
    const terminal = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
    expect(terminal.status).toBe("succeeded");
    expect(terminal.codingRun?.result).toEqual(result);
  });

  it("admits exactly maxConcurrent of many racing claims and queues the rest", async () => {
    const runIds = [0, 1, 2, 3, 4].map((n) => id(`cap-${n}`));
    for (const runId of runIds) await seed(runId);
    // A fresh claim yields to every queued run already waiting, so both
    // count against the cap from this test's point of view.
    const maxConcurrent = (await activeSlotCount()) + (await queuedCount()) + 2;

    const store = new PrismaContainerExecutionStore(db, { maxConcurrent });
    const outcomes = await Promise.all(runIds.map((runId) => store.claimProvisioning(runId, `claim-${runId}`)));

    expect(outcomes.filter((o) => o === "claimed")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "queued")).toHaveLength(3);
    const rows = await db.codingRun.findMany({ where: { runId: { in: runIds } }, include: { run: true } });
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      if (row.jobBackend) {
        expect(row.queuedAt).toBeNull();
        expect(row.run.status).toBe("running");
      } else {
        expect(row.queuedAt).toBeInstanceOf(Date);
        expect(row.run.status).toBe("pending");
      }
    }
    await retire(runIds);
  });

  it("drainCodingQueue times out stale queued runs and starts the oldest into the free slots only", async () => {
    const now = new Date();
    const ids = { active: id("drain-active"), expired: id("drain-expired"), oldest: id("drain-oldest") };
    const newer = id("drain-newer");
    await seed(ids.active, { status: "running", jobBackend: "docker" });
    await seed(ids.expired, { queuedAt: new Date(now.getTime() - 2 * 3600_000) });
    await seed(ids.oldest, { queuedAt: new Date(now.getTime() - 60_000) });
    await seed(newer, { queuedAt: new Date(now.getTime() - 30_000) });

    const started: string[] = [];
    // +1 leaves room for exactly one queued run to start.
    const result = await drainCodingQueue({
      db,
      executor: recordingExecutor(started),
      maxConcurrent: (await activeSlotCount()) + 1,
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
    expect(started).toEqual([ids.oldest]);
    expect(result.started).toEqual([ids.oldest]);

    // With every slot taken, a second drain starts nothing and does not
    // re-process the run it already timed out.
    const startedAgain: string[] = [];
    const second = await drainCodingQueue({
      db,
      executor: recordingExecutor(startedAgain),
      maxConcurrent: await activeSlotCount(),
      queueTimeoutSec: 3600,
      now: () => now,
    });
    expect(startedAgain).toEqual([]);
    expect(second.started).toEqual([]);
    expect(second.timedOut).toBe(0);
    expect((await db.run.findUniqueOrThrow({ where: { id: ids.expired } })).error).toBe(CODING_QUEUE_TIMEOUT_ERROR);

    await retire([...Object.values(ids), newer]);
  });

  it("a new claim yields a freed slot to an older queued run (oldest first)", async () => {
    const holder = id("fifo-holder");
    const older = id("fifo-older");
    const fresh = id("fifo-fresh");
    // Older than anything else could be queued, so it is first in line globally.
    await seed(older, { queuedAt: new Date("2000-01-01T00:00:00Z") });
    await seed(holder, { status: "running", jobBackend: "docker" });
    await seed(fresh);
    // Cap full with the holder; then its slot frees without a drain having run.
    const maxConcurrent = await activeSlotCount();
    await db.run.update({ where: { id: holder }, data: { status: "succeeded", finishedAt: new Date() } });

    const store = new PrismaContainerExecutionStore(db, { maxConcurrent });
    await expect(store.claimProvisioning(fresh, "claim-fresh")).resolves.toBe("queued");
    expect((await db.codingRun.findUniqueOrThrow({ where: { runId: fresh } })).queuedAt).toBeInstanceOf(Date);
    await expect(store.claimProvisioning(older, "claim-older")).resolves.toBe("claimed");
    expect((await db.run.findUniqueOrThrow({ where: { id: older } })).status).toBe("running");
    // The slot is taken again, so the fresh run keeps waiting.
    await expect(store.claimProvisioning(fresh, "claim-fresh-2")).resolves.toBe("queued");

    await retire([holder, older, fresh]);
  });

  it("breaks a queuedAt tie by runId, in both claimProvisioning and drainCodingQueue", async () => {
    const tiedAt = new Date("2000-01-01T00:00:00Z");
    const first = id("tie-a");
    const second = id("tie-b");
    await seed(second, { queuedAt: tiedAt });
    await seed(first, { queuedAt: tiedAt });
    const maxConcurrent = (await activeSlotCount()) + 1;

    const started: string[] = [];
    const drained = await drainCodingQueue({
      db,
      executor: recordingExecutor(started),
      maxConcurrent,
      queueTimeoutSec: 365 * 24 * 3600 * 100,
    });
    expect(drained.started).toEqual([first]);

    const store = new PrismaContainerExecutionStore(db, { maxConcurrent });
    await expect(store.claimProvisioning(second, "claim-b")).resolves.toBe("queued");
    await expect(store.claimProvisioning(first, "claim-a")).resolves.toBe("claimed");

    await retire([first, second]);
  });

  it("the reconciler leaves a queued pending coding run alone but still reaps an unqueued one", async () => {
    const longAgo = new Date(Date.now() - 10 * 60_000);
    const queuedRun = id("recon-queued");
    const orphanRun = id("recon-orphan");
    await seed(queuedRun, { queuedAt: longAgo, startedAt: longAgo });
    await seed(orphanRun, { startedAt: longAgo });

    await reconcileOnce(db, new Date());

    expect((await db.run.findUniqueOrThrow({ where: { id: queuedRun } })).status).toBe("pending");
    expect((await db.run.findUniqueOrThrow({ where: { id: orphanRun } })).status).toBe("lost");
    await retire([queuedRun, orphanRun]);
  });
});
