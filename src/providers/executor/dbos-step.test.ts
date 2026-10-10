import { afterEach, describe, expect, it, vi } from "vitest";
import { DBOS, Error as DbosErrors } from "@dbos-inc/dbos-sdk";

vi.mock("../../core/runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/runner.js")>()),
  executeRun: vi.fn(),
}));

import { executeRun, RunCancelledError, RunOwnershipLostError, type NativeRunProviders } from "../../core/runner.js";
import { dbosStep, DbosExecutor } from "./dbos.js";

const executeRunMock = vi.mocked(executeRun);

afterEach(() => {
  vi.restoreAllMocks();
  executeRunMock.mockReset();
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
