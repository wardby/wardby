import { describe, expect, it } from "vitest";
import { reconcileOnce, type ReconcilerDb } from "./reconciler.js";

interface FakeRun {
  id: string;
  status: string;
  heartbeatAt: Date | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}

function fakeDb(runs: FakeRun[]): ReconcilerDb {
  const byId = new Map(runs.map((r) => [r.id, r]));

  return {
    run: {
      updateMany: (async ({ where, data }: any) => {
        let count = 0;
        for (const run of byId.values()) {
          if (run.status !== where.status) continue;
          const stale =
            (run.heartbeatAt !== null && run.heartbeatAt < where.OR[0].heartbeatAt.lt) ||
            (run.heartbeatAt === null && run.startedAt < where.OR[1].startedAt.lt);
          if (!stale) continue;
          Object.assign(run, data);
          count += 1;
        }
        return { count };
      }) as any,
    },
  } as unknown as ReconcilerDb;
}

const HEARTBEAT_TIMEOUT_MS = 45_000;

describe("reconcileOnce", () => {
  it("marks a running run with a stale heartbeat as lost", async () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const runs: FakeRun[] = [
      {
        id: "r1",
        status: "running",
        heartbeatAt: new Date(now.getTime() - HEARTBEAT_TIMEOUT_MS - 1_000),
        startedAt: new Date(now.getTime() - 60_000),
        finishedAt: null,
        error: null,
      },
    ];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, now, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(1);
    expect(runs[0].status).toBe("lost");
    expect(runs[0].error).toMatch(/Orphaned/);
    expect(runs[0].finishedAt).toEqual(now);
  });

  it("leaves a running run with a fresh heartbeat alone", async () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const runs: FakeRun[] = [
      {
        id: "r1",
        status: "running",
        heartbeatAt: new Date(now.getTime() - 5_000),
        startedAt: new Date(now.getTime() - 60_000),
        finishedAt: null,
        error: null,
      },
    ];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, now, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("running");
  });

  it("recovers a run that never got a first heartbeat, once it's older than the timeout", async () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const runs: FakeRun[] = [
      {
        id: "r1",
        status: "running",
        heartbeatAt: null,
        startedAt: new Date(now.getTime() - HEARTBEAT_TIMEOUT_MS - 1_000),
        finishedAt: null,
        error: null,
      },
    ];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, now, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(1);
    expect(runs[0].status).toBe("lost");
  });

  it("ignores non-running runs regardless of heartbeat age", async () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const runs: FakeRun[] = [
      {
        id: "r1",
        status: "succeeded",
        heartbeatAt: new Date(now.getTime() - HEARTBEAT_TIMEOUT_MS - 1_000),
        startedAt: new Date(now.getTime() - 60_000),
        finishedAt: now,
        error: null,
      },
    ];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, now, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("succeeded");
  });

  it("is a no-op the second time (double-reconcile is idempotent)", async () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const runs: FakeRun[] = [
      {
        id: "r1",
        status: "running",
        heartbeatAt: new Date(now.getTime() - HEARTBEAT_TIMEOUT_MS - 1_000),
        startedAt: new Date(now.getTime() - 60_000),
        finishedAt: null,
        error: null,
      },
    ];
    const db = fakeDb(runs);

    const first = await reconcileOnce(db, now, HEARTBEAT_TIMEOUT_MS);
    const second = await reconcileOnce(db, now, HEARTBEAT_TIMEOUT_MS);

    expect(first).toBe(1);
    expect(second).toBe(0);
  });
});
