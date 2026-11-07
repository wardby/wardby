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
