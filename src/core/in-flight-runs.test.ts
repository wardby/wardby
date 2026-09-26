import { afterEach, describe, expect, it, vi } from "vitest";
import { inFlightRunIds, trackRun, waitForInFlightRuns } from "./in-flight-runs.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("in-flight runs", () => {
  afterEach(() => vi.useRealTimers());

  it("returns at once when nothing is running", async () => {
    await expect(waitForInFlightRuns(60_000)).resolves.toEqual([]);
  });

  it("waits until every tracked run finishes", async () => {
    const a = deferred();
    const b = deferred();
    const runA = trackRun("a", () => a.promise);
    const runB = trackRun("b", () => b.promise);
    expect(inFlightRunIds().sort()).toEqual(["a", "b"]);

    let drained = false;
    const wait = waitForInFlightRuns(60_000).then((left) => {
      drained = true;
      return left;
    });
    a.resolve();
    await runA;
    await Promise.resolve();
    expect(drained).toBe(false);
    b.resolve();
    await runB;
    await expect(wait).resolves.toEqual([]);
  });

  it("stops waiting at the timeout and reports what is still running", async () => {
    vi.useFakeTimers();
    const slow = deferred();
    const run = trackRun("slow", () => slow.promise);
    const wait = waitForInFlightRuns(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toEqual(["slow"]);
    slow.resolve();
    await run;
    expect(inFlightRunIds()).toEqual([]);
  });

  it("does not wait with a zero timeout, and untracks a run that throws", async () => {
    const hang = deferred();
    const run = trackRun("hang", () => hang.promise);
    await expect(waitForInFlightRuns(0)).resolves.toEqual(["hang"]);
    hang.resolve();
    await run;
    await expect(trackRun("boom", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(inFlightRunIds()).toEqual([]);
  });
});
