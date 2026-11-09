import { describe, expect, it, vi } from "vitest";
import { RunStepWriter, type RunStepWriterDb } from "./writer.js";
import type { ExtractedStep } from "./types.js";

// A fake value only: never a real credential.
const FAKE_SECRET = "wbFake-Secret-Value-7f3a91";
const step: ExtractedStep = { kind: "tool", callId: "c1", tool: "Bash", text: `echo ${FAKE_SECRET}`, truncated: false };

function fakeDb() {
  return {
    run: { findUnique: vi.fn(async () => ({ agentId: "a1" })) },
    runStep: {},
    $transaction: vi.fn(async () => undefined),
  };
}

describe("RunStepWriter", () => {
  describe("flush", () => {
    it("waits for a pending write to settle", async () => {
      const db = fakeDb();
      let release!: () => void;
      db.$transaction.mockImplementation(
        () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
      );
      const writer = new RunStepWriter({
        db: db as unknown as RunStepWriterDb,
        secretValues: async () => [],
        level: "summary",
        retentionDays: 30,
      });
      void writer.record("r1", { steps: [step], results: [] });
      let flushed = false;
      const flushing = writer.flush().then(() => (flushed = true));
      await vi.waitFor(() => expect(db.$transaction).toHaveBeenCalled());
      expect(flushed).toBe(false);
      release();
      await flushing;
      expect(flushed).toBe(true);
    });

    it("resolves at its bound when a write never settles, and at once with nothing queued", async () => {
      const db = fakeDb();
      db.$transaction.mockImplementation(() => new Promise<undefined>(() => undefined));
      const writer = new RunStepWriter({
        db: db as unknown as RunStepWriterDb,
        secretValues: async () => [],
        level: "summary",
        retentionDays: 30,
      });
      await expect(writer.flush(10)).resolves.toBeUndefined();
      void writer.record("r1", { steps: [step], results: [] });
      await expect(writer.flush(20)).resolves.toBeUndefined();
    });
  });

  it("writes nothing when the run's secret values can't be read, and logs only the error's name", async () => {
    const db = fakeDb();
    const warn = vi.fn();
    const writer = new RunStepWriter({
      db: db as unknown as RunStepWriterDb,
      secretValues: async () => {
        throw new Error(`vault down ${FAKE_SECRET}`);
      },
      level: "summary",
      retentionDays: 30,
      log: { warn },
    });
    await writer.record("r1", { steps: [step], results: [] });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({ runId: "r1", event: "run_steps_write_failed", errorName: "Error" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(FAKE_SECRET);
  });

  it("logs neither a tool input nor an output when it fails closed on unreadable values or a failing write", async () => {
    const batch = {
      steps: [{ kind: "tool" as const, callId: "c1", tool: "Bash", text: "ls", truncated: false, input: FAKE_SECRET }],
      results: [{ callId: "c1", status: "ok" as const, output: FAKE_SECRET, outputCut: true }],
    };
    const unreadable = fakeDb();
    const warn = vi.fn();
    const closed = new RunStepWriter({
      db: unreadable as unknown as RunStepWriterDb,
      secretValues: async () => {
        throw new Error(`vault down ${FAKE_SECRET}`);
      },
      level: "detail",
      retentionDays: 30,
      log: { warn },
    });
    await closed.record("r1", batch);
    expect(unreadable.$transaction).not.toHaveBeenCalled();
    const failing = fakeDb();
    failing.$transaction.mockRejectedValueOnce(new Error(`insert failed ${FAKE_SECRET}`));
    const failed = new RunStepWriter({
      db: failing as unknown as RunStepWriterDb,
      secretValues: async () => [FAKE_SECRET],
      level: "detail",
      retentionDays: 30,
      log: { warn },
    });
    await failed.record("r1", batch);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(FAKE_SECRET);
  });

  it("writes nothing when values are unreadable for a detail result-only batch", async () => {
    const db = {
      run: { findUnique: vi.fn(async () => ({ agentId: "a1", runStepsLevel: "detail" })) },
      runStep: {},
      $transaction: vi.fn(async () => undefined),
    };
    const warn = vi.fn();
    const writer = new RunStepWriter({
      db: db as unknown as RunStepWriterDb,
      secretValues: async () => {
        throw new Error(`cannot read ${FAKE_SECRET}`);
      },
      level: "detail",
      retentionDays: 30,
      log: { warn },
    });
    await writer.record("r1", { steps: [], results: [{ callId: "c1", status: "ok", output: FAKE_SECRET }] });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(FAKE_SECRET);
  });

  it("does not read secret values for a batch of results only", async () => {
    const db = fakeDb();
    const secretValues = vi.fn(async () => [FAKE_SECRET]);
    const writer = new RunStepWriter({
      db: db as unknown as RunStepWriterDb,
      secretValues,
      level: "summary",
      retentionDays: 30,
    });
    await writer.record("r1", { steps: [], results: [{ callId: "c1", status: "ok" }] });
    expect(secretValues).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("reads the secret values again for every batch", async () => {
    const db = fakeDb();
    const secretValues = vi.fn(async () => [FAKE_SECRET]);
    const writer = new RunStepWriter({
      db: db as unknown as RunStepWriterDb,
      secretValues,
      level: "summary",
      retentionDays: 30,
    });
    await writer.record("r1", { steps: [step], results: [] });
    await writer.record("r1", { steps: [{ ...step, callId: "c2" }], results: [] });
    expect(secretValues).toHaveBeenCalledTimes(2);
  });

  it("records nothing when WARDBY_RUN_STEPS is off", async () => {
    const db = fakeDb();
    const writer = new RunStepWriter({
      db: db as unknown as RunStepWriterDb,
      secretValues: async () => [],
      level: "off",
      retentionDays: 30,
    });
    await writer.record("r1", { steps: [step], results: [] });
    expect(db.run.findUnique).not.toHaveBeenCalled();
  });

  it("redacts the caller's extra secret values (the gateway capability) from text, cut text and callIds", async () => {
    const CAPABILITY = "wbFake-Capability-Value-c0ffee12";
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      runStep: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
        createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => void created.push(...data)),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      run: { update: vi.fn(async () => undefined) },
    };
    const db = {
      run: { findUnique: vi.fn(async () => ({ agentId: "a1" })) },
      runStep: {},
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    };
    const writer = new RunStepWriter({
      db: db as unknown as RunStepWriterDb,
      secretValues: async () => [],
      level: "summary",
      retentionDays: 30,
    });
    await writer.record(
      "r1",
      {
        steps: [
          { kind: "said", callId: "said:ok", text: `token ${CAPABILITY} here`, truncated: false },
          { kind: "tool", callId: `call-${CAPABILITY}`, tool: "Bash", text: "ls", truncated: false },
          { kind: "said", callId: "said:cut", text: `run ${CAPABILITY.slice(0, 20)}`, truncated: true },
        ],
        results: [],
      },
      [CAPABILITY],
    );
    expect(created.map((row) => row.callId)).toEqual(["said:ok", "said:cut"]);
    expect(created.map((row) => row.summary)).toEqual(["token [REDACTED] here", "run [REDACTED]"]);
    expect(JSON.stringify(created)).not.toContain(CAPABILITY.slice(0, 6));
  });

  it("never rejects, even when the database does", async () => {
    const db = fakeDb();
    db.$transaction.mockRejectedValueOnce(new Error("connection reset"));
    const warn = vi.fn();
    const writer = new RunStepWriter({
      db: db as unknown as RunStepWriterDb,
      secretValues: async () => [],
      level: "summary",
      retentionDays: 30,
      log: { warn },
    });
    await expect(writer.record("r1", { steps: [step], results: [] })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { runId: "r1", event: "run_steps_write_failed", errorName: "Error" },
      expect.any(String),
    );
  });
});
