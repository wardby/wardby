import { describe, expect, it, vi } from "vitest";
import { RunStepSweeper, sweepExpiredRunSteps } from "./sweep.js";

describe("sweepExpiredRunSteps", () => {
  it("deletes in batches until a batch comes back short, at most maxBatches", async () => {
    const executeRaw = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const db = { $executeRaw: executeRaw } as never;
    expect(await sweepExpiredRunSteps(db, new Date(), { batchSize: 2, maxBatches: 10 })).toBe(5);
    expect(executeRaw).toHaveBeenCalledTimes(3);
    const capped = vi.fn().mockResolvedValue(2);
    expect(
      await sweepExpiredRunSteps({ $executeRaw: capped } as never, new Date(), { batchSize: 2, maxBatches: 2 }),
    ).toBe(4);
    expect(capped).toHaveBeenCalledTimes(2);
  });
});

describe("RunStepSweeper", () => {
  it("sweeps at most once per interval and never rejects", async () => {
    let now = new Date("2026-11-07T00:00:00.000Z");
    const executeRaw = vi.fn().mockResolvedValue(0);
    const sweeper = new RunStepSweeper({ $executeRaw: executeRaw } as never, { intervalMs: 60_000, now: () => now });
    await sweeper.maybeSweep();
    await sweeper.maybeSweep();
    expect(executeRaw).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 60_000);
    executeRaw.mockRejectedValueOnce(new Error("connection reset"));
    await expect(sweeper.maybeSweep()).resolves.toBe(0);
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });
});
