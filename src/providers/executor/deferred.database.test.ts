import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { DeferredExecutor, drainDeferredRuns } from "./deferred.js";
import type { Executor } from "./types.js";

describe.skipIf(!process.env.DATABASE_URL)("DeferredExecutor and drainDeferredRuns (database)", () => {
  const db = createPrismaClient();
  const agentId = `def-agent-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await db.agent.create({ data: { id: agentId, name: agentId, systemPrompt: "s", model: "m", budgetUsd: 1 } });
  });
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  const pendingRun = () => db.run.create({ data: { agentId, executionManaged: true } });
  const server = () => {
    const calls: string[] = [];
    const executor: Executor = {
      start: vi.fn(async (id: string) => void calls.push(`start:${id}`)),
      stop: vi.fn(async (id: string, reason?: string) => void calls.push(`stop:${id}:${reason}`)),
    };
    return { executor, calls };
  };

  it("records a start instead of starting, and the leader's drain starts it exactly once", async () => {
    const run = await pendingRun();
    await new DeferredExecutor(db).start(run.id);
    expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).startDeferredAt).toBeInstanceOf(Date);

    const { executor, calls } = server();
    // Two drains racing (two replicas): one start.
    await Promise.all([drainDeferredRuns({ db, executor }), drainDeferredRuns({ db, executor })]);
    expect(calls.filter((c) => c === `start:${run.id}`)).toHaveLength(1);
    expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).startDeferredAt).toBeNull();
  });

  it("cancels a never-started run directly, and requests a stop for a running one", async () => {
    const deferred = new DeferredExecutor(db);
    const waiting = await pendingRun();
    await deferred.start(waiting.id);
    await deferred.stop(waiting.id, "sub-agent wait timed out");
    expect(await db.run.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({
      status: "cancelled",
      error: "sub-agent wait timed out",
      startDeferredAt: null,
    });

    const running = await db.run.create({ data: { agentId, status: "running", executionManaged: true } });
    await deferred.stop(running.id, "parent ended");
    const { executor, calls } = server();
    await drainDeferredRuns({ db, executor });
    expect(calls).toContain(`stop:${running.id}:parent ended`);
    expect((await db.run.findUniqueOrThrow({ where: { id: running.id } })).stopRequestedAt).toBeNull();
  });

  it("marks a deferred run failed when the server's executor cannot start it", async () => {
    const run = await pendingRun();
    await new DeferredExecutor(db).start(run.id);
    const failing: Executor = {
      start: async () => {
        throw new Error("native_sandbox_unavailable: no launcher");
      },
      stop: async () => {},
    };
    await drainDeferredRuns({ db, executor: failing });
    await vi.waitFor(async () => {
      expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "failed",
        error: "native_sandbox_unavailable: no launcher",
      });
    });
  });

  it("defers coding resolution and carries no resolver methods", () => {
    const deferred = new DeferredExecutor(db);
    expect(deferred.defersCodingResolution).toBe(true);
    for (const method of [
      "resolveCodingWorkerImage",
      "resolveCodingToolImage",
      "readCodingServiceDeclaration",
      "readCodingRepositoryFile",
      "supportsCodingServices",
    ]) {
      expect(method in deferred).toBe(false);
    }
  });

  describe("beforeStart hook", () => {
    const deferredRun = async () => {
      const run = await pendingRun();
      await new DeferredExecutor(db).start(run.id);
      return run;
    };

    it("does not start the run when the hook returns false", async () => {
      const run = await deferredRun();
      const { executor } = server();
      const beforeStart = vi.fn(async () => false);
      await drainDeferredRuns({ db, executor, beforeStart });
      expect(beforeStart).toHaveBeenCalledWith(run.id);
      expect(executor.start).not.toHaveBeenCalledWith(run.id);
    });

    it("starts the run once when the hook returns true", async () => {
      const run = await deferredRun();
      const { executor } = server();
      await drainDeferredRuns({ db, executor, beforeStart: async () => true });
      await vi.waitFor(() => expect(executor.start).toHaveBeenCalledWith(run.id));
      expect(vi.mocked(executor.start).mock.calls.filter(([id]) => id === run.id)).toHaveLength(1);
    });

    it("fails the run with the hook's error and does not start it", async () => {
      const run = await deferredRun();
      const { executor } = server();
      await drainDeferredRuns({
        db,
        executor,
        beforeStart: async () => {
          throw new Error("coding_worker_image_invalid: x");
        },
      });
      await vi.waitFor(async () => {
        expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
          status: "failed",
          error: "coding_worker_image_invalid: x",
        });
      });
      expect(executor.start).not.toHaveBeenCalledWith(run.id);
    });
  });
});
