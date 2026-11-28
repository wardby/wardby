import { afterEach, describe, expect, it, vi } from "vitest";
import { armNativeRunTimeout, nativeRunDeadline, nativeRunJoin, nativeRunTimeoutReason } from "./runner.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("native run time limit", () => {
  it("the deadline is the run's start plus its timeoutSec; none without one", () => {
    const startedAt = new Date(1_000_000);
    expect(nativeRunDeadline({ startedAt, timeoutSec: 1800 })).toBe(1_000_000 + 1_800_000);
    expect(nativeRunDeadline({ startedAt, timeoutSec: null })).toBeUndefined();
    expect(nativeRunTimeoutReason(1800)).toMatch(/^native_run_timeout: .*1800 s/);
  });

  it("fires once at the deadline, and never once cancelled", async () => {
    vi.useFakeTimers();
    const fired = vi.fn(async () => {});
    const now = () => 0;
    armNativeRunTimeout(1_000, fired, now);
    const cancelled = vi.fn(async () => {});
    armNativeRunTimeout(1_000, cancelled, now).cancel();
    await vi.advanceTimersByTimeAsync(999);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe("nativeRunJoin", () => {
  it("is absent when the run records no steps", () => {
    expect(nativeRunJoin({ runStep: {} as never }, "r1", "off")).toBeUndefined();
  });

  it("polls the run's steps, answering at once unless asked to wait", async () => {
    const findMany = vi.fn(async ({ where }: { where: { kind: unknown } }) =>
      JSON.stringify(where.kind).includes("join")
        ? [{ kind: "join", fromPrincipalId: "p1" }]
        : [{ id: "s2", seq: 2, kind: "message", detail: "hello", deliveredAt: null }],
    );
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const join = nativeRunJoin({ runStep: { findMany, updateMany } as never }, "r1", "summary");
    const answer = await join!.poll({ after: 0, joined: false, wait: false });
    expect(answer).toMatchObject({ joined: true, messages: [{ seq: 2, text: "hello", interrupt: false }] });
    expect(typeof answer.now).toBe("number");
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
