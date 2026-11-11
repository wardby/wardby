import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitRunCompletedEvent } from "./workflow-run-events.js";
import { setWorkflowEventSink, type WorkflowEventInput } from "./workflow-events.js";

const started = new Date("2026-11-09T07:00:00.000Z");
const finished = new Date("2026-11-09T07:08:00.000Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  agentId: "a1",
  status: "succeeded",
  trigger: "scheduled",
  startedAt: started,
  finishedAt: finished,
  costUsd: { toString: () => "3.211481" },
  error: null,
  parentRunId: null,
  finalText: "SECRET-FINAL-TEXT must never reach the payload",
  agent: { name: "auditor" },
  ...over,
});
const db = (run: unknown, hooksWantingChildren = 0) => ({
  run: { findUnique: vi.fn(async () => run), findMany: vi.fn(async () => []) },
  runHook: { count: vi.fn(async () => hooksWantingChildren) },
  runBudgetEvent: { findMany: vi.fn(async () => []) },
  registryFetch: { findMany: vi.fn(async () => []) },
  registryAuditRecord: { findMany: vi.fn(async () => []) },
});

describe("emitRunCompletedEvent", () => {
  const events: WorkflowEventInput[] = [];
  beforeEach(() => {
    events.length = 0;
    setWorkflowEventSink(async (e) => {
      events.push(e);
    });
  });
  afterEach(() => setWorkflowEventSink(null));

  it("emits run_completed for a finished top-level run, with metadata only", async () => {
    await emitRunCompletedEvent(db(row()) as never, "r1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      dedupeKey: "run_completed:r1",
      runId: "r1",
      agentId: "a1",
      payload: {
        kind: "run_completed",
        agentName: "auditor",
        status: "succeeded",
        trigger: "scheduled",
        parentRunId: null,
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        costUsd: "3.211481",
        reason: null,
        pullRequests: [],
      },
    });
    expect(JSON.stringify(events)).not.toContain("SECRET-FINAL-TEXT");
  });

  it("carries the first line of the error as the reason", async () => {
    await emitRunCompletedEvent(db(row({ status: "failed", error: "boom\ntrace" })) as never, "r1");
    expect(events[0].payload).toMatchObject({ status: "failed", reason: "boom" });
  });

  it("skips a run that is not finished", async () => {
    await emitRunCompletedEvent(db(row({ status: "running" })) as never, "r1");
    expect(events).toEqual([]);
  });

  it("emits for a child run only when a hook on the agent asks for child runs", async () => {
    await emitRunCompletedEvent(db(row({ parentRunId: "p1" }), 0) as never, "r1");
    expect(events).toEqual([]);
    const withHook = db(row({ parentRunId: "p1" }), 1);
    await emitRunCompletedEvent(withHook as never, "r1");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ parentRunId: "p1" });
    expect(withHook.runHook.count).toHaveBeenCalledWith({
      where: {
        agentId: "a1",
        enabled: true,
        runs: "all",
        OR: [{ events: { isEmpty: true } }, { events: { has: "run_completed" } }],
      },
    });
  });

  it("never throws when the run cannot be read", async () => {
    const broken = db(null);
    broken.run.findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(emitRunCompletedEvent(broken as never, "r1")).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });
});
