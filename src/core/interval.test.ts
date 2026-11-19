import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startInterval } from "./interval.js";

describe("startInterval", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hang = () => new Promise<void>(() => undefined);

  it("runs a tick every interval, the first one an interval after start", async () => {
    const tick = vi.fn(async () => undefined);
    const loop = startInterval({ name: "t", everyMs: 10_000, timeoutMs: 5_000, tick });
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(3);
    await loop.stop();
  });

  it("runs the first tick at once with runImmediately", async () => {
    const tick = vi.fn(async () => undefined);
    const loop = startInterval({ name: "t", everyMs: 10_000, timeoutMs: 5_000, tick, runImmediately: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it("never runs two ticks at once", async () => {
    let release!: () => void;
    const tick = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const loop = startInterval({ name: "t", everyMs: 10_000, timeoutMs: 3_600_000, tick });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(2);
    release(); // the second tick is in flight too; stop() would wait for it
    await loop.stop();
  });

  it("abandons a tick that never settles after its timeout and runs the next one", async () => {
    const tick = vi.fn(hang);
    const onError = vi.fn();
    const loop = startInterval({ name: "t", everyMs: 10_000, timeoutMs: 15_000, tick, onError });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); // 20s: the first tick timed out at 25s, so still in flight
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); // 30s: timed out at 25s, the next tick starts
    expect(tick).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("timeout");
    const stopping = loop.stop(); // the second tick hangs too: stop() returns once its timeout passes
    await vi.advanceTimersByTimeAsync(15_000);
    await stopping;
  });

  it("aborts the signal of a tick that timed out", async () => {
    let signal!: AbortSignal;
    const loop = startInterval({
      name: "t",
      everyMs: 10_000,
      timeoutMs: 5_000,
      tick: (s) => {
        signal = s;
        return hang();
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal.aborted).toBe(true);
    await loop.stop();
  });

  it("reports a thrown tick, keeps running, and does not count its late failure twice", async () => {
    const tick = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const onError = vi.fn();
    const loop = startInterval({ name: "t", everyMs: 10_000, timeoutMs: 5_000, tick, onError });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.map((call) => call[0])).toEqual(["error", "error"]);
    await loop.stop();

    let fail!: (err: Error) => void;
    const late = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const lateErrors = vi.fn();
    const lateLoop = startInterval({ name: "t", everyMs: 10_000, timeoutMs: 5_000, tick: late, onError: lateErrors });
    await vi.advanceTimersByTimeAsync(15_000);
    fail(new Error("too late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(lateErrors.mock.calls.map((call) => call[0])).toEqual(["timeout"]);
    await lateLoop.stop();
  });

  it("keeps running when the error hook itself throws", async () => {
    const tick = vi.fn(async () => {
      throw new Error("boom");
    });
    const loop = startInterval({
      name: "t",
      everyMs: 10_000,
      timeoutMs: 5_000,
      tick,
      onError: () => {
        throw new Error("metrics down");
      },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tick).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("stop() waits for the tick in flight, and no tick starts after it", async () => {
    let release!: () => void;
    const tick = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const loop = startInterval({ name: "t", everyMs: 10_000, timeoutMs: 3_600_000, tick });
    await vi.advanceTimersByTimeAsync(10_000);
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopped).toBe(false);
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("stop() resolves once a hung tick times out", async () => {
    const loop = startInterval({ name: "t", everyMs: 10_000, timeoutMs: 5_000, tick: hang });
    await vi.advanceTimersByTimeAsync(10_000);
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("stop() with nothing in flight resolves at once, and is safe to call twice", async () => {
    const tick = vi.fn(async () => undefined);
    const loop = startInterval({ name: "t", everyMs: 10_000, timeoutMs: 5_000, tick });
    await loop.stop();
    await loop.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
