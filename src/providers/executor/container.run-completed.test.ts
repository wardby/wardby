import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";

vi.mock("../../core/workflow-run-events.js", () => ({ emitRunCompletedEvent: vi.fn(async () => undefined) }));
import { emitRunCompletedEvent } from "../../core/workflow-run-events.js";
import { PrismaContainerExecutionStore } from "./container.js";

// A coding run that ends through the container store emits run_completed once,
// from the write that made it terminal.
function harness(initialStatus: string) {
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
    codingRunRepository: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  db.$transaction = async (fn: any) => fn(db);
  return new PrismaContainerExecutionStore(db as PrismaClient);
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

  it("emits once when completePartially ends a coding run with several repositories", async () => {
    const store = harness("running");
    const input = {
      mainResult: null,
      record: {},
      extras: [],
      error: "partially_published: workspace: failed(workspace); tools: published",
      audit: { failureCategory: "partially_published", diagnosticId: "coding_diag_x" },
    };
    await store.completePartially("run1", input);
    await store.completePartially("run1", input);
    expect(emitRunCompletedEvent).toHaveBeenCalledTimes(1);
  });

  it("does not emit when terminate finds the run already finished", async () => {
    await harness("succeeded").terminate("run1", "failed", "boom");
    expect(emitRunCompletedEvent).not.toHaveBeenCalled();
  });
});
