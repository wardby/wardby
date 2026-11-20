import { describe, expect, it, vi } from "vitest";
import { logRunFinished, runFinishedLog, type RunFinishedDb } from "./run-finished.js";

const FAKE_SECRET = "sk-fake-run-finished-secret-0123456789";

function storedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    agentId: "agent-1",
    parentRunId: null,
    trigger: "scheduled",
    status: "budget_exhausted",
    costUsd: { toString: () => "1.25" },
    tokensIn: 1200,
    tokensOut: 340,
    startedAt: new Date("2026-11-04T10:00:00Z"),
    finishedAt: new Date("2026-11-04T10:02:30Z"),
    // Present on the row, never selected into the line.
    error: `upstream said ${FAKE_SECRET}`,
    finalText: `final answer quoting ${FAKE_SECRET}`,
    agent: { name: "nightly-triage", budgetUsd: 2, budgetGroup: { name: "platform" } },
    codingRun: null,
    ...overrides,
  };
}

function fakeDb(run: unknown, limit: string | null = null): RunFinishedDb {
  return {
    run: { findUnique: vi.fn().mockResolvedValue(run) },
    runBudgetEvent: { findFirst: vi.fn().mockResolvedValue(limit ? { limit } : null) },
  } as unknown as RunFinishedDb;
}

describe("run.finished log line", () => {
  it("describes a native run with its agent budget, group and the limit that stopped it", async () => {
    expect(await runFinishedLog(fakeDb(storedRun(), "day"), "run-1")).toEqual({
      event: "run.finished",
      runId: "run-1",
      agentId: "agent-1",
      agentName: "nightly-triage",
      runKind: "native",
      parentRunId: null,
      trigger: "scheduled",
      status: "budget_exhausted",
      costUsd: 1.25,
      budgetUsd: 2,
      budgetGroup: "platform",
      budgetLimit: "day",
      tokensIn: 1200,
      tokensOut: 340,
      durationMs: 150_000,
    });
  });

  it("uses a coding run's own limit, falling back to what it reserved", async () => {
    const limited = storedRun({ codingRun: { budgetReservedUsd: 3, budgetLimitUsd: 3.6 } });
    const reserved = storedRun({
      codingRun: { budgetReservedUsd: 3, budgetLimitUsd: null },
      agent: { name: "a", budgetUsd: 9, budgetGroup: null },
    });
    const a = await runFinishedLog(fakeDb(limited), "run-1");
    const b = await runFinishedLog(fakeDb(reserved), "run-1");
    expect(a).toMatchObject({ runKind: "coding", budgetUsd: 3.6 });
    expect(b).toMatchObject({ runKind: "coding", budgetUsd: 3 });
    expect(b).not.toHaveProperty("budgetGroup");
    expect(b).not.toHaveProperty("budgetLimit");
  });

  it("never carries the run's error or final text", async () => {
    const info = vi.fn();
    await logRunFinished(fakeDb(storedRun()), "run-1", { info });
    expect(info).toHaveBeenCalledOnce();
    expect(JSON.stringify(info.mock.calls)).not.toContain(FAKE_SECRET);
  });

  it("logs nothing for a missing run and never throws on a failed read", async () => {
    const info = vi.fn();
    await logRunFinished(fakeDb(null), "run-1", { info });
    const failing = {
      run: { findUnique: vi.fn().mockRejectedValue(new Error(`db down ${FAKE_SECRET}`)) },
      runBudgetEvent: { findFirst: vi.fn() },
    } as unknown as RunFinishedDb;
    await expect(logRunFinished(failing, "run-1", { info })).resolves.toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });
});
