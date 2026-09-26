import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { MAX_CODING_TASK_BYTES } from "../coding/protocol.js";
import { dispatchRun, isSerializationConflict, type DispatchDb } from "./dispatch.js";

interface FakeBudget {
  /** The agent's budget group (ids must match agent.budgetGroupId). */
  group?: Record<string, any>;
  /** Rows the group-spend query sees (agentId, status, costUsd, startedAt, heartbeatAt, codingRun). */
  groupRuns?: Record<string, any>[];
}

function fakeDb(agent: Record<string, any>, seedCodingRuns: Record<string, any>[] = [], budget: FakeBudget = {}) {
  let transactionActive = false;
  const rawStatements: string[] = [];
  let runNumber = 0;
  const runs: Record<string, any>[] = [];
  const codingRuns: Record<string, any>[] = [...seedCodingRuns];
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
      findMany: async ({ where }: any) =>
        (budget.groupRuns ?? []).filter(
          (r) => where.agentId?.in.includes(r.agentId) && r.startedAt >= where.startedAt.gte,
        ),
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
      findUnique: async ({ where }: any) => codingRuns.find((row) => row.runId === where.runId) ?? null,
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
    budgetGroup: {
      findUnique: async ({ where }: any) => (budget.group && where.id === budget.group.id ? budget.group : null),
    },
    $queryRaw: async () => [{ id: agent.id }],
    $executeRawUnsafe: async (sql: string) => {
      rawStatements.push(sql);
      return 0;
    },
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
    rawStatements,
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

  it("persists triggeredById on the run, and null when the caller gives none", async () => {
    const executor: Executor = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const state = fakeDb(nativeAgent());
    await dispatchRun({ db: state.db, executor, agentId: "agent_1", triggeredById: "p-trigger" });
    await dispatchRun({ db: state.db, executor, agentId: "agent_1", trigger: "scheduled" });
    expect(state.runs.map((run) => run.triggeredById)).toEqual(["p-trigger", null]);
  });

  it("no longer writes allowedEgress onto the coding run", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      budgetUsd: 1.25,
      codingProfile: {
        provider: "codex",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        protectedPaths: [],
      },
    };
    const state = fakeDb(agent);
    await dispatchRun({ db: state.db, executor: { async start() {}, async stop() {} }, agentId: agent.id });
    expect(state.codingRuns[0]).not.toHaveProperty("allowedEgress");
  });

  describe("budget groups (E-01)", () => {
    const groupedCodingAgent = () => ({
      ...nativeAgent(),
      kind: "coding",
      budgetUsd: 2,
      budgetGroupId: "group_1",
      codingProfile: {
        provider: "codex",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        protectedPaths: [],
      },
    });
    const group = (dailyBudgetUsd: number) => ({
      id: "group_1",
      name: "team",
      dailyBudgetUsd,
      weeklyBudgetUsd: null,
      monthlyBudgetUsd: null,
      warnThresholdRatio: 0.8,
      agents: [{ id: "agent_1", budgetUsd: 2 }],
    });
    const spent = (costUsd: number) => ({
      id: "earlier",
      agentId: "agent_1",
      status: "succeeded",
      costUsd,
      startedAt: new Date(),
      heartbeatAt: null,
      codingRun: null,
    });

    it("refuses a top-level grouped coding run once the group is spent: no CodingRun, never started", async () => {
      const state = fakeDb(groupedCodingAgent(), [], { group: group(5), groupRuns: [spent(5)] });
      const start = vi.fn(async () => {});

      const result = await dispatchRun({ db: state.db, executor: { start, async stop() {} }, agentId: "agent_1" });

      expect(result?.run.status).toBe("refused");
      expect(result?.run.error).toMatch(/^budget_group_exhausted:day\b/);
      expect(result?.run.finishedAt).toBeInstanceOf(Date);
      expect(state.codingRuns).toHaveLength(0);
      expect(start).not.toHaveBeenCalled();
      expect(state.rawStatements).toEqual(['LOCK TABLE "BudgetGroup" IN SHARE ROW EXCLUSIVE MODE']);
    });

    it("caps a top-level grouped coding run's reservation at the group's remainder", async () => {
      const state = fakeDb(groupedCodingAgent(), [], { group: group(5), groupRuns: [spent(4.25)] });
      const start = vi.fn(async () => {});

      const result = await dispatchRun({ db: state.db, executor: { start, async stop() {} }, agentId: "agent_1" });

      expect(result?.run.status).toBe("pending");
      expect(state.codingRuns[0].budgetReservedUsd).toBeCloseTo(0.75, 6);
      expect(start).toHaveBeenCalledWith(result?.run.id);
    });

    it("treats a sub-micro-dollar remainder as exhausted rather than reserving $0", async () => {
      const state = fakeDb(groupedCodingAgent(), [], { group: group(5), groupRuns: [spent(4.9999997)] });

      const result = await dispatchRun({
        db: state.db,
        executor: { async start() {}, async stop() {} },
        agentId: "agent_1",
      });

      expect(result?.run.status).toBe("refused");
      expect(state.codingRuns).toHaveLength(0);
    });

    it("takes no group lock for an ungrouped coding agent", async () => {
      const state = fakeDb({ ...groupedCodingAgent(), budgetGroupId: null });
      await dispatchRun({ db: state.db, executor: { async start() {}, async stop() {} }, agentId: "agent_1" });
      expect(state.rawStatements).toEqual([]);
      expect(state.codingRuns[0].budgetReservedUsd).toBe(2);
    });
  });

  it("snapshots immutable coding input and reserves the full configured budget", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      budgetUsd: 1.25,
      codingProfile: {
        provider: "codex",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
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
        repository: "openai/wardby",
        baseRef: "main",
        headRef: `wardby/run-${result?.run.id}`,
        model: "gpt-5.6-luna",
        timeoutSec: 900,
        budgetReservedUsd: 1.25,
      }),
    ]);
  });

  it("copies the profile's per-agent workspaceDiskMb onto the run at dispatch", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      budgetUsd: 1.25,
      codingProfile: {
        provider: "codex",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        protectedPaths: [],
        workspaceDiskMb: 8192,
      },
    };
    const state = fakeDb(agent);
    const executor: Executor = { async start() {}, async stop() {} };

    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });

    expect(state.codingRuns).toEqual([expect.objectContaining({ runId: result?.run.id, workspaceDiskMb: 8192 })]);
  });

  it("copies the profile's collectExclude onto the run at dispatch", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      budgetUsd: 1.25,
      codingProfile: {
        provider: "codex",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        protectedPaths: [],
        collectExclude: ["web/dist"],
      },
    };
    const state = fakeDb(agent);
    const executor: Executor = { async start() {}, async stop() {} };

    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });

    expect(state.codingRuns).toEqual([
      expect.objectContaining({ runId: result?.run.id, collectExclude: ["web/dist"] }),
    ]);
  });

  it("copies the profile's packageAllowlist and packagePolicy onto the run at dispatch", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      budgetUsd: 1.25,
      codingProfile: {
        provider: "codex",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        protectedPaths: [],
        packageAllowlist: { npm: ["react"] },
        packagePolicy: { minReleaseAgeDays: 7 },
      },
    };
    const state = fakeDb(agent);
    const executor: Executor = { async start() {}, async stop() {} };

    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });

    expect(state.codingRuns).toEqual([
      expect.objectContaining({
        runId: result?.run.id,
        packageAllowlist: { npm: ["react"] },
        packagePolicy: { minReleaseAgeDays: 7 },
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
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
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
      provider: "codex",
      toolchain: "node-python",
      toolchainVersion: "3.12",
      workerImageRef: null,
    });
    expect(state.codingRuns).toEqual([
      expect.objectContaining({ runId: result?.run.id, workerImage: "sha256:pythonimage".padEnd(71, "0") }),
    ]);
  });

  it("passes the Claude provider to image resolution and snapshots it", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      model: "claude-sonnet-5",
      codingProfile: {
        provider: "claude-code",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        protectedPaths: [],
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: null,
      },
    };
    const state = fakeDb(agent);
    const resolveCodingWorkerImage = vi.fn(() => "sha256:claudeimage".padEnd(71, "0"));
    const executor: Executor = { async start() {}, async stop() {}, resolveCodingWorkerImage };

    await dispatchRun({ db: state.db, executor, agentId: agent.id });

    expect(resolveCodingWorkerImage).toHaveBeenCalledWith({
      provider: "claude-code",
      toolchain: "node",
      toolchainVersion: null,
      workerImageRef: null,
    });
    expect(state.codingRuns).toEqual([expect.objectContaining({ provider: "claude-code" })]);
  });

  it("rejects a model that does not belong to the selected coding provider", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      model: "gpt-5.6-luna",
      codingProfile: {
        provider: "claude-code",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        protectedPaths: [],
      },
    };

    await expect(
      dispatchRun({ db: fakeDb(agent).db, executor: { async start() {}, async stop() {} }, agentId: agent.id }),
    ).rejects.toThrow(/not supported by coding provider/);
  });

  it("an unresolvable toolchain rejects dispatchRun's promise (a real transaction rolls the rest back; this fake's $transaction has no rollback semantics, so only the rejection itself is asserted here)", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      budgetUsd: 1.25,
      codingProfile: {
        provider: "codex",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
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
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Default task",
        timeoutSec: 900,
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

  describe("a coding agent's own instructions", () => {
    function codingAgent(systemPrompt: string | null) {
      return {
        ...nativeAgent(),
        kind: "coding",
        systemPrompt,
        codingProfile: {
          provider: "codex",
          repository: "openai/wardby",
          baseRef: "main",
          defaultTask: "Default task",
          timeoutSec: 900,
          protectedPaths: ["CODEOWNERS"],
        },
      };
    }
    const executor: Executor = { async start() {}, async stop() {} };

    it("reach the worker ahead of the request, since the worker sees only the task text", async () => {
      const agent = codingAgent("Run python -m pytest before finishing.");
      const state = fakeDb(agent);
      await dispatchRun({ db: state.db, executor, agentId: agent.id, codingTask: "Add 20 jokes" });

      expect(state.codingRuns[0].task).toBe(
        "Standing instructions for this coding agent:\nRun python -m pytest before finishing.\n\nRequest:\nAdd 20 jokes",
      );
    });

    it("leave the task unchanged when the agent has none", async () => {
      for (const systemPrompt of [null, "", "   "]) {
        const agent = codingAgent(systemPrompt);
        const state = fakeDb(agent);
        await dispatchRun({ db: state.db, executor, agentId: agent.id, codingTask: "Add 20 jokes" });
        expect(state.codingRuns[0].task).toBe("Add 20 jokes");
      }
    });

    it("refuse a combination over the task limit instead of truncating either part", async () => {
      const agent = codingAgent("x".repeat(MAX_CODING_TASK_BYTES - 10));
      const state = fakeDb(agent);
      await expect(
        dispatchRun({ db: state.db, executor, agentId: agent.id, codingTask: "Add 20 jokes" }),
      ).rejects.toThrow(/exceed the 16384-byte coding task limit/);
      expect(state.codingRuns).toEqual([]);
    });
  });

  it("runs afterPersist inside the transaction before the executor starts", async () => {
    const state = fakeDb(nativeAgent());
    const order: string[] = [];
    const executor: Executor = {
      start: async () => void order.push("start"),
      async stop() {},
    };

    await dispatchRun({
      db: state.db,
      executor,
      agentId: "agent_1",
      trigger: "host_event",
      taskOverride: "Review pull request #7",
      afterPersist: async (_tx, run) => {
        order.push(`after:${run.trigger}`);
      },
    });

    expect(order).toEqual(["after:host_event", "start"]);
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

  describe("revision-in-place (continuesCodingRunId)", () => {
    function codingAgent(overrides: Record<string, any> = {}) {
      return {
        ...nativeAgent(),
        kind: "coding",
        budgetUsd: 1.25,
        codingProfile: {
          provider: "codex",
          repository: "openai/wardby",
          baseRef: "main",
          defaultTask: "Follow up on review comments",
          timeoutSec: 900,
          protectedPaths: ["CODEOWNERS"],
        },
        ...overrides,
      };
    }

    function openPrCodingRun(runId: string, overrides: Record<string, any> = {}) {
      return {
        runId,
        repository: "openai/wardby",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        rootCodingRunId: null,
        result: {
          schemaVersion: 1,
          outcome: "pull_request_opened",
          repository: "openai/wardby",
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          commitSha: "a".repeat(40),
          pullRequestUrl: "https://github.com/openai/wardby/pull/22",
          pullRequestNumber: 22,
          summary: "Opened the PR",
          tests: [],
          usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        },
        ...overrides,
      };
    }

    it("resolves the root run's branch and links rootCodingRunId, even across agents", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [openPrCodingRun("root_run")]);

      const result = await dispatchRun({
        db: state.db,
        executor: { async start() {}, async stop() {} },
        agentId: agent.id,
        continuesCodingRunId: "root_run",
      });

      expect(state.codingRuns).toContainEqual(
        expect.objectContaining({
          runId: result?.run.id,
          baseRef: "main",
          headRef: "wardby/run-root_run",
          rootCodingRunId: "root_run",
        }),
      );
    });

    it("resolves through an intermediate continuation straight to the true root (flat, not chained)", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [
        openPrCodingRun("root_run"),
        openPrCodingRun("round_2_run", { rootCodingRunId: "root_run", headRef: "wardby/run-root_run" }),
      ]);

      const result = await dispatchRun({
        db: state.db,
        executor: { async start() {}, async stop() {} },
        agentId: agent.id,
        continuesCodingRunId: "round_2_run",
      });

      expect(state.codingRuns).toContainEqual(
        expect.objectContaining({ runId: result?.run.id, rootCodingRunId: "root_run" }),
      );
    });

    it("rejects continuing a coding run from a different repository", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [openPrCodingRun("root_run", { repository: "openai/other-repo" })]);

      await expect(
        dispatchRun({
          db: state.db,
          executor: { async start() {}, async stop() {} },
          agentId: agent.id,
          continuesCodingRunId: "root_run",
        }),
      ).rejects.toThrow(/different repository/);
    });

    it("rejects continuing a coding run that never opened a pull request", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [
        openPrCodingRun("root_run", {
          result: {
            schemaVersion: 1,
            outcome: "no_changes",
            repository: "openai/wardby",
            baseRef: "main",
            summary: "Nothing to do",
            tests: [],
            usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          },
        }),
      ]);

      await expect(
        dispatchRun({
          db: state.db,
          executor: { async start() {}, async stop() {} },
          agentId: agent.id,
          continuesCodingRunId: "root_run",
        }),
      ).rejects.toThrow(/never opened a pull request/);
    });

    it("rejects an unknown continuesCodingRunId", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, []);

      await expect(
        dispatchRun({
          db: state.db,
          executor: { async start() {}, async stop() {} },
          agentId: agent.id,
          continuesCodingRunId: "does_not_exist",
        }),
      ).rejects.toThrow(/unknown coding run/);
    });

    it("rejects combining continuesCodingRunId with codingBaseRef", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [openPrCodingRun("root_run")]);

      await expect(
        dispatchRun({
          db: state.db,
          executor: { async start() {}, async stop() {} },
          agentId: agent.id,
          continuesCodingRunId: "root_run",
          codingBaseRef: "refs/heads/other",
        }),
      ).rejects.toThrow(/cannot be combined/);
    });

    it("rejects continuesCodingRunId for a native agent", async () => {
      const state = fakeDb(nativeAgent());

      await expect(
        dispatchRun({
          db: state.db,
          executor: { async start() {}, async stop() {} },
          agentId: "agent_1",
          continuesCodingRunId: "root_run",
        }),
      ).rejects.toThrow(/Coding overrides cannot be supplied/);
    });
  });
});

