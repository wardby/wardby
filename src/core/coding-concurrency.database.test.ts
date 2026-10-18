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
import { createPrismaClient } from "./db.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { PrismaContainerExecutionStore } from "../providers/executor/container.js";
import { CODING_QUEUE_TIMEOUT_ERROR, drainCodingQueue } from "./coding-queue.js";
import { reconcileOnce } from "./reconciler.js";
import { gatewayBusy, powerBlockers, proxyBusy } from "./power-idle.js";
import type { Prisma, PrismaClient } from "#prisma";

const db = createPrismaClient();
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
    status?: "pending" | "running" | "succeeded" | "failed" | "cancelled";
    finishedAt?: Date;
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
      ...(opts.finishedAt ? { finishedAt: opts.finishedAt } : {}),
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
    const dependencyCacheResult = { projects: [{ path: ".", result: "hit" as const, key: "abc", sizeBytes: 5 }] };
    await store.complete(runId, "succeeded", result, { dependencyCacheResult });
    await store.complete(runId, "succeeded", result);
    const terminal = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
    expect(terminal.status).toBe("succeeded");
    expect(terminal.codingRun?.result).toEqual(result);
    // The worker's dependency cache report, in its own column (get_run's dependencyCache).
    expect(terminal.codingRun?.dependencyCacheResult).toEqual(dependencyCacheResult);
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

  it("queues a claim whose transaction could not start in time (P2028) instead of failing it", async () => {
    const runId = id("tx-unavailable");
    await seed(runId);
    const unavailable = Object.assign(
      new Error("Transaction API error: Unable to start a transaction in the given time."),
      {
        code: "P2028",
      },
    );
    // Same database, but every interactive transaction fails to start, as under a burst of claims on the slot lock.
    const busy = new Proxy(db, {
      get: (target, prop) =>
        prop === "$transaction" ? () => Promise.reject(unavailable) : Reflect.get(target, prop, target),
    });

    const store = new PrismaContainerExecutionStore(busy, { maxConcurrent: 1_000 });
    await expect(store.claimProvisioning(runId, "claim-busy")).resolves.toBe("queued");
    const row = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(row.queuedAt).not.toBeNull();
    expect(row.jobBackend).toBeNull();
    expect((await db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("pending");

    await retire([runId]);
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

  describe("requeueAfterCapacityRefusal (the cluster refused the run's pod)", () => {
    const planned = (runId: string) => ({ backend: "kubernetes", id: `job-${runId}` });

    async function openSession(runId: string): Promise<void> {
      await db.codingProxySession.create({
        data: {
          id: `session-${runId}`,
          runId,
          capabilityHash: `cap-${runId}`,
          credentialRef: "env:OPENAI_API_KEY",
          allowedModels: ["gpt-5.6-luna"],
          deadlineAt: new Date(Date.now() + 3600_000),
          budgetUsd: 1,
        },
      });
    }

    /** One refused launch, the way the executor drives the store: claim, session, planned handle, refusal. */
    async function refuseOnce(store: PrismaContainerExecutionStore, runId: string, claimId: string): Promise<boolean> {
      await expect(store.claimProvisioning(runId, claimId)).resolves.toBe("claimed");
      await openSession(runId);
      await store.persistHandle(runId, claimId, planned(runId));
      return store.requeueAfterCapacityRefusal(runId, { claimId, planned: planned(runId) });
    }

    it("puts the run back in the queue at its dispatch time, only for the attempt that owns it", async () => {
      const dispatchedAt = new Date(Date.now() - 10 * 60_000);
      const runId = id("requeue");
      await seed(runId, { startedAt: dispatchedAt });
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.claimProvisioning(runId, "claim-1")).resolves.toBe("claimed");
      await openSession(runId);
      await store.persistHandle(runId, "claim-1", planned(runId));
      const owned = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
      expect(owned.status).toBe("running");

      // Another attempt's claim or handle: nothing changes.
      await expect(store.requeueAfterCapacityRefusal(runId, { claimId: "claim-other" })).resolves.toBe(false);
      await expect(
        store.requeueAfterCapacityRefusal(runId, {
          claimId: "claim-other",
          planned: { backend: "kubernetes", id: "x" },
        }),
      ).resolves.toBe(false);
      await expect(db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } })).resolves.toEqual(
        owned,
      );

      await expect(
        store.requeueAfterCapacityRefusal(runId, { claimId: "claim-1", planned: planned(runId) }),
      ).resolves.toBe(true);
      const row = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
      expect(row.status).toBe("pending");
      expect(row.heartbeatAt).toBeNull();
      expect(row.codingRun).toMatchObject({ jobBackend: null, jobHandle: null });
      // Its place and its queue clock are where it first waited (dispatch), not the refusal.
      expect(row.codingRun?.queuedAt).toEqual(row.startedAt);
      expect(row.startedAt).toEqual(dispatchedAt);
      // Nothing ran, so the session is gone and the next attempt makes a fresh one.
      expect(await db.codingProxySession.count({ where: { runId } })).toBe(0);
      await expect(store.load(runId)).resolves.toMatchObject({
        status: "pending",
        jobHandle: null,
        provisioningClaim: null,
        proxySessionId: null,
      });
      // Waiting, not orphaned: the reconciler leaves it to the coding queue.
      await reconcileOnce(db, new Date());
      expect((await db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("pending");

      // A second call no longer owns anything.
      await expect(
        store.requeueAfterCapacityRefusal(runId, { claimId: "claim-1", planned: planned(runId) }),
      ).resolves.toBe(false);
      await retire([runId]);
    });

    it("releases a bare provisioning claim (a backend without a planned handle)", async () => {
      const runId = id("requeue-claim");
      await seed(runId);
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.claimProvisioning(runId, "claim-1")).resolves.toBe("claimed");
      await expect(store.requeueAfterCapacityRefusal(runId, { claimId: "claim-1" })).resolves.toBe(true);
      const row = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
      expect(row.status).toBe("pending");
      expect(row.codingRun).toMatchObject({ jobBackend: null, jobHandle: null, queuedAt: row.startedAt });
      await retire([runId]);
    });

    it("leaves a run that already ended alone", async () => {
      const runId = id("requeue-failed");
      await seed(runId);
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.claimProvisioning(runId, "claim-1")).resolves.toBe("claimed");
      await store.persistHandle(runId, "claim-1", planned(runId));
      await db.run.update({
        where: { id: runId },
        data: { status: "failed", error: "stopped", finishedAt: new Date() },
      });
      await expect(
        store.requeueAfterCapacityRefusal(runId, { claimId: "claim-1", planned: planned(runId) }),
      ).resolves.toBe(false);
      const row = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
      expect(row.status).toBe("failed");
      expect(row.codingRun).toMatchObject({ jobBackend: "kubernetes", jobHandle: `job-${runId}`, queuedAt: null });
    });

    it("never drops a session that has spend recorded: the run is left as it was", async () => {
      const runId = id("requeue-spent");
      await seed(runId);
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.claimProvisioning(runId, "claim-1")).resolves.toBe("claimed");
      await openSession(runId);
      await db.codingProxyRequest.create({
        data: {
          sessionId: `session-${runId}`,
          requestKey: "r1",
          requestFingerprint: "f1",
          model: "gpt-5.6-luna",
          reservationUsd: 0.01,
          pricingVersion: "test",
          pricingSnapshot: {},
        },
      });
      await store.persistHandle(runId, "claim-1", planned(runId));
      const before = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
      await expect(
        store.requeueAfterCapacityRefusal(runId, { claimId: "claim-1", planned: planned(runId) }),
      ).resolves.toBe(false);
      await expect(db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } })).resolves.toEqual(
        before,
      );
      expect(await db.codingProxyRequest.count({ where: { sessionId: `session-${runId}` } })).toBe(1);
      await retire([runId]);
    });

    it("a run refused again and again still times out in the queue, counted from its dispatch", async () => {
      const queueTimeoutSec = 3600;
      const dispatchedAt = new Date(Date.now() - 5 * 60_000);
      const runId = id("requeue-timeout");
      await seed(runId, { startedAt: dispatchedAt });
      const store = new PrismaContainerExecutionStore(db);
      const drain = async (now: Date) =>
        drainCodingQueue({
          db,
          executor: recordingExecutor([]),
          // No free slot: this drain only applies the timeout.
          maxConcurrent: await activeSlotCount(),
          queueTimeoutSec,
          now: () => now,
        });

      for (const attempt of [1, 2, 3]) {
        await expect(refuseOnce(store, runId, `claim-${attempt}`)).resolves.toBe(true);
        await drain(new Date(dispatchedAt.getTime() + queueTimeoutSec * 1000 - 1000));
        expect((await db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("pending");
      }

      await drain(new Date(dispatchedAt.getTime() + queueTimeoutSec * 1000 + 1000));
      const row = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
      expect(row.status).toBe("failed");
      expect(row.error).toBe(CODING_QUEUE_TIMEOUT_ERROR);
      expect(row.codingRun?.failureCategory).toBe(CODING_QUEUE_TIMEOUT_ERROR);
    });
  });

  // Low-power idle rules. busy=true assertions run against the whole
  // database. A busy=false assertion cannot: many other database test files
  // create coding runs that sit in the default "pending" status (this file
  // owns only the slot/queue state, not every pending coding run), so the
  // false cases go through onlyRuns(), which runs proxyBusy's own where
  // clause in PostgreSQL restricted to the test's own rows.
  describe("low-power idle rules", () => {
    const since = () => new Date(Date.now() - 30 * 60_000);
    const minutes = (n: number) => n * 60_000;
    const ago = (n: number) => new Date(Date.now() - minutes(n));

    /** A view of the database whose coding-run counts and lists see only `runIds`. */
    function onlyRuns(runIds: string[]): PrismaClient {
      const scoped = <W>(where: W | undefined) => ({ AND: [where ?? {}, { runId: { in: runIds } }] });
      return {
        codingRun: {
          count: (args: Prisma.CodingRunCountArgs) => db.codingRun.count({ ...args, where: scoped(args.where) }),
          findMany: (args: Prisma.CodingRunFindManyArgs) =>
            db.codingRun.findMany({ ...args, where: scoped(args.where) }),
        },
      } as unknown as PrismaClient;
    }

    it("an active coding run keeps the proxy busy", async () => {
      await seed(id("lp-active"), { status: "running" });
      expect(await proxyBusy(db, since())).toBe(true);
      await retire([id("lp-active")]);
    });

    it("a queued coding run keeps the proxy busy", async () => {
      await seed(id("lp-queued"), { status: "pending", queuedAt: new Date() });
      expect(await proxyBusy(db, since())).toBe(true);
      await retire([id("lp-queued")]);
    });

    it("a coding run finished inside the window keeps the proxy busy; outside it does not", async () => {
      const old = id("lp-old");
      const recent = id("lp-recent");
      await seed(old, { status: "succeeded", finishedAt: ago(40) });
      expect(await proxyBusy(onlyRuns([old, recent]), since())).toBe(false);
      await seed(recent, { status: "succeeded", finishedAt: ago(10) });
      expect(await proxyBusy(onlyRuns([old, recent]), since())).toBe(true);
      expect(await proxyBusy(db, since())).toBe(true);
    });

    it("an active sandbox native run or active gateway session keeps the gateway busy", async () => {
      // Busy-only assertions: other database test files create sandbox runs and
      // gateway sessions in parallel (the false cases live in power-idle.test.ts).
      const sandboxRun = id("lp-sandbox");
      await db.run.create({
        data: { id: sandboxRun, agentId, status: "running", nativeExecutionMode: "sandbox" },
      });
      expect(await gatewayBusy(db, since())).toBe(true);
      await db.run.update({
        where: { id: sandboxRun },
        data: { status: "succeeded", finishedAt: new Date(Date.now() - minutes(40)) },
      });

      const sessionRun = id("lp-session");
      await db.run.create({
        data: {
          id: sessionRun,
          agentId,
          status: "succeeded",
          finishedAt: new Date(Date.now() - minutes(40)),
          nativeExecutionMode: "control_plane",
        },
      });
      await db.nativeGatewaySession.create({
        data: {
          runId: sessionRun,
          capabilityHash: `cap-${sessionRun}`,
          status: "active",
          deadlineAt: new Date(Date.now() + minutes(15)),
          budgetUsd: 1,
          snapshot: {},
        },
      });
      expect(await gatewayBusy(db, since())).toBe(true);
      await db.nativeGatewaySession.update({ where: { runId: sessionRun }, data: { status: "finished" } });
    });

    it("powerBlockers(proxy) lists running and queued coding runs, not a run finished a minute ago", async () => {
      const running = id("lp-block-running");
      const queued = id("lp-block-queued");
      const finished = id("lp-block-finished");
      await seed(running, { status: "running" });
      await seed(queued, { status: "pending", queuedAt: new Date() });
      await seed(finished, { status: "succeeded", finishedAt: ago(1) });
      expect(await powerBlockers(db, "proxy")).toEqual(expect.arrayContaining([running, queued]));
      expect(await powerBlockers(onlyRuns([running, queued, finished]), "proxy")).toEqual([running, queued].sort());
      await retire([running, queued]);
      expect(await powerBlockers(onlyRuns([running, queued, finished]), "proxy")).toEqual([]);
    });

    it("powerBlockers(gateway) lists a running sandbox run and the run of an active gateway session", async () => {
      // Inclusion-only assertions: other database test files create sandbox runs and sessions in parallel.
      const sandboxRun = id("lp-block-sandbox");
      const sessionRun = id("lp-block-session");
      await db.run.create({ data: { id: sandboxRun, agentId, status: "running", nativeExecutionMode: "sandbox" } });
      await db.run.create({
        data: {
          id: sessionRun,
          agentId,
          status: "succeeded",
          finishedAt: ago(1),
          nativeExecutionMode: "control_plane",
        },
      });
      await db.nativeGatewaySession.create({
        data: {
          runId: sessionRun,
          capabilityHash: `cap-${sessionRun}`,
          status: "active",
          deadlineAt: new Date(Date.now() + minutes(15)),
          budgetUsd: 1,
          snapshot: {},
        },
      });
      const blockers = await powerBlockers(db, "gateway");
      expect(blockers).toEqual(expect.arrayContaining([sandboxRun, sessionRun]));
      expect(new Set(blockers).size).toBe(blockers.length);
      expect(blockers).toEqual([...blockers].sort());
      await db.run.update({ where: { id: sandboxRun }, data: { status: "succeeded", finishedAt: new Date() } });
      await db.nativeGatewaySession.update({ where: { runId: sessionRun }, data: { status: "finished" } });
    });

    it("the proxy is idle with no active coding run and nothing in the window", async () => {
      const runIds = [id("lp-done-ok"), id("lp-done-failed"), id("lp-done-cancelled")];
      await seed(runIds[0], { status: "succeeded", finishedAt: ago(40) });
      await seed(runIds[1], { status: "failed", finishedAt: ago(45) });
      await seed(runIds[2], { status: "cancelled", finishedAt: ago(90) });
      expect(await proxyBusy(onlyRuns(runIds), since())).toBe(false);
      // The same rows count as soon as one of them is active again.
      await db.run.update({ where: { id: runIds[2] }, data: { status: "running", finishedAt: null } });
      expect(await proxyBusy(onlyRuns(runIds), since())).toBe(true);
      await retire(runIds);
    });
  });
});
