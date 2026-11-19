import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "./db.js";
import { reconcileOnce } from "./reconciler.js";
import { drainRunFollowUps, enqueueRunFollowUp, type RunFollowUpHandlers } from "./run-follow-ups.js";
import { HEARTBEAT_TIMEOUT_MS } from "./timing.js";

// The outbox's guarantees (a row committed with the status, SKIP LOCKED claims, backoff on the
// database's clock) are Postgres semantics, so this runs against a real local Postgres and is
// skipped without DATABASE_URL.
describe.skipIf(!process.env.DATABASE_URL)("run follow-ups (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const agentId = `follow-up-agent-${suffix}`;
  const runIds: string[] = [];
  const kind = (name: string) => `${name}-${suffix}`;

  async function newRun(): Promise<string> {
    const id = `follow-up-run-${randomUUID()}`;
    await db.run.create({ data: { id, agentId } });
    runIds.push(id);
    return id;
  }
  const rowFor = (runId: string, k: string) =>
    db.runFollowUp.findUniqueOrThrow({ where: { runId_kind: { runId, kind: k } } });
  /** Moves a row's next attempt into the past, as if its backoff or claim had run out. */
  const makeDue = (runId: string, k: string) =>
    db.$executeRaw`UPDATE "RunFollowUp" SET "nextAttemptAt" = CURRENT_TIMESTAMP - interval '1 minute' WHERE "runId" = ${runId} AND "kind" = ${k}`;

  beforeAll(async () => {
    await db.agent.create({ data: { id: agentId, name: agentId, systemPrompt: "x", model: "m", budgetUsd: 1 } });
  });

  afterAll(async () => {
    await db.run.deleteMany({ where: { id: { in: runIds } } }); // the follow-ups cascade
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  it("queues a lost run's chores in the reconciler's own transaction, once", async () => {
    const id = await newRun();
    const stale = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS - 60_000);
    await db.run.update({
      where: { id },
      data: { status: "running", executionManaged: true, startedAt: stale, heartbeatAt: stale },
    });

    // Not the count it returns: it sweeps the whole database, which other test files share.
    await reconcileOnce(db, new Date(), HEARTBEAT_TIMEOUT_MS);
    await reconcileOnce(db, new Date(), HEARTBEAT_TIMEOUT_MS);

    expect((await db.run.findUniqueOrThrow({ where: { id } })).status).toBe("lost");
    const rows = await db.runFollowUp.findMany({ where: { runId: id }, orderBy: { kind: "asc" } });
    expect(rows.map((row) => row.kind)).toEqual(["run_finished_events", "self_defect", "stop_children"]);
    expect(rows.every((row) => row.doneAt === null && JSON.stringify(row.payload) === "{}")).toBe(true);
  });

  it("commits the follow-up with the status, and loses both when the transaction rolls back", async () => {
    const committed = await newRun();
    await db.$transaction(async (tx) => {
      await tx.run.update({ where: { id: committed }, data: { status: "failed" } });
      await enqueueRunFollowUp(tx, { runId: committed, kind: kind("commit"), payload: { childRunId: "c1" } });
    });
    expect(await rowFor(committed, kind("commit"))).toMatchObject({
      payload: { childRunId: "c1" },
      attempts: 0,
      doneAt: null,
    });

    const rolledBack = await newRun();
    await expect(
      db.$transaction(async (tx) => {
        await tx.run.update({ where: { id: rolledBack }, data: { status: "failed" } });
        await enqueueRunFollowUp(tx, { runId: rolledBack, kind: kind("rollback") });
        throw new Error("the status write failed afterwards");
      }),
    ).rejects.toThrow();
    expect(await db.runFollowUp.count({ where: { runId: rolledBack } })).toBe(0);
    expect((await db.run.findUniqueOrThrow({ where: { id: rolledBack } })).status).not.toBe("failed");
  });

  it("queues one follow-up of a kind per run, however often it is enqueued", async () => {
    const runId = await newRun();
    await enqueueRunFollowUp(db, { runId, kind: kind("once"), payload: { n: 1 } });
    await enqueueRunFollowUp(db, { runId, kind: kind("once"), payload: { n: 2 } });
    expect(await db.runFollowUp.count({ where: { runId, kind: kind("once") } })).toBe(1);
    expect((await rowFor(runId, kind("once"))).payload).toEqual({ n: 1 });
  });

  it("runs a follow-up on the next sweep after the process died following the status commit", async () => {
    const runId = await newRun();
    // The process commits the status and the follow-up, then dies before doing the chore.
    await db.$transaction(async (tx) => {
      await tx.run.update({ where: { id: runId }, data: { status: "failed" } });
      await enqueueRunFollowUp(tx, { runId, kind: kind("after-crash"), payload: { childRunId: "c1" } });
    });

    // A later leader sweeps.
    const handler = vi.fn(async () => undefined);
    const handlers: RunFollowUpHandlers = { [kind("after-crash")]: handler };
    await drainRunFollowUps({ db, handlers });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ runId, payload: { childRunId: "c1" }, attempt: 1 }));
    expect((await rowFor(runId, kind("after-crash"))).doneAt).not.toBeNull();

    await drainRunFollowUps({ db, handlers });
    expect(handler).toHaveBeenCalledTimes(1); // a done row does not run again
  });

  it("never runs the same follow-up twice when two replicas sweep at once", async () => {
    const k = kind("race");
    const runs = await Promise.all(Array.from({ length: 6 }, newRun));
    await Promise.all(runs.map((runId) => enqueueRunFollowUp(db, { runId, kind: k })));
    const ran: string[] = [];
    const handlers: RunFollowUpHandlers = {
      [k]: async ({ runId }) => {
        ran.push(runId);
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    };

    await Promise.all([drainRunFollowUps({ db, handlers }), drainRunFollowUps({ db, handlers })]);

    expect([...ran].sort()).toEqual([...runs].sort()); // each exactly once
  });

  it("keeps other replicas off a row while its handler is running", async () => {
    const runId = await newRun();
    const k = kind("claimed");
    await enqueueRunFollowUp(db, { runId, kind: k });
    let release!: () => void;
    const started = vi.fn();
    const handlers: RunFollowUpHandlers = {
      [k]: () => {
        started();
        return new Promise<void>((resolve) => (release = resolve));
      },
    };

    const first = drainRunFollowUps({ db, handlers });
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    await drainRunFollowUps({ db, handlers }); // another replica, mid-handler
    expect(started).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect((await rowFor(runId, k)).doneAt).not.toBeNull();
  });

  it("backs a failing handler off, records only its error name, and never blocks the other rows", async () => {
    const failing = await newRun();
    const fine = await newRun();
    const kFail = kind("fails");
    const kFine = kind("fine");
    await enqueueRunFollowUp(db, { runId: failing, kind: kFail });
    await enqueueRunFollowUp(db, { runId: fine, kind: kFine });
    const failingHandler = vi.fn(async () => {
      throw new TypeError("token=sk-live-abc123");
    });
    const fineHandler = vi.fn(async () => undefined);
    const handlers: RunFollowUpHandlers = { [kFail]: failingHandler, [kFine]: fineHandler };
    const observer = { runFollowUpResult: vi.fn(), runFollowUpBacklog: vi.fn() };

    const result = await drainRunFollowUps({ db, handlers, observer });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect((await rowFor(fine, kFine)).doneAt).not.toBeNull();
    const row = await rowFor(failing, kFail);
    expect(row).toMatchObject({ attempts: 1, doneAt: null, lastError: "TypeError" });
    expect(JSON.stringify(row)).not.toContain("sk-live");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 1_000); // backed off, not retried at once
    expect(observer.runFollowUpResult).toHaveBeenCalledWith("failed");
    expect(observer.runFollowUpResult).toHaveBeenCalledWith("done");
    expect(observer.runFollowUpBacklog).toHaveBeenCalledWith(
      expect.objectContaining({ pending: expect.any(Number), oldestAgeSeconds: expect.any(Number) }),
    );

    await drainRunFollowUps({ db, handlers });
    expect(failingHandler).toHaveBeenCalledTimes(1); // not due yet

    await makeDue(failing, kFail);
    await drainRunFollowUps({ db, handlers });
    expect(failingHandler).toHaveBeenCalledTimes(2);
    expect(failingHandler).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 2 }));
    expect((await rowFor(failing, kFail)).attempts).toBe(2);
  });

  it("backs a row with no registered handler off instead of dropping it", async () => {
    const runId = await newRun();
    const k = kind("unknown");
    await enqueueRunFollowUp(db, { runId, kind: k });
    await drainRunFollowUps({ db, handlers: {} });
    expect(await rowFor(runId, k)).toMatchObject({ doneAt: null, lastError: "UnknownFollowUpKind" });
  });

  it("abandons a handler that never settles, and still runs the rows after it", async () => {
    const hung = await newRun();
    const fine = await newRun();
    const kHung = kind("hung");
    const kAfter = kind("after-hung");
    await enqueueRunFollowUp(db, { runId: hung, kind: kHung });
    await enqueueRunFollowUp(db, { runId: fine, kind: kAfter });
    let signal: AbortSignal | undefined;
    const handlers: RunFollowUpHandlers = {
      [kHung]: (context) => {
        signal = context.signal;
        return new Promise<void>(() => undefined);
      },
      [kAfter]: async () => undefined,
    };

    await drainRunFollowUps({ db, handlers, handlerTimeoutMs: 50 });

    expect(signal?.aborted).toBe(true);
    expect(await rowFor(hung, kHung)).toMatchObject({ doneAt: null, lastError: "FollowUpTimeout" });
    expect((await rowFor(fine, kAfter)).doneAt).not.toBeNull();
  });
});
