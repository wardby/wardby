import { afterEach, describe, expect, it, vi } from "vitest";
import { DBOS, Error as DbosErrors } from "@dbos-inc/dbos-sdk";

vi.mock("../../core/runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/runner.js")>()),
  executeRun: vi.fn(),
  failNativeRun: vi.fn(),
}));

import {
  executeRun,
  failNativeRun,
  RunCancelledError,
  RunOwnershipLostError,
  type NativeRunProviders,
} from "../../core/runner.js";
import { dbosStep, dbosStepFor, DbosExecutor, stopAwareDbosStep } from "./dbos.js";

const executeRunMock = vi.mocked(executeRun);
const failNativeRunMock = vi.mocked(failNativeRun);

afterEach(() => {
  vi.restoreAllMocks();
  executeRunMock.mockReset();
  failNativeRunMock.mockReset();
});

describe("dbosStep", () => {
  it("translates the SDK's step conflict into RunOwnershipLostError, keeping the step name and the SDK error", async () => {
    const sdkErr = new DbosErrors.DBOSWorkflowConflictError("r1");
    vi.spyOn(DBOS, "runStep").mockRejectedValueOnce(sdkErr);

    const err = await dbosStep("turn:1:llm", async () => "never recorded").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RunOwnershipLostError);
    expect((err as RunOwnershipLostError).step).toBe("turn:1:llm");
    expect((err as RunOwnershipLostError).cause).toBe(sdkErr);
    expect((err as Error).message).toMatch(/^run_ownership_lost: /);
  });

  it("carries the discarded step's usage when the step body ran before the conflict", async () => {
    const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0, costUsd: 0.03 };
    vi.spyOn(DBOS, "runStep").mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      await fn();
      throw new DbosErrors.DBOSWorkflowConflictError("r1");
    });

    const err = await dbosStep("turn:2:llm", async () => ({ usage, text: "discarded" })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RunOwnershipLostError);
    expect((err as RunOwnershipLostError).discardedUsage).toEqual(usage);
  });

  it("passes an unrelated error through unchanged", async () => {
    const boom = new Error("boom");
    vi.spyOn(DBOS, "runStep").mockRejectedValueOnce(boom);

    await expect(dbosStep("turn:1:llm", async () => "x")).rejects.toBe(boom);
  });

  it("still turns a cancellation into RunCancelledError", async () => {
    vi.spyOn(DBOS, "runStep").mockRejectedValueOnce(new DbosErrors.DBOSWorkflowCancelledError("r1"));

    const err = await dbosStep("turn:1:llm", async () => "x").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RunCancelledError);
    expect(err).not.toBeInstanceOf(RunOwnershipLostError);
  });
});

describe("dbosStepFor", () => {
  const dbNaming = (executionWorkflowId: string | null) => ({
    run: { findUnique: vi.fn(async () => ({ executionWorkflowId })) },
  });

  it("turns the cancellation of a workflow the run was forked away from into an ownership loss", async () => {
    const sdkErr = new DbosErrors.DBOSWorkflowCancelledError("r1");
    vi.spyOn(DBOS, "runStep").mockRejectedValueOnce(sdkErr);

    const err = await dbosStepFor(dbNaming("r1@v2") as never, "r1")("turn:2:llm", async () => "x").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RunOwnershipLostError);
    expect((err as RunOwnershipLostError).cause).toBe(sdkErr);
  });

  it.each([
    ["the run's own workflow (never forked)", null, "r1"],
    ["the fork the run names", "r1@v2", "r1@v2"],
  ])("keeps a cancellation of %s a RunCancelledError", async (_label, named, cancelled) => {
    vi.spyOn(DBOS, "runStep").mockRejectedValueOnce(new DbosErrors.DBOSWorkflowCancelledError(cancelled));

    const err = await dbosStepFor(dbNaming(named) as never, "r1")("turn:2:llm", async () => "x").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RunCancelledError);
  });

  it("falls back to a RunCancelledError when the run's workflow id cannot be read", async () => {
    vi.spyOn(DBOS, "runStep").mockRejectedValueOnce(new DbosErrors.DBOSWorkflowCancelledError("r1"));
    const db = { run: { findUnique: vi.fn(async () => Promise.reject(new Error("db down"))) } };

    const err = await dbosStepFor(db as never, "r1")("turn:2:llm", async () => "x").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RunCancelledError);
  });
});

