import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";

vi.mock("../../core/workflow-run-events.js", () => ({ emitRunCompletedEvent: vi.fn(async () => undefined) }));
import { emitRunCompletedEvent } from "../../core/workflow-run-events.js";
import { PrismaContainerExecutionStore } from "./container.js";

// A coding run that ends through the container store emits run_completed once,
// from the write that made it terminal.
function harness(initialStatus: string, onTerminal?: (runId: string) => void) {
  const row = {
    id: "run1",
    agentId: "a1",
    status: initialStatus,
    codingRun: { runId: "run1", result: null as unknown },
  };
  const db: any = {
    run: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!where.status.in.includes(row.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: any) => Object.assign(row, data)),
      findUnique: vi.fn(async () => row),
    },
    codingRun: { update: vi.fn(async ({ data }: any) => Object.assign(row.codingRun, data)) },
  };
  db.$transaction = async (fn: any) => fn(db);
  return new PrismaContainerExecutionStore(db as PrismaClient, onTerminal ? { onTerminal } : {});
}

describe("PrismaContainerExecutionStore run_completed", () => {
  beforeEach(() => vi.mocked(emitRunCompletedEvent).mockClear());

  it("emits when complete finishes a coding run", async () => {
    await harness("running").complete("run1", "succeeded", { summary: "done" } as never);
    expect(emitRunCompletedEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitRunCompletedEvent).mock.calls[0][1]).toBe("run1");
  });

  it("emits when terminate ends a running coding run", async () => {
    await harness("running").terminate("run1", "failed", "boom");
    expect(emitRunCompletedEvent).toHaveBeenCalledTimes(1);
  });

  it("does not emit when terminate finds the run already finished", async () => {
    await harness("succeeded").terminate("run1", "failed", "boom");
    expect(emitRunCompletedEvent).not.toHaveBeenCalled();
  });

  it("calls onTerminal once from the write that made the run terminal, and survives a throwing hook", async () => {
    const onTerminal = vi.fn();
    await harness("running", onTerminal).complete("run1", "succeeded", { summary: "done" } as never);
    await harness("running", onTerminal).terminate("run1", "failed", "boom");
    await harness("succeeded", onTerminal).terminate("run1", "failed", "boom");
    expect(onTerminal.mock.calls).toEqual([["run1"], ["run1"]]);
    const throwing = () => {
      throw new Error("hook");
    };
    await expect(harness("running", throwing).terminate("run1", "failed", "boom")).resolves.toBe(true);
  });
});
