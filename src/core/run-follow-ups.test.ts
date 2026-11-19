import { describe, expect, it, vi } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CLAIM_TTL_MS,
  HANDLER_TIMEOUT_MS,
  MAX_PAYLOAD_BYTES,
  drainRunFollowUps,
  enqueueRunFollowUp,
  followUpBackoffMs,
  type RunFollowUpDb,
  type RunFollowUpHandlers,
} from "./run-follow-ups.js";

describe("followUpBackoffMs", () => {
  it("doubles from the base and stops at the cap", () => {
    expect([1, 2, 3, 4].map(followUpBackoffMs)).toEqual([
      BACKOFF_BASE_MS,
      BACKOFF_BASE_MS * 2,
      BACKOFF_BASE_MS * 4,
      BACKOFF_BASE_MS * 8,
    ]);
    expect(followUpBackoffMs(50)).toBe(BACKOFF_MAX_MS);
  });

  it("keeps a claim longer than a handler may run, so a live handler's row is never taken", () => {
    expect(CLAIM_TTL_MS).toBeGreaterThan(HANDLER_TIMEOUT_MS);
  });
});

describe("enqueueRunFollowUp", () => {
  const tx = () => ({ runFollowUp: { createMany: vi.fn(async () => ({ count: 1 })) } });

  it("inserts one row and skips a duplicate of the same run and kind", async () => {
    const client = tx();
    await enqueueRunFollowUp(client as never, { runId: "r1", kind: "notify", payload: { childRunId: "c1" } });
    expect(client.runFollowUp.createMany).toHaveBeenCalledWith({
      data: [{ runId: "r1", kind: "notify", payload: { childRunId: "c1" } }],
      skipDuplicates: true,
    });
  });

  it("defaults to an empty payload", async () => {
    const client = tx();
    await enqueueRunFollowUp(client as never, { runId: "r1", kind: "notify" });
    expect(client.runFollowUp.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ runId: "r1", kind: "notify", payload: {} }] }),
    );
  });

  it("refuses a payload too big to be ids, and writes nothing", async () => {
    const client = tx();
    await expect(
      enqueueRunFollowUp(client as never, {
        runId: "r1",
        kind: "notify",
        payload: { text: "x".repeat(MAX_PAYLOAD_BYTES) },
      }),
    ).rejects.toThrow("pass ids, not content");
    expect(client.runFollowUp.createMany).not.toHaveBeenCalled();
  });
});

describe("drainRunFollowUps", () => {
  const row = (id: string, kind = "notify", attempts = 1) => ({
    id,
    runId: `run-${id}`,
    kind,
    payload: { childRunId: `child-${id}` },
    attempts,
  });
  /** A db whose claim returns `rows`, then the backlog stats; `executed` records each update's values. */
  function fakeDb(rows: ReturnType<typeof row>[], executeImpl?: () => Promise<number>) {
    const executed: unknown[][] = [];
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValue([{ pending: 3, oldestAgeSeconds: 42 }]);
    const executeRaw = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push(values);
      return executeImpl ? executeImpl() : 1;
    });
    return { db: { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as RunFollowUpDb, executed, queryRaw };
  }

  it("hands each claimed row to its handler and marks it done", async () => {
    const { db, executed } = fakeDb([row("a")]);
    const handler = vi.fn(async () => undefined);
    const result = await drainRunFollowUps({ db, handlers: { notify: handler } });
    expect(result).toEqual({ done: 1, failed: 0 });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-a", kind: "notify", payload: { childRunId: "child-a" }, attempt: 1 }),
    );
    expect(executed).toEqual([["a"]]); // the done update names the row
  });

  it("fails a row that has no handler, without calling anything", async () => {
    const { db } = fakeDb([row("a", "retired-kind")]);
    const observer = { runFollowUpResult: vi.fn(), runFollowUpBacklog: vi.fn() };
    expect(await drainRunFollowUps({ db, handlers: {}, observer })).toEqual({ done: 0, failed: 1 });
    expect(observer.runFollowUpResult).toHaveBeenCalledWith("failed");
  });

  it("stores the error's name and backoff, never its message, and carries on to the next row", async () => {
    const { db, executed } = fakeDb([row("a", "bad", 2), row("b")]);
    const good = vi.fn(async () => undefined);
    const handlers: RunFollowUpHandlers = {
      bad: async () => {
        throw new RangeError("Authorization: Bearer sk-live-secret");
      },
      notify: good,
    };
    expect(await drainRunFollowUps({ db, handlers })).toEqual({ done: 1, failed: 1 });
    expect(good).toHaveBeenCalledTimes(1);
    const [backoffMs, lastError, id] = executed[0] as [number, string, string];
    expect(backoffMs).toBe(followUpBackoffMs(2));
    expect(lastError).toBe("RangeError");
    expect(id).toBe("a");
    expect(JSON.stringify(executed)).not.toContain("sk-live-secret");
  });

  it("carries on when saving a failure's backoff fails too", async () => {
    let calls = 0;
    const { db } = fakeDb([row("a", "bad"), row("b")], async () => {
      calls += 1;
      if (calls === 1) throw new Error("database unavailable");
      return 1;
    });
    const good = vi.fn(async () => undefined);
    const handlers: RunFollowUpHandlers = {
      bad: async () => {
        throw new Error("boom");
      },
      notify: good,
    };
    await expect(drainRunFollowUps({ db, handlers })).resolves.toEqual({ done: 1, failed: 1 });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("abandons a handler that runs past its limit, aborting its signal", async () => {
    const { db } = fakeDb([row("a", "hung")]);
    let signal: AbortSignal | undefined;
    const handlers: RunFollowUpHandlers = {
      hung: (context) => {
        signal = context.signal;
        return new Promise<void>(() => undefined);
      },
    };
    expect(await drainRunFollowUps({ db, handlers, handlerTimeoutMs: 20 })).toEqual({ done: 0, failed: 1 });
    expect(signal?.aborted).toBe(true);
  });

  it("reports the backlog after a pass, and ignores an observer that throws", async () => {
    const { db } = fakeDb([row("a")]);
    const backlog = vi.fn();
    const observer = {
      runFollowUpResult: () => {
        throw new Error("metrics down");
      },
      runFollowUpBacklog: backlog,
    };
    await expect(drainRunFollowUps({ db, handlers: { notify: async () => undefined }, observer })).resolves.toEqual({
      done: 1,
      failed: 0,
    });
    expect(backlog).toHaveBeenCalledWith({ pending: 3, oldestAgeSeconds: 42 });
  });

  it("does no backlog query without an observer", async () => {
    const { db, queryRaw } = fakeDb([]);
    await drainRunFollowUps({ db, handlers: {} });
    expect(queryRaw).toHaveBeenCalledTimes(1); // the claim only
  });
});
