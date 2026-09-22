import { describe, expect, it } from "vitest";
import { waitForCodingChild } from "./runner.js";

interface Row {
  status: string;
}

/** A clock that only advances when the waiter sleeps, so bounds are exact. */
function harness(opts: { child: Row; parent: Row | null; cancelledTask?: boolean }) {
  let clock = 0;
  const sleeps: number[] = [];
  const stops: Array<{ runId: string; reason?: string }> = [];
  const db = {
    run: {
      findUniqueOrThrow: async ({ where }: any) => ({ id: where.id, ...opts.child }),
      findUnique: async () => opts.parent,
    },
    task: {
      findFirst: async () => (opts.cancelledTask ? { id: "task-1" } : null),
    },
  };
  return {
    sleeps,
    stops,
    options: {
      db: db as never,
      executor: {
        async stop(runId: string, reason?: string) {
          stops.push({ runId, reason });
        },
      },
      childRunId: "child",
      parentRunId: "parent",
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  };
}

describe("waitForCodingChild", () => {
  it("polls with backoff until the queued child reaches a terminal status", async () => {
    const h = harness({ child: { status: "pending" }, parent: { status: "running" } });
    let polls = 0;
    const db = h.options.db as any;
    const original = db.run.findUniqueOrThrow;
    db.run.findUniqueOrThrow = async (args: any) => {
      polls += 1;
      return polls >= 5 ? { id: "child", status: "succeeded", finalText: "done" } : original(args);
    };

    const outcome = await waitForCodingChild({ ...h.options, boundMs: 60_000 });

    expect(outcome).toMatchObject({ kind: "terminal", run: { status: "succeeded", finalText: "done" } });
    expect(h.sleeps).toEqual([1_000, 2_000, 4_000, 5_000]);
    expect(h.stops).toEqual([]);
  });

  it("gives up after the bound, stops the child, and reports a timeout", async () => {
    const h = harness({ child: { status: "pending" }, parent: { status: "running" } });

    const outcome = await waitForCodingChild({ ...h.options, boundMs: 10_000 });

    expect(outcome).toEqual({ kind: "timed_out" });
    // Never sleeps past the bound: 1s + 2s + 4s + the remaining 3s.
    expect(h.sleeps).toEqual([1_000, 2_000, 4_000, 3_000]);
    expect(h.stops).toEqual([{ runId: "child", reason: "sub-agent wait timed out" }]);
  });

  it("stops waiting and stops the child when the parent run is no longer pending/running", async () => {
    const h = harness({ child: { status: "pending" }, parent: { status: "lost" } });

    const outcome = await waitForCodingChild({ ...h.options, boundMs: 60_000 });

    expect(outcome).toEqual({ kind: "parent_cancelled" });
    expect(h.sleeps).toEqual([]);
    expect(h.stops).toEqual([{ runId: "child", reason: "parent run cancelled" }]);
  });

  it("treats a cancelled MCP task for the parent run as cancellation", async () => {
    const h = harness({ child: { status: "running" }, parent: { status: "running" }, cancelledTask: true });

    const outcome = await waitForCodingChild({ ...h.options, boundMs: 60_000 });

    expect(outcome).toEqual({ kind: "parent_cancelled" });
    expect(h.stops).toEqual([{ runId: "child", reason: "parent run cancelled" }]);
  });

  it("returns an already-terminal child without sleeping", async () => {
    const h = harness({ child: { status: "failed" }, parent: { status: "running" } });

    const outcome = await waitForCodingChild({ ...h.options, boundMs: 60_000 });

    expect(outcome).toMatchObject({ kind: "terminal", run: { status: "failed" } });
    expect(h.sleeps).toEqual([]);
  });
});
