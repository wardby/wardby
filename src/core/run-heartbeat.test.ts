import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { cancelRunOnSignal, withRunHeartbeat } from "./run-heartbeat.js";

function fakeRunDb(status = "running") {
  const row: Record<string, any> = { id: "run_1", status, heartbeatAt: null };
  const updateMany = vi.fn(async ({ where, data }: any) => {
    if (where.id !== row.id || !where.status.in.includes(row.status)) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  return { row, db: { run: { updateMany } } as never, updateMany };
}

describe("withRunHeartbeat", () => {
  it("beats before the run starts and on every interval until it settles", async () => {
    vi.useFakeTimers();
    try {
      const { row, db, updateMany } = fakeRunDb();
      let finish!: () => void;
      const done = withRunHeartbeat(db, "run_1", () => new Promise<string>((r) => (finish = () => r("ok"))), 1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(row.heartbeatAt).toBeInstanceOf(Date);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(updateMany).toHaveBeenCalledTimes(4);
      finish();
      await expect(done).resolves.toBe("ok");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(updateMany).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed beat never fails the run", async () => {
    const db = { run: { updateMany: vi.fn(async () => Promise.reject(new Error("db down"))) } } as never;
    await expect(withRunHeartbeat(db, "run_1", async () => 42)).resolves.toBe(42);
  });
});

describe("cancelRunOnSignal", () => {
  function fakeProcess() {
    const emitter = new EventEmitter();
    const exit = vi.fn();
    return { target: Object.assign(emitter, { exit }), exit };
  }

  it("SIGINT records a running run as cancelled and exits 130", async () => {
    const { row, db } = fakeRunDb();
    const { target, exit } = fakeProcess();
    cancelRunOnSignal(db, "run_1", target);

    target.emit("SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    expect(row.status).toBe("cancelled");
    expect(row.error).toBe("Interrupted by SIGINT.");
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });

  it("SIGTERM exits 143 and never overwrites a run that already finished", async () => {
    const { row, db } = fakeRunDb("succeeded");
    const { target, exit } = fakeProcess();
    cancelRunOnSignal(db, "run_1", target);

    target.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(row.status).toBe("succeeded");
  });

  it("the returned function removes both handlers once the run is over", () => {
    const { db } = fakeRunDb();
    const { target } = fakeProcess();
    const remove = cancelRunOnSignal(db, "run_1", target);
    remove();
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });
});