describe("stopAwareDbosStep", () => {
  it("stops before the step, without running it, once the run's row is terminal", async () => {
    const runStep = vi.spyOn(DBOS, "runStep");
    const db = { run: { findUnique: vi.fn(async () => ({ status: "cancelled" })) } };

    const err = await stopAwareDbosStep(db as never, "r1")("turn:2:llm", async () => "x").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RunCancelledError);
    expect((err as Error).message).toBe('Run cancelled: stopped before step "turn:2:llm".');
    expect(runStep).not.toHaveBeenCalled();
  });

  it.each([
    ["the row is drivable", async () => ({ status: "running" })],
    ["the row cannot be read", async () => Promise.reject(new Error("db down"))],
  ])("runs the step when %s", async (_label, findUnique) => {
    vi.spyOn(DBOS, "runStep").mockResolvedValueOnce("recorded");
    const db = { run: { findUnique: vi.fn(findUnique) } };

    await expect(stopAwareDbosStep(db as never, "r1")("turn:2:llm", async () => "x")).resolves.toBe("recorded");
  });

  // A taken-over original, as soon as the run names its fork: whether or not the takeover's cancel
  // landed, and also after the fork already finished the run (no second settle from the original).
  it.each(["running", "succeeded"])(
    "stops a workflow the run no longer names (row %s) as an ownership loss, without running the step",
    async (status) => {
      const runStep = vi.spyOn(DBOS, "runStep");
      vi.spyOn(DBOS, "workflowID", "get").mockReturnValue("r1");
      const db = { run: { findUnique: vi.fn(async () => ({ status, executionWorkflowId: "r1@v2" })) } };

      const err = await stopAwareDbosStep(db as never, "r1")("turn:2:llm", async () => "x").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RunOwnershipLostError);
      expect(err).not.toBeInstanceOf(RunCancelledError);
      expect(runStep).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a fork whose record failed (the run names no fork)", null, "r1@v2"],
    ["the fork the run names", "r1@v2", "r1@v2"],
  ])("runs the step for %s", async (_label, named, own) => {
    vi.spyOn(DBOS, "runStep").mockResolvedValueOnce("recorded");
    vi.spyOn(DBOS, "workflowID", "get").mockReturnValue(own);
    const db = { run: { findUnique: vi.fn(async () => ({ status: "running", executionWorkflowId: named })) } };

    await expect(stopAwareDbosStep(db as never, "r1")("turn:2:llm", async () => "x")).resolves.toBe("recorded");
  });

  it("hands concurrent steps to DBOS in call order even when their row reads finish out of order", async () => {
    // DBOS numbers a step when runStep is called; a replay of parallel delegations matches by number.
    const order: string[] = [];
    vi.spyOn(DBOS, "runStep").mockImplementation(async (_fn: unknown, config?: { name?: string }) => {
      order.push(config?.name ?? "?");
      return "recorded";
    });
    const reads = [30, 0];
    const db = {
      run: {
        findUnique: vi.fn(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ status: "running", executionWorkflowId: null }), reads.shift()),
            ),
        ),
      },
    };
    const step = stopAwareDbosStep(db as never, "r1");

    await Promise.all([step("turn:1:tool:0", async () => "a"), step("turn:1:tool:1", async () => "b")]);

    expect(order).toEqual(["turn:1:tool:0", "turn:1:tool:1"]);
  });
});

describe("DbosExecutor.runInsideWorkflow", () => {
  function executor() {
    const db = { run: { update: vi.fn(async () => ({})) } };
    return new DbosExecutor(
      {} as NativeRunProviders,
      { systemDatabaseUrl: "postgresql://unused", schemaName: "dbos_test", executorId: "unit" },
      db as never,
      60_000,
    );
  }

  it("hands the SDK's own conflict error back to DBOS for an ownership loss", async () => {
    const sdkErr = new DbosErrors.DBOSWorkflowConflictError("r1");
    executeRunMock.mockRejectedValueOnce(new RunOwnershipLostError("turn:1:llm", { cause: sdkErr }));

    await expect(executor().runInsideWorkflow("r1")).rejects.toBe(sdkErr);
  });

  it("hands a forked-from workflow's own cancellation back to DBOS as itself", async () => {
    const sdkErr = new DbosErrors.DBOSWorkflowCancelledError("r1");
    executeRunMock.mockRejectedValueOnce(new RunOwnershipLostError("turn:2:llm", { cause: sdkErr }));

    await expect(executor().runInsideWorkflow("r1")).rejects.toBe(sdkErr);
  });

  it("raises a fresh SDK conflict error when the ownership loss has no SDK cause", async () => {
    executeRunMock.mockRejectedValueOnce(new RunOwnershipLostError("load"));

    const err = await executor()
      .runInsideWorkflow("r2")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DbosErrors.DBOSWorkflowConflictError);
    expect((err as Error).message).toBe("Conflicting WF ID r2");
  });

  it("rethrows any other error unchanged", async () => {
    const boom = new Error("boom");
    executeRunMock.mockRejectedValueOnce(boom);

    await expect(executor().runInsideWorkflow("r3")).rejects.toBe(boom);
  });
});

describe("DbosExecutor.stop", () => {
  function launchedExecutor(row: { status: string; executionWorkflowId: string | null }) {
    const db = { run: { findUnique: vi.fn(async () => row) } };
    const executor = new DbosExecutor(
      {} as NativeRunProviders,
      { systemDatabaseUrl: "postgresql://unused", schemaName: "dbos_test", executorId: "unit" },
      db as never,
      60_000,
    );
    // stop() launches DBOS only when this executor has not; the cancel itself is stubbed.
    (executor as unknown as { launched: boolean }).launched = true;
    return executor;
  }

  it("still cancels the workflow when the terminal write's settle throws", async () => {
    failNativeRunMock.mockRejectedValueOnce(new Error("closing the review check failed"));
    const cancel = vi.spyOn(DBOS, "cancelWorkflow").mockResolvedValue(undefined);

    await expect(
      launchedExecutor({ status: "running", executionWorkflowId: null }).stop("r1", "operator stop"),
    ).rejects.toThrow("closing the review check failed");

    expect(cancel).toHaveBeenCalledWith("r1");
  });

  it("still cancels the run's own workflow when the database cannot be read, and rethrows the read's error", async () => {
    const executor = launchedExecutor({ status: "running", executionWorkflowId: null });
    const down = new Error("db down");
    (executor as unknown as { db: { run: { findUnique: () => Promise<never> } } }).db.run.findUnique = () =>
      Promise.reject(down);
    const cancel = vi.spyOn(DBOS, "cancelWorkflow").mockRejectedValue(new Error("system database down too"));

    await expect(executor.stop("r1", "operator stop")).rejects.toBe(down);

    expect(cancel).toHaveBeenCalledWith("r1");
  });
});
