import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertLeaseConfig,
  renewHeldLeases,
  startLeaseTimers,
  sweepExpiredLeases,
  type LeaseLedger,
  type LeaseLossReason,
} from "./request-lease.js";

describe("assertLeaseConfig", () => {
  const names = { lease: "LEASE", heartbeat: "HEARTBEAT" };

  it("accepts a lease longer than two heartbeats", () => {
    expect(() => assertLeaseConfig({ leaseMs: 30_001, heartbeatMs: 15_000 }, names)).not.toThrow();
  });

  it("refuses a lease of two heartbeats or fewer, naming the settings", () => {
    expect(() => assertLeaseConfig({ leaseMs: 30_000, heartbeatMs: 15_000 }, names)).toThrow(
      "LEASE must be greater than twice HEARTBEAT.",
    );
  });
});

describe("renewHeldLeases", () => {
  const run = async (held: () => string[], renew: LeaseLedger<never>["renew"]) => {
    const lost: [string, LeaseLossReason][] = [];
    await renewHeldLeases({
      ledger: { renew },
      ownerId: "me",
      held,
      onLost: (id, reason) => lost.push([id, reason]),
    });
    return lost;
  };

  it("reports no loss when every held id renewed", async () => {
    const renew = vi.fn(async (_owner: string, ids: string[]) => ({ renewed: ids }));
    expect(await run(() => ["a", "b"], renew)).toEqual([]);
    expect(renew).toHaveBeenCalledWith("me", ["a", "b"]);
  });

  it("reports each held id the ledger did not renew as lost", async () => {
    expect(
      await run(
        () => ["a", "b", "c"],
        async () => ({ renewed: ["b"] }),
      ),
    ).toEqual([
      ["a", "lost"],
      ["c", "lost"],
    ]);
  });

  it("reports a renewed id whose session was cancelled", async () => {
    expect(
      await run(
        () => ["a", "b"],
        async () => ({ renewed: ["a", "b"], cancelled: ["b"] }),
      ),
    ).toEqual([["b", "cancelled"]]);
  });

  it("does not call the ledger when it holds nothing", async () => {
    const renew = vi.fn(async () => ({ renewed: [] as string[] }));
    expect(await run(() => [], renew)).toEqual([]);
    expect(renew).not.toHaveBeenCalled();
  });

  it("does not report an id that finished while the renewal was running", async () => {
    const held = ["a", "b"];
    const lost = await run(
      () => [...held],
      async () => {
        held.splice(held.indexOf("a"), 1); // "a" completed, so the ledger did not renew it
        return { renewed: ["b"] };
      },
    );
    expect(lost).toEqual([]);
  });
});

describe("sweepExpiredLeases", () => {
  it("settles every expired item and counts the ones without an estimate", async () => {
    const ledger = {
      expired: vi.fn(async () => ["a", "b", "c"]),
      settleExpired: vi.fn(async (id: string) =>
        id === "a" ? ("settled" as const) : id === "b" ? ("settledWithoutEstimate" as const) : ("lostRace" as const),
      ),
    };
    expect(await sweepExpiredLeases(ledger)).toEqual({ settled: 2, withoutEstimate: 1, failures: [] });
  });

  it("collects a failed settlement and carries on with the rest", async () => {
    const boom = new Error("boom");
    const ledger = {
      expired: vi.fn(async () => ["a", "b"]),
      settleExpired: vi.fn(async (id: string) => {
        if (id === "a") throw boom;
        return "settled" as const;
      }),
    };
    expect(await sweepExpiredLeases(ledger)).toEqual({ settled: 1, withoutEstimate: 0, failures: [boom] });
  });

  it("drains a backlog over several passes and stops when a pass settles nothing", async () => {
    const queue = ["a", "b", "c", "d", "e"];
    const ledger = {
      expired: vi.fn(async (limit: number) => queue.slice(0, limit)),
      settleExpired: vi.fn(async (id: string) => {
        queue.splice(queue.indexOf(id), 1);
        return "settled" as const;
      }),
    };
    expect((await sweepExpiredLeases(ledger, 2)).settled).toBe(5);
    expect(ledger.expired).toHaveBeenCalledTimes(3);

    const stuck = { expired: vi.fn(async () => ["x", "y"]), settleExpired: vi.fn(async () => "lostRace" as const) };
    expect((await sweepExpiredLeases(stuck, 2)).settled).toBe(0);
    expect(stuck.expired).toHaveBeenCalledTimes(1);
  });
});

