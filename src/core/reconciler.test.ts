import { describe, expect, it } from "vitest";
import { reconcileOnce, type ReconcilerDb } from "./reconciler.js";

interface FakeRun {
  id: string;
  status: string;
  trigger: string;
  heartbeatAt: Date | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}

/** Minimal Prisma-`where`-filter matcher: equality, `{lt}`, `null`, and nested `OR` arrays. */
function matches(run: FakeRun, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      const clauses = cond as Record<string, unknown>[];
      if (!clauses.some((clause) => matches(run, clause))) return false;
      continue;
    }
    const value = (run as unknown as Record<string, unknown>)[key];
    if (cond === null) {
      if (value !== null) return false;
    } else if (typeof cond === "object" && cond !== null && "lt" in cond) {
      const lt = (cond as { lt: Date }).lt;
      if (!(value instanceof Date) || !(value < lt)) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function fakeDb(runs: FakeRun[]): ReconcilerDb {
  const byId = new Map(runs.map((r) => [r.id, r]));

  return {
    run: {
      updateMany: (async ({ where, data }: any) => {
        let count = 0;
        for (const run of byId.values()) {
          if (!matches(run, where)) continue;
          Object.assign(run, data);
          count += 1;
        }
        return { count };
      }) as any,
    },
  } as unknown as ReconcilerDb;
}

const HEARTBEAT_TIMEOUT_MS = 45_000;
const NOW = new Date("2026-09-05T12:00:00.000Z");
const STALE = new Date(NOW.getTime() - HEARTBEAT_TIMEOUT_MS - 1_000);
const FRESH = new Date(NOW.getTime() - 5_000);

function baseRun(overrides: Partial<FakeRun>): FakeRun {
  return {
    id: "r1",
    status: "running",
    trigger: "scheduled",
    heartbeatAt: FRESH,
    startedAt: new Date(NOW.getTime() - 60_000),
    finishedAt: null,
    error: null,
    ...overrides,
  };
}

describe("reconcileOnce", () => {
  it("marks a scheduled run with a stale heartbeat as lost", async () => {
    const runs = [baseRun({ heartbeatAt: STALE })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(1);
    expect(runs[0].status).toBe("lost");
    expect(runs[0].error).toMatch(/Orphaned/);
    expect(runs[0].finishedAt).toEqual(NOW);
  });

  it("leaves a scheduled run with a fresh heartbeat alone", async () => {
    const runs = [baseRun({ heartbeatAt: FRESH })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("running");
  });

  it("recovers a scheduled run that never got a first heartbeat, once older than the timeout", async () => {
    const runs = [baseRun({ heartbeatAt: null, startedAt: STALE })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(1);
    expect(runs[0].status).toBe("lost");
  });

  it("recovers a scheduled run stuck pending past the timeout (crash before it ever started)", async () => {
    const runs = [baseRun({ status: "pending", heartbeatAt: null, startedAt: STALE })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(1);
    expect(runs[0].status).toBe("lost");
  });

  it("leaves a scheduled run pending for less than the timeout alone", async () => {
    const runs = [baseRun({ status: "pending", heartbeatAt: null, startedAt: FRESH })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("pending");
  });

  it("never reaps a manual run, even with no heartbeat and an old startedAt", async () => {
    // This is the bug this scoping fixes: an attended `reevo run` has no
    // heartbeat by design, so without the trigger scope a long-streaming
    // manual run would get flipped to `lost` while a human still watches it.
    const runs = [
      baseRun({ trigger: "manual", heartbeatAt: null, startedAt: STALE }),
    ];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("running");
  });

  it("ignores non-running, non-pending runs regardless of heartbeat age", async () => {
    const runs = [baseRun({ status: "succeeded", heartbeatAt: STALE, finishedAt: NOW })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("succeeded");
  });

  it("is a no-op the second time (double-reconcile is idempotent)", async () => {
    const runs = [baseRun({ heartbeatAt: STALE })];
    const db = fakeDb(runs);

    const first = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);
    const second = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(first).toBe(1);
    expect(second).toBe(0);
  });
});