describe("isSerializationConflict", () => {
  const adapterP2010 = (originalCode: string) => ({
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode } } },
  });

  it.each([
    ["P2034", { code: "P2034" }],
    ["P2010 wrapping a 40001 serialization failure", adapterP2010("40001")],
    ["P2010 wrapping a 40P01 deadlock", adapterP2010("40P01")],
    ["legacy P2010 with meta.code 40001", { code: "P2010", meta: { code: "40001" } }],
    ["commit-time DriverAdapterError 40001", { name: "DriverAdapterError", cause: { originalCode: "40001" } }],
    ["commit-time DriverAdapterError 40P01", { name: "DriverAdapterError", cause: { originalCode: "40P01" } }],
  ])("retries %s", (_label, err) => {
    expect(isSerializationConflict(err)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "40001"],
    ["a unique violation", { code: "P2002" }],
    ["P2010 for another SQLSTATE", adapterP2010("23505")],
    ["P2010 without adapter details", { code: "P2010", meta: {} }],
    ["DriverAdapterError for another SQLSTATE", { name: "DriverAdapterError", cause: { originalCode: "23505" } }],
    ["another error carrying 40001", { name: "Error", cause: { originalCode: "40001" } }],
  ])("does not retry %s", (_label, err) => {
    expect(isSerializationConflict(err)).toBe(false);
  });
});