describe("startLeaseTimers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const proxy = () => ({
    renewOwnLeases: vi.fn(async () => undefined),
    sweepExpired: vi.fn(async () => ({ settled: 0, withoutEstimate: 0, failures: [] as unknown[] })),
  });
  const wiring = (p: ReturnType<typeof proxy>) => ({
    name: "test",
    eventPrefix: "test",
    renew: () => p.renewOwnLeases(),
    sweep: () => p.sweepExpired(),
  });

  it("renews every heartbeat and sweeps every sweep interval, the first one an interval after start", async () => {
    const p = proxy();
    const timers = startLeaseTimers({ ...wiring(p), heartbeatMs: 10_000, sweepMs: 15_000 });
    expect(p.renewOwnLeases).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(p.renewOwnLeases).toHaveBeenCalledTimes(3);
    expect(p.sweepExpired).toHaveBeenCalledTimes(2);
    await timers.stop();
  });

  it("stops both timers", async () => {
    const p = proxy();
    await startLeaseTimers({ ...wiring(p), heartbeatMs: 10_000, sweepMs: 15_000 }).stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.renewOwnLeases).not.toHaveBeenCalled();
    expect(p.sweepExpired).not.toHaveBeenCalled();
  });

  it("does not start a tick while the previous one is still running", async () => {
    const p = proxy();
    let release!: () => void;
    p.renewOwnLeases.mockImplementation(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );
    const timers = startLeaseTimers({
      ...wiring(p),
      heartbeatMs: 10_000,
      sweepMs: 3_600_000,
      tickTimeoutMs: 3_600_000,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(p.renewOwnLeases).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.renewOwnLeases).toHaveBeenCalledTimes(2);
    release(); // the second renewal is in flight too; stop() would wait for it
    await timers.stop();
  });

  it("abandons a renewal that never settles, reports it, and renews again on the next tick", async () => {
    const p = proxy();
    p.renewOwnLeases.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    const onError = vi.fn();
    const timers = startLeaseTimers({
      ...wiring(p),
      heartbeatMs: 10_000,
      sweepMs: 3_600_000,
      tickTimeoutMs: 15_000,
      onError,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.renewOwnLeases).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000); // the first renewal times out at 25s; the tick at 30s renews
    expect(p.renewOwnLeases).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls).toEqual([["renew"]]);
    await timers.stop();
  });

  it("stop() waits for a sweep in flight", async () => {
    const p = proxy();
    let release!: () => void;
    p.sweepExpired.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ settled: 0, withoutEstimate: 0, failures: [] });
        }),
    );
    const timers = startLeaseTimers({
      ...wiring(p),
      heartbeatMs: 3_600_000,
      sweepMs: 10_000,
      tickTimeoutMs: 3_600_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    let stopped = false;
    const stopping = timers.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("reports a failed renewal or sweep, never throws, and tries again next tick", async () => {
    const p = proxy();
    p.renewOwnLeases.mockRejectedValueOnce(new Error("database unavailable"));
    p.sweepExpired.mockRejectedValueOnce(new Error("database unavailable"));
    const onError = vi.fn();
    const timers = startLeaseTimers({ ...wiring(p), heartbeatMs: 10_000, sweepMs: 10_000, onError });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onError.mock.calls).toEqual([["renew"], ["sweep"]]);
    expect(p.renewOwnLeases).toHaveBeenCalledTimes(2);
    expect(p.sweepExpired).toHaveBeenCalledTimes(2);
    await timers.stop();
  });

  it("reports each row a sweep could not settle", async () => {
    const p = proxy();
    p.sweepExpired.mockResolvedValue({ settled: 1, withoutEstimate: 0, failures: [new Error("a"), new Error("b")] });
    const onError = vi.fn();
    const timers = startLeaseTimers({ ...wiring(p), heartbeatMs: 3_600_000, sweepMs: 10_000, onError });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onError.mock.calls).toEqual([["sweep"], ["sweep"]]);
    await timers.stop();
  });
});
