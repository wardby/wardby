import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { dispatchRun, type DispatchDb } from "./dispatch.js";

function fakeDb(agent: Record<string, any>) {
  let transactionActive = false;
  let runNumber = 0;
  const runs: Record<string, any>[] = [];
  const codingRuns: Record<string, any>[] = [];
  const tasks: Record<string, any>[] = [];
  const db: any = {
    agent: {
      findUnique: async ({ where }: any) => (where.id === agent.id ? agent : null),
      update: async () => agent,
    },
    run: {
      create: async ({ data }: any) => {
        const row = { id: `run_${++runNumber}`, status: "pending", startedAt: new Date(), ...data };
        runs.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const run of runs) {
          if (run.id !== where.id || !where.status.in.includes(run.status)) continue;
          Object.assign(run, data);
          count += 1;
        }
        return { count };
      },
    },
    codingRun: {
      create: async ({ data }: any) => {
        codingRuns.push(data);
        return data;
      },
    },
    task: {
      create: async ({ data }: any) => {
        const now = new Date();
        const row = { id: `task_${tasks.length + 1}`, createdAt: now, updatedAt: now, ...data };
        tasks.push(row);
        return row;
      },
    },
    webhook: {},
    $queryRaw: async () => [{ id: agent.id }],
  };
  db.$transaction = async (callback: (tx: any) => Promise<unknown>) => {
    transactionActive = true;
    try {
      return await callback(db);
    } finally {
      transactionActive = false;
    }
  };
  return {
    db: db as DispatchDb,
    runs,
    codingRuns,
    tasks,
    transactionActive: () => transactionActive,
  };
}

function nativeAgent() {
  return {
    id: "agent_1",
    kind: "native",
    codingProfile: null,
    model: "gpt-5.6-luna",
    budgetUsd: 2,
  };
}

describe("dispatchRun", () => {
  it("persists a managed Run and Task atomically, then starts only after commit", async () => {
    const state = fakeDb(nativeAgent());
    const start = vi.fn(async () => {
      expect(state.transactionActive()).toBe(false);
    });
    const executor: Executor = { start, async stop() {} };

    const result = await dispatchRun({
      db: state.db,
      executor,
      agentId: "agent_1",
      task: { principalId: "principal_1", ttlMs: 60_000 },
    });

    expect(result?.run.executionManaged).toBe(true);
    expect(result?.task?.runId).toBe(result?.run.id);
    expect(state.tasks).toHaveLength(1);
    expect(start).toHaveBeenCalledWith(result?.run.id);
  });

  it("snapshots immutable coding input and reserves the full configured budget", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      budgetUsd: 1.25,
      codingProfile: {
        provider: "codex",
        repository: "openai/reevo",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        allowedEgress: ["registry.npmjs.org"],
        protectedPaths: [".github/workflows/**"],
      },
    };
    const state = fakeDb(agent);
    const executor: Executor = { async start() {}, async stop() {} };
    const now = new Date("2026-09-06T12:00:00.000Z");

    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id, now });
    agent.codingProfile.defaultTask = "mutated later";

    expect(result?.run.executionManaged).toBe(true);
    expect(state.codingRuns).toEqual([
      expect.objectContaining({
        runId: result?.run.id,
        task: "Fix the failing tests",
        repository: "openai/reevo",
        baseRef: "main",
        headRef: `reevo/run-${result?.run.id}`,
        model: "gpt-5.6-luna",
        timeoutSec: 900,
        budgetReservedUsd: 1.25,
      }),
    ]);
  });

  it("resolves and snapshots the worker image for a coding agent, once, immutably", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      budgetUsd: 1.25,
      codingProfile: {
        provider: "codex",
        repository: "openai/reevo",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        allowedEgress: [],
        protectedPaths: [],
        toolchain: "node-python",
        toolchainVersion: "3.12",
        workerImageRef: null,
      },
    };
    const state = fakeDb(agent);
    const resolveCodingWorkerImage = vi.fn(() => "sha256:pythonimage".padEnd(71, "0"));
    const executor: Executor = { async start() {}, async stop() {}, resolveCodingWorkerImage };

    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });

    expect(resolveCodingWorkerImage).toHaveBeenCalledWith({
      toolchain: "node-python",
      toolchainVersion: "3.12",
      workerImageRef: null,
    });
    expect(state.codingRuns).toEqual([
      expect.objectContaining({ runId: result?.run.id, workerImage: "sha256:pythonimage".padEnd(71, "0") }),
    ]);
  });

  it("an unresolvable toolchain rejects dispatchRun's promise (a real transaction rolls the rest back; this fake's $transaction has no rollback semantics, so only the rejection itself is asserted here)", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      budgetUsd: 1.25,
      codingProfile: {
        provider: "codex",
        repository: "openai/reevo",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        allowedEgress: [],
        protectedPaths: [],
        toolchain: "node-cobol",
        toolchainVersion: null,
        workerImageRef: null,
      },
    };
    const state = fakeDb(agent);
    const executor: Executor = {
      async start() {},
      async stop() {},
      resolveCodingWorkerImage: () => {
        throw new Error('No worker image for toolchain "node-cobol"');
      },
    };

    await expect(dispatchRun({ db: state.db, executor, agentId: agent.id })).rejects.toThrow(/No worker image/);
    expect(state.codingRuns).toHaveLength(0);
  });

  it("snapshots bounded manual coding task and base-ref overrides", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      codingProfile: {
        provider: "codex",
        repository: "openai/reevo",
        baseRef: "main",
        defaultTask: "Default task",
        timeoutSec: 900,
        allowedEgress: [],
        protectedPaths: ["CODEOWNERS"],
      },
    };
    const state = fakeDb(agent);
    const result = await dispatchRun({
      db: state.db,
      executor: { async start() {}, async stop() {} },
      agentId: agent.id,
      codingTask: "Fix the auth regression",
      codingBaseRef: "refs/heads/release/2026.09",
    });

    expect(state.codingRuns[0]).toMatchObject({
      runId: result?.run.id,
      task: "Fix the auth regression",
      baseRef: "release/2026.09",
    });
  });

  it("does not persist or launch when a transactional claim is no longer valid", async () => {
    const state = fakeDb(nativeAgent());
    const start = vi.fn(async () => {});
    const result = await dispatchRun({
      db: state.db,
      executor: { start, async stop() {} },
      agentId: "agent_1",
      beforePersist: async () => false,
    });

    expect(result).toBeNull();
    expect(state.runs).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
  });

  it("marks the Run failed when executor start rejects after commit", async () => {
    const state = fakeDb(nativeAgent());
    const result = await dispatchRun({
      db: state.db,
      executor: {
        async start() {
          throw new Error("launcher unavailable");
        },
        async stop() {},
      },
      agentId: "agent_1",
    });
    await vi.waitFor(() => expect(state.runs[0].status).toBe("failed"));
    expect(state.runs[0].id).toBe(result?.run.id);
    expect(state.runs[0].error).toBe("launcher unavailable");
  });
});
