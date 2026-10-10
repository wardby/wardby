import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitVcsProvider } from "../providers/vcs/git.js";
import { LocalRemote } from "../providers/vcs/local-remote.js";
import type { Executor } from "../providers/executor/types.js";
import { MAX_CODING_TASK_BYTES } from "../coding/protocol.js";
import { BUILTIN_CODING_SERVICES } from "../coding/services/builtins.js";
import { resolvedFromDefinition } from "../coding/services/catalog.js";
import {
  DECLARATION_UNAVAILABLE_SENTENCE,
  LAUNCHER_UNSUPPORTED_SENTENCE,
  SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE,
} from "../coding/services/wording.js";
import type { AttributionIntent } from "./attribution.js";
import { dispatchRun, isSerializationConflict, isTransactionUnavailable, type DispatchDb } from "./dispatch.js";
import { CatalogStore, installModelCatalog, uninstallModelCatalogForTests } from "../providers/llm/catalog-store.js";
import { SHIPPED_CATALOG } from "../providers/llm/catalog-shipped.js";
import type { SelfDefectSink } from "./self-defects.js";

interface FakeBudget {
  /** The agent's budget group (ids must match agent.budgetGroupId). */
  group?: Record<string, any>;
  /** Rows the group-spend query sees (agentId, status, costUsd, startedAt, heartbeatAt, codingRun). */
  groupRuns?: Record<string, any>[];
  /** Existing runs by id (for walking a parent chain): { id: { parentRunId } }. */
  ancestors?: Record<string, { parentRunId: string | null }>;
  /** Existing runs' attributions: { runId: issueKey } (provider jira). */
  attributedRuns?: Record<string, string>;
  /** Pre-attribution runs with a RunIssueStatus: { runId: issueKey } (provider jira). */
  issueRuns?: Record<string, string>;
}

function fakeDb(
  agent: Record<string, any>,
  seedCodingRuns: Record<string, any>[] = [],
  budget: FakeBudget = {},
  catalog: Record<string, any>[] = [],
) {
  let transactionActive = false;
  const rawStatements: string[] = [];
  let runNumber = 0;
  const runs: Record<string, any>[] = [];
  const codingRuns: Record<string, any>[] = [...seedCodingRuns];
  const tasks: Record<string, any>[] = [];
  const workItems = new Map<string, Record<string, any>>();
  const attributions = new Map<string, Record<string, any>>();
  const ensureItem = (provider: string, key: string, fields: Record<string, any> = {}) => {
    const id = `wi_${provider}_${key}`;
    const row = { id, provider, key, parentKey: null, ...workItems.get(id), ...fields };
    workItems.set(id, row);
    return row;
  };
  for (const [runId, key] of Object.entries(budget.attributedRuns ?? {})) {
    attributions.set(runId, {
      runId,
      workItemId: ensureItem("jira", key).id,
      parentKeyAtRun: null,
      source: "issue_event",
    });
  }
  const db: any = {
    agent: {
      findUnique: async ({ where }: any) => (where.id === agent.id ? agent : null),
      findUniqueOrThrow: async () => agent,
      update: async () => agent,
    },
    run: {
      create: async ({ data }: any) => {
        const row = { id: `run_${++runNumber}`, status: "pending", startedAt: new Date(), ...data };
        runs.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => {
        const row = runs.find((r) => r.id === where.id) ?? (budget.ancestors ?? {})[where.id];
        return row ? { parentRunId: row.parentRunId ?? null } : null;
      },
      findUniqueOrThrow: async ({ where }: any) => {
        const row = (budget.ancestors ?? {})[where.id] ?? runs.find((r) => r.id === where.id);
        if (!row) throw new Error(`no run ${where.id}`);
        return { id: where.id, agentId: agent.id, startedAt: new Date(0), costUsd: 0, ...row };
      },
      findMany: async ({ where }: any) =>
        where.parentRunId
          ? Object.entries(budget.ancestors ?? {})
              .filter(([, r]) => where.parentRunId.in.includes(r.parentRunId))
              .map(([id]) => ({ id }))
          : where.id?.in
            ? where.id.in.map(() => ({ costUsd: 0 }))
            : (budget.groupRuns ?? []).filter(
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
    runAttribution: {
      findUnique: async ({ where }: any) => {
        const row = attributions.get(where.runId);
        return row ? { ...row, workItem: workItems.get(row.workItemId) } : null;
      },
      create: async ({ data }: any) => {
        attributions.set(data.runId, data);
        return data;
      },
    },
    runIssueStatus: {
      findUnique: async ({ where }: any) => {
        const key = (budget.issueRuns ?? {})[where.runId];
        return key ? { provider: "jira", issueKey: key } : null;
      },
    },
    workItem: {
      upsert: async ({ where, create, update }: any) => {
        const { provider, key } = where.provider_key;
        const exists = workItems.has(`wi_${provider}_${key}`);
        return ensureItem(provider, key, exists ? update : create);
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
    codingService: {
      findMany: async ({ where }: any) =>
        catalog.filter((row) => where.OR.some((key: any) => key.name === row.name && key.version === row.version)),
    },
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
    attributions,
    workItems,
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
    // Continuation's same-owner check (checkContinuation): most fixtures
    // simulate one owner's deployment, so a continuation root's mock row
    // carries the same ownerId by default (see openPrCodingRun/priorPrRun).
    ownerId: "owner_1",
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

  it("calls onPersisted once with the committed run, before the executor starts it", async () => {
    const state = fakeDb(nativeAgent());
    const events: string[] = [];
    const onPersisted = vi.fn((run: { id: string }) => {
      expect(state.transactionActive()).toBe(false);
      events.push(`persisted:${run.id}`);
    });
    const start = vi.fn(async (runId: string) => {
      events.push(`start:${runId}`);
    });
    const result = await dispatchRun({
      db: state.db,
      executor: { start, async stop() {} },
      agentId: "agent_1",
      awaitExecution: true,
      onPersisted,
    });
    expect(onPersisted).toHaveBeenCalledTimes(1);
    expect(events).toEqual([`persisted:${result?.run.id}`, `start:${result?.run.id}`]);
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

  it("records the coding run's catalog entry on the run row at dispatch", async () => {
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
    expect(state.runs[0].pricingVersion).toBe("shipped:2026-10-08");
    expect(state.runs[0].pricingSnapshot.modelId).toBe(agent.model);
  });

  it("fails a coding dispatch for a disabled model with a terminal run carrying model_unavailable, never started", async () => {
    const rows = [
      {
        ...SHIPPED_CATALOG.find((e) => e.modelId === "gpt-5.6-luna")!,
        enabled: false,
        sourceUrl: "https://example.com/pricing",
        updatedBy: "admin",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const store = new CatalogStore({ modelCatalogEntry: { findMany: async () => rows } }, { intervalMs: 60_000 });
    await store.refreshNow();
    installModelCatalog(store);
    try {
      const agent = {
        ...nativeAgent(),
        kind: "coding",
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
      const start = vi.fn(async () => undefined);
      const beforePersist = vi.fn(async () => true);
      const afterPersist = vi.fn(async () => undefined);
      const now = new Date("2026-10-03T12:00:00.000Z");
      const result = await dispatchRun({
        db: state.db,
        executor: { start, async stop() {} },
        agentId: agent.id,
        now,
        beforePersist,
        afterPersist,
      });
      // Committed, not thrown: the caller's beforePersist effects (a scheduler's
      // lastScheduledAt) stand, and afterPersist's host rows are written.
      expect(result?.run).toMatchObject({ status: "failed", finishedAt: now });
      expect(result?.run.error).toMatch(/^model_unavailable: .*reason: disabled/);
      expect(state.runs).toHaveLength(1);
      expect(state.runs[0]).not.toHaveProperty("pricingVersion");
      expect(state.codingRuns).toHaveLength(0);
      expect(beforePersist).toHaveBeenCalledTimes(1);
      expect(afterPersist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "failed" }));
      expect(start).not.toHaveBeenCalled();
    } finally {
      uninstallModelCatalogForTests();
      store.close();
    }
  });

  it("fails a coding dispatch for a model not in the catalog the same way", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      model: "gpt-nonexistent",
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
    const start = vi.fn(async () => undefined);
    const result = await dispatchRun({ db: state.db, executor: { start, async stop() {} }, agentId: agent.id });
    expect(result?.run.status).toBe("failed");
    expect(result?.run.error).toMatch(/^model_unavailable: .*reason: not_in_catalog/);
    expect(start).not.toHaveBeenCalled();
  });

  it("still throws for a coding profile naming an unknown coding provider", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      codingProfile: {
        provider: "cobol-bot",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Fix the failing tests",
        timeoutSec: 900,
        protectedPaths: [],
      },
    };
    const state = fakeDb(agent);
    await expect(
      dispatchRun({ db: state.db, executor: { async start() {}, async stop() {} }, agentId: agent.id }),
    ).rejects.toThrow(/Unsupported coding provider "cobol-bot"/);
    expect(state.runs).toHaveLength(0);
  });

  it("snapshots a native agent's execution mode onto the run, which later setting changes never touch", async () => {
    const agent: Record<string, any> = { ...nativeAgent(), nativeExecutionMode: "sandbox" };
    const state = fakeDb(agent);
    const executor: Executor = { async start() {}, async stop() {} };
    await dispatchRun({ db: state.db, executor, agentId: "agent_1" });
    agent.nativeExecutionMode = "control_plane";
    await dispatchRun({ db: state.db, executor, agentId: "agent_1" });
    expect(state.runs.map((run) => run.nativeExecutionMode)).toEqual(["sandbox", "control_plane"]);
  });

  it("writes no execution mode on a coding run", async () => {
    const agent = {
      ...nativeAgent(),
      kind: "coding",
      nativeExecutionMode: "control_plane",
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
    expect(state.runs[0].nativeExecutionMode ?? null).toBeNull();
  });

  it("leaves a native run's catalog entry for the runner to record", async () => {
    const state = fakeDb(nativeAgent());
    await dispatchRun({ db: state.db, executor: { async start() {}, async stop() {} }, agentId: "agent_1" });
    expect(state.runs[0]).not.toHaveProperty("pricingVersion");
  });

  describe("mergeOrder", () => {
    function mergeOrderCodingAgent() {
      return {
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
    }
    const executor: Executor = { async start() {}, async stop() {} };

    it("persists the caller's mergeOrder onto the coding run", async () => {
      const agent = mergeOrderCodingAgent();
      const state = fakeDb(agent);
      await dispatchRun({ db: state.db, executor, agentId: agent.id, mergeOrder: 2 });
      expect(state.codingRuns[0]).toMatchObject({ mergeOrder: 2 });
    });

    it("leaves mergeOrder null when the caller gives none", async () => {
      const agent = mergeOrderCodingAgent();
      const state = fakeDb(agent);
      await dispatchRun({ db: state.db, executor, agentId: agent.id });
      expect(state.codingRuns[0].mergeOrder ?? null).toBeNull();
    });

    it("ignores mergeOrder for a native agent (no CodingRun to store it on)", async () => {
      const state = fakeDb(nativeAgent());
      const result = await dispatchRun({ db: state.db, executor, agentId: "agent_1", mergeOrder: 5 });
      expect(result?.run).toBeTruthy();
      expect(state.codingRuns).toHaveLength(0);
    });

    it.each([0, 100, 1.5, -1])("rejects an out-of-range or non-integer mergeOrder (%s)", async (mergeOrder) => {
      const agent = mergeOrderCodingAgent();
      const state = fakeDb(agent);
      await expect(dispatchRun({ db: state.db, executor, agentId: agent.id, mergeOrder })).rejects.toThrow(
        "invalid_merge_order",
      );
    });
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

  it.each([
    ["an unexpired debug trace", new Date("2026-09-26T12:30:00Z"), true],
    ["an expired debug trace", new Date("2026-09-26T11:59:59Z"), false],
    ["no debug trace", null, false],
  ] as const)("fixes debugTrace on the run at dispatch from %s", async (_label, debugTraceUntil, expected) => {
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
        debugTraceUntil,
      },
    };
    const state = fakeDb(agent);
    const executor: Executor = { async start() {}, async stop() {} };

    const result = await dispatchRun({
      db: state.db,
      executor,
      agentId: agent.id,
      now: new Date("2026-09-26T12:00:00Z"),
    });

    expect(state.codingRuns).toEqual([expect.objectContaining({ runId: result?.run.id, debugTrace: expected })]);
  });

  it.each([
    ["the profile's turn limit", 120, 120],
    ["no turn limit", null, null],
  ] as const)("fixes maxTurns on the run at dispatch from %s", async (_label, maxTurns, expected) => {
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
        maxTurns,
      },
    };
    const state = fakeDb(agent);
    const executor: Executor = { async start() {}, async stop() {} };
    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });
    expect(state.codingRuns).toEqual([expect.objectContaining({ runId: result?.run.id, maxTurns: expected })]);
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
    const resolveCodingToolImage = vi.fn(() => "sha256:claudetools".padEnd(71, "0"));
    const executor: Executor = { async start() {}, async stop() {}, resolveCodingWorkerImage, resolveCodingToolImage };

    await dispatchRun({ db: state.db, executor, agentId: agent.id });

    const selector = { provider: "claude-code", toolchain: "node", toolchainVersion: null, workerImageRef: null };
    expect(resolveCodingWorkerImage).toHaveBeenCalledWith(selector);
    expect(resolveCodingToolImage).toHaveBeenCalledWith(selector);
    expect(state.codingRuns).toEqual([
      expect.objectContaining({ provider: "claude-code", toolImage: "sha256:claudetools".padEnd(71, "0") }),
    ]);
  });

  it("fails, at dispatch, a run whose model does not belong to the selected coding provider", async () => {
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
    const state = fakeDb(agent);
    const start = vi.fn(async () => undefined);

    const result = await dispatchRun({ db: state.db, executor: { start, async stop() {} }, agentId: agent.id });

    expect(result?.run.status).toBe("failed");
    expect(result?.run.error).toMatch(/not supported by coding provider "claude-code"/);
    expect(state.codingRuns).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
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

  it("files a self-defect when executor start rejects and it marks the run failed", async () => {
    const state = fakeDb(nativeAgent());
    const fileIssue = vi.fn(async () => ({ outcome: "created" as const, issueKey: "OPS-1", url: "u", seenCount: 1 }));
    const selfDefects = {
      db: {
        run: {
          findUnique: async ({ where }: any) => {
            const r = state.runs.find((x: any) => x.id === where.id);
            return r
              ? { id: r.id, agentId: "agent_1", status: r.status, error: r.error, finishedAt: r.finishedAt }
              : null;
          },
        },
        agent: {
          findUnique: async () => ({ id: "agent_1", name: "a", defectProjectKey: "OPS", defectIssueType: "Bug" }),
        },
        agentIssueProject: {
          findUnique: async () => ({
            agentId: "agent_1",
            provider: "jira",
            projectKey: "OPS",
            access: "write",
            commentVisibilityRole: null,
            creatableIssueTypes: ["Bug"],
          }),
        },
        codingRun: { findUnique: async () => null },
        $transaction: vi.fn(),
      },
      issueTrackers: { jira: { provider: "jira" } },
      options: { fileIssue },
    } as unknown as SelfDefectSink;
    await dispatchRun({
      db: state.db,
      executor: {
        async start() {
          throw new Error("launcher unavailable");
        },
        async stop() {},
      },
      agentId: "agent_1",
      selfDefects,
    });
    await vi.waitFor(() => expect(fileIssue).toHaveBeenCalledTimes(1));
    expect((fileIssue.mock.calls[0] as unknown[])[0]).toMatchObject({ fingerprint: "self:agent_1:failed:unknown" });
  });

  describe("issue inheritance", () => {
    function codingAgent() {
      return {
        ...nativeAgent(),
        kind: "coding",
        budgetUsd: 1.25,
        codingProfile: {
          provider: "codex",
          repository: "openai/wardby",
          baseRef: "main",
          defaultTask: "Do it",
          timeoutSec: 900,
          protectedPaths: [],
        },
      };
    }
    const executor = { async start() {}, async stop() {} };

    const intent = (key: string, parent?: string): AttributionIntent => ({
      source: "issue_event",
      item: {
        provider: "jira",
        key,
        scopeKey: "OPS",
        snapshot: {
          key,
          title: `title ${key}`,
          url: `https://example.test/browse/${key}`,
          scopeKey: "OPS",
          ...(parent ? { parent: { key: parent, kind: "epic" } } : {}),
        },
      },
    });
    const priorPrRun = {
      runId: "root_run",
      repository: "openai/wardby",
      baseRef: "main",
      headRef: "wardby/run-root_run",
      rootCodingRunId: null,
      run: { agent: { ownerId: "owner_1" } },
      result: {
        schemaVersion: 1,
        outcome: "pull_request_opened",
        repository: "openai/wardby",
        baseRef: "main",
        headRef: "wardby/run-root_run",
        commitSha: "a".repeat(40),
        pullRequestUrl: "https://github.com/openai/wardby/pull/22",
        pullRequestNumber: 22,
        summary: "Opened the PR",
        tests: [],
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      },
    };

    it("a run with an intent is attributed to it, with the parent frozen", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent);
      const result = await dispatchRun({
        db: state.db,
        executor,
        agentId: agent.id,
        attribution: intent("OPS-6", "OPS-1"),
      });
      expect(state.attributions.get(result!.run.id)).toMatchObject({
        workItemId: "wi_jira_OPS-6",
        parentKeyAtRun: "OPS-1",
        source: "issue_event",
      });
      expect(state.workItems.get("wi_jira_OPS-1")).toMatchObject({ key: "OPS-1", scopeKey: "OPS" });
      expect(state.codingRuns[0]).toMatchObject({ issueProvider: "jira", issueKey: "OPS-6" });
    });

    it("a child of an attributed run inherits it, and its own intent is ignored", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [], {
        ancestors: { parent: { parentRunId: null } },
        attributedRuns: { parent: "OPS-7" },
      });
      const result = await dispatchRun({
        db: state.db,
        executor,
        agentId: agent.id,
        parentRunId: "parent",
        attribution: intent("OPS-70"),
      });
      expect(state.attributions.get(result!.run.id)).toMatchObject({
        workItemId: "wi_jira_OPS-7",
        source: "inherited",
      });
      expect(state.workItems.has("wi_jira_OPS-70")).toBe(false);
      expect(state.codingRuns[0]).toMatchObject({ issueProvider: "jira", issueKey: "OPS-7" });
    });

    it("a grandchild inherits through the chain", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent);
      const top = await dispatchRun({ db: state.db, executor, agentId: agent.id, attribution: intent("OPS-8") });
      const mid = await dispatchRun({ db: state.db, executor, agentId: agent.id, parentRunId: top!.run.id });
      const leaf = await dispatchRun({ db: state.db, executor, agentId: agent.id, parentRunId: mid!.run.id });
      expect(state.attributions.get(leaf!.run.id)).toMatchObject({ workItemId: "wi_jira_OPS-8", source: "inherited" });
      expect(state.codingRuns.at(-1)).toMatchObject({ issueProvider: "jira", issueKey: "OPS-8" });
    });

    it("a tree with no attribution leaves it null", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [], { ancestors: { mid: { parentRunId: "top" }, top: { parentRunId: null } } });
      const result = await dispatchRun({ db: state.db, executor, agentId: agent.id, parentRunId: "mid" });
      expect(state.attributions.has(result!.run.id)).toBe(false);
      expect(state.codingRuns[0]).toMatchObject({ issueProvider: null, issueKey: null });
    });

    it("a continuation inherits the continued run's attribution", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [priorPrRun], { attributedRuns: { root_run: "OPS-9" } });
      const result = await dispatchRun({
        db: state.db,
        executor,
        agentId: agent.id,
        continuesCodingRunId: "root_run",
        attribution: intent("OPS-90"),
      });
      expect(state.attributions.get(result!.run.id)).toMatchObject({
        workItemId: "wi_jira_OPS-9",
        source: "inherited",
      });
      expect(state.codingRuns.at(-1)).toMatchObject({ issueProvider: "jira", issueKey: "OPS-9" });
    });

    it("the parent run's attribution wins over the continued run's", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [priorPrRun], {
        ancestors: { parent: { parentRunId: null } },
        attributedRuns: { parent: "OPS-10", root_run: "OPS-11" },
      });
      await dispatchRun({
        db: state.db,
        executor,
        agentId: agent.id,
        parentRunId: "parent",
        continuesCodingRunId: "root_run",
      });
      expect(state.codingRuns.at(-1)).toMatchObject({ issueProvider: "jira", issueKey: "OPS-10" });
    });

    it("a continuation of a pre-attribution coding run keeps its CodingRun issue, key-only", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [{ ...priorPrRun, issueProvider: "jira", issueKey: "OPS-20" }]);
      const result = await dispatchRun({
        db: state.db,
        executor,
        agentId: agent.id,
        continuesCodingRunId: "root_run",
        attribution: intent("OPS-21"),
      });
      expect(state.attributions.get(result!.run.id)).toMatchObject({
        workItemId: "wi_jira_OPS-20",
        parentKeyAtRun: null,
        source: "inherited",
      });
      expect(state.workItems.get("wi_jira_OPS-20")).toMatchObject({ scopeKey: "OPS" });
      expect(state.workItems.has("wi_jira_OPS-21")).toBe(false);
      expect(state.codingRuns.at(-1)).toMatchObject({ issueProvider: "jira", issueKey: "OPS-20" });
    });

    it("a child of a pre-attribution issue-event run gets its RunIssueStatus issue, and grandchildren inherit", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [], {
        ancestors: { legacy: { parentRunId: null } },
        issueRuns: { legacy: "OPS-22" },
      });
      const child = await dispatchRun({ db: state.db, executor, agentId: agent.id, parentRunId: "legacy" });
      const grandchild = await dispatchRun({ db: state.db, executor, agentId: agent.id, parentRunId: child!.run.id });
      for (const run of [child!.run, grandchild!.run]) {
        expect(state.attributions.get(run.id)).toMatchObject({ workItemId: "wi_jira_OPS-22", source: "inherited" });
      }
      expect(state.codingRuns.at(-1)).toMatchObject({ issueProvider: "jira", issueKey: "OPS-22" });
    });

    it("a native run is attributed too", async () => {
      const state = fakeDb(nativeAgent());
      const result = await dispatchRun({ db: state.db, executor, agentId: "agent_1", attribution: intent("OPS-12") });
      expect(state.attributions.get(result!.run.id)).toMatchObject({
        workItemId: "wi_jira_OPS-12",
        source: "issue_event",
      });
    });
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
        run: { agent: { ownerId: "owner_1" } },
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

    it("a continuation with no mergeOrder inherits the root's", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [openPrCodingRun("root_run", { mergeOrder: 3 })]);

      const result = await dispatchRun({
        db: state.db,
        executor: { async start() {}, async stop() {} },
        agentId: agent.id,
        continuesCodingRunId: "root_run",
      });

      expect(state.codingRuns).toContainEqual(expect.objectContaining({ runId: result?.run.id, mergeOrder: 3 }));
    });

    it("a continuation's own mergeOrder overrides the root's", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [openPrCodingRun("root_run", { mergeOrder: 3 })]);

      const result = await dispatchRun({
        db: state.db,
        executor: { async start() {}, async stop() {} },
        agentId: agent.id,
        continuesCodingRunId: "root_run",
        mergeOrder: 1,
      });

      expect(state.codingRuns).toContainEqual(expect.objectContaining({ runId: result?.run.id, mergeOrder: 1 }));
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

    it("a knowledge read never changes how a refused continuation is reported", async () => {
      const agent = codingAgent();
      const state = fakeDb(agent, [openPrCodingRun("root_run", { repository: "openai/other-repo" })]);
      const readCodingRepositoryFile = vi.fn(async () => "# index\n");

      await expect(
        dispatchRun({
          db: state.db,
          executor: { async start() {}, async stop() {}, readCodingRepositoryFile },
          agentId: agent.id,
          continuesCodingRunId: "root_run",
        }),
      ).rejects.toThrow(/different repository/);
      // The knowledge read's own branch resolution failed quietly; the transaction path reported the refusal.
      expect(readCodingRepositoryFile).not.toHaveBeenCalled();
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

    it("continues a root run opened by the same owner's agent", async () => {
      const agent = codingAgent({ ownerId: "owner_1" });
      const state = fakeDb(agent, [openPrCodingRun("root_run", { run: { agent: { ownerId: "owner_1" } } })]);

      await expect(
        dispatchRun({
          db: state.db,
          executor: { async start() {}, async stop() {} },
          agentId: agent.id,
          continuesCodingRunId: "root_run",
        }),
      ).resolves.not.toBeNull();
    });

    it("rejects continuing a root run opened by a different owner's agent", async () => {
      const agent = codingAgent({ ownerId: "owner_1" });
      const state = fakeDb(agent, [openPrCodingRun("root_run", { run: { agent: { ownerId: "owner_2" } } })]);

      await expect(
        dispatchRun({
          db: state.db,
          executor: { async start() {}, async stop() {} },
          agentId: agent.id,
          continuesCodingRunId: "root_run",
        }),
      ).rejects.toThrow(/different owner/);
    });

    it("rejects continuing when the dispatched agent has no owner, even if the root run has none either", async () => {
      const agent = codingAgent({ ownerId: null });
      const state = fakeDb(agent, [openPrCodingRun("root_run", { run: { agent: { ownerId: null } } })]);

      await expect(
        dispatchRun({
          db: state.db,
          executor: { async start() {}, async stop() {} },
          agentId: agent.id,
          continuesCodingRunId: "root_run",
        }),
      ).rejects.toThrow(/different owner/);
    });

    it("rejects continuing when the root run's agent has no owner", async () => {
      const agent = codingAgent({ ownerId: "owner_1" });
      const state = fakeDb(agent, [openPrCodingRun("root_run", { run: { agent: { ownerId: null } } })]);

      await expect(
        dispatchRun({
          db: state.db,
          executor: { async start() {}, async stop() {} },
          agentId: agent.id,
          continuesCodingRunId: "root_run",
        }),
      ).rejects.toThrow(/different owner/);
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
    ["a concurrent first insert of the same WorkItem", { code: "P2002", meta: { modelName: "WorkItem" } }],
  ])("retries %s", (_label, err) => {
    expect(isSerializationConflict(err)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "40001"],
    ["a unique violation", { code: "P2002" }],
    ["a unique violation on another model", { code: "P2002", meta: { modelName: "Run" } }],
    ["P2010 for another SQLSTATE", adapterP2010("23505")],
    ["P2010 without adapter details", { code: "P2010", meta: {} }],
    ["DriverAdapterError for another SQLSTATE", { name: "DriverAdapterError", cause: { originalCode: "23505" } }],
    ["another error carrying 40001", { name: "Error", cause: { originalCode: "40001" } }],
  ])("does not retry %s", (_label, err) => {
    expect(isSerializationConflict(err)).toBe(false);
  });
});

describe("isTransactionUnavailable", () => {
  it("recognises Prisma's transaction API error (P2028)", () => {
    const err = Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), {
      code: "P2028",
    });
    expect(isTransactionUnavailable(err)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a serialization failure", { code: "P2034" }],
    ["a plain error", new Error("P2028")],
  ])("is false for %s", (_label, err) => {
    expect(isTransactionUnavailable(err)).toBe(false);
  });
});

describe("coding-run services", () => {
  const POSTGRES_16 = BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16")!;
  const CATALOG = [{ id: "builtin-postgres-16", builtin: true, createdById: null, ...POSTGRES_16 }];
  const DECLARATION = 'services:\n  postgres: "16"\n';

  function servicesAgent(services: string[] | null = ["postgres"], systemPrompt = "") {
    return {
      ...nativeAgent(),
      kind: "coding",
      systemPrompt,
      codingProfile: {
        provider: "codex",
        repository: "openai/wardby",
        baseRef: "main",
        defaultTask: "Run the tests",
        timeoutSec: 900,
        protectedPaths: ["CODEOWNERS"],
        services,
      },
    };
  }

  function servicesExecutor(declaration: string | null | Error, supports = true) {
    const reads: Array<{ repository: string; baseRef: string }> = [];
    const start = vi.fn(async () => {});
    const executor: Executor = {
      start,
      async stop() {},
      async readCodingServiceDeclaration(input) {
        reads.push(input);
        if (declaration instanceof Error) throw declaration;
        return declaration;
      },
      supportsCodingServices: () => supports,
    };
    return { executor, reads, start };
  }

  it("resolves the base branch's declaration, snapshots the service, and tells the builder about it", async () => {
    const agent = servicesAgent();
    const state = fakeDb(agent, [], {}, CATALOG);
    const { executor, reads, start } = servicesExecutor(DECLARATION);

    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });

    expect(reads).toEqual([{ repository: "openai/wardby", baseRef: "main" }]);
    expect(result?.run.status).toBe("pending");
    expect(state.codingRuns[0].services).toEqual([resolvedFromDefinition(POSTGRES_16)]);
    expect(state.codingRuns[0].task).toContain("Services for this run:");
    expect(state.codingRuns[0].task).toContain("- postgres 16: DATABASE_URL=postgres://test:test@127.0.0.1:5432/test");
    expect(state.codingRuns[0].task).toMatch(/\n\nRequest:\nRun the tests$/);
    expect(start).toHaveBeenCalledWith(result?.run.id);
  });

  it("gives a run no services and leaves its task alone when the repository declares none", async () => {
    const agent = servicesAgent();
    const state = fakeDb(agent, [], {}, CATALOG);
    const { executor } = servicesExecutor(null);
    await dispatchRun({ db: state.db, executor, agentId: agent.id });
    expect(state.codingRuns[0].services).toEqual([]);
    expect(state.codingRuns[0].task).toBe("Run the tests");
  });

  it.each([
    ["an empty allowed list", []],
    ["no allowed list", null],
  ])("never reads the declaration for an agent with %s, and dispatches exactly as before", async (_label, allowed) => {
    const agent = servicesAgent(allowed);
    const state = fakeDb(agent, [], {}, CATALOG);
    const { executor, reads, start } = servicesExecutor(new Error("must not be called"), false);
    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });
    expect(reads).toEqual([]);
    expect(result?.run.status).toBe("pending");
    expect(state.codingRuns[0].services).toEqual([]);
    expect(state.codingRuns[0].task).toBe("Run the tests");
    expect(start).toHaveBeenCalledWith(result?.run.id);
  });

  it("reads the declaration from the branch the run works on: an override, or a continuation's root", async () => {
    const agent = servicesAgent();
    const overridden = servicesExecutor(null);
    await dispatchRun({
      db: fakeDb(agent, [], {}, CATALOG).db,
      executor: overridden.executor,
      agentId: agent.id,
      codingBaseRef: "refs/heads/release",
    });
    expect(overridden.reads).toEqual([{ repository: "openai/wardby", baseRef: "release" }]);

    const root = {
      runId: "root_run",
      repository: "openai/wardby",
      baseRef: "develop",
      headRef: "wardby/run-root_run",
      rootCodingRunId: null,
      run: { agent: { ownerId: "owner_1" } },
      result: {
        schemaVersion: 1,
        outcome: "pull_request_opened",
        repository: "openai/wardby",
        baseRef: "develop",
        headRef: "wardby/run-root_run",
        commitSha: "a".repeat(40),
        pullRequestUrl: "https://github.com/openai/wardby/pull/5",
        pullRequestNumber: 5,
        summary: "Opened.",
        tests: [],
        usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 },
      },
    };
    const continued = servicesExecutor(null);
    const state = fakeDb(agent, [root], {}, CATALOG);
    await dispatchRun({
      db: state.db,
      executor: continued.executor,
      agentId: agent.id,
      continuesCodingRunId: "root_run",
    });
    expect(continued.reads).toEqual([{ repository: "openai/wardby", baseRef: "develop" }]);
    expect(state.codingRuns[1]).toMatchObject({
      baseRef: "develop",
      headRef: "wardby/run-root_run",
      rootCodingRunId: "root_run",
    });
  });

  it.each([
    [
      "the agent isn't allowed the service",
      servicesAgent(["redis"]),
      DECLARATION,
      "service_not_allowed: This repository asks for `postgres`, which this agent isn't allowed to use. An admin or the agent's owner can allow it.",
    ],
    [
      "the catalog doesn't have the version",
      servicesAgent(),
      'services:\n  postgres: "18"\n',
      "service_unknown: This repository asks for `postgres 18`, which wardby's service catalog doesn't have.",
    ],
    [
      "the declaration is invalid",
      servicesAgent(),
      'services:\n  Postgres: "16"\n',
      "service_declaration_invalid: `.wardby/services.yaml` is invalid: line 2: a service name must be lowercase letters, digits and hyphens, starting with a letter.",
    ],
    [
      "the declaration is too large",
      servicesAgent(),
      new Error("github_file_too_large"),
      "service_declaration_invalid: `.wardby/services.yaml` is invalid: it is larger than 8192 bytes.",
    ],
    [
      "a local declaration is too large",
      servicesAgent(),
      new Error("local_file_too_large"),
      "service_declaration_invalid: `.wardby/services.yaml` is invalid: it is larger than 8192 bytes.",
    ],
    [
      "a local declaration is not a file",
      servicesAgent(),
      new Error("local_file_not_a_file"),
      "service_declaration_invalid: `.wardby/services.yaml` is invalid: it is not a file.",
    ],
    [
      "a local declaration is not UTF-8",
      servicesAgent(),
      new Error("local_file_not_utf8"),
      "service_declaration_invalid: `.wardby/services.yaml` is invalid: it is not UTF-8 text.",
    ],
    [
      "the declaration can't be read",
      servicesAgent(),
      new Error("github_api_error:502"),
      `service_declaration_unavailable: ${DECLARATION_UNAVAILABLE_SENTENCE}`,
    ],
    [
      "the agent's instructions plus the services note leave no room for the task",
      servicesAgent(["postgres"], "x".repeat(MAX_CODING_TASK_BYTES - 200)),
      DECLARATION,
      `service_declaration_invalid: ${SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE}`,
    ],
  ])("refuses the run, never starting it, when %s", async (_label, agent, declaration, error) => {
    const state = fakeDb(agent, [], {}, CATALOG);
    const { executor, start } = servicesExecutor(declaration);
    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });
    expect(result?.run).toMatchObject({ status: "refused", error });
    expect(state.codingRuns).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it("resolves a local repository's services from its committed base ref", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "wardby-dispatch-local-")));
    try {
      const repo = join(root, "repo");
      await mkdir(repo);
      const g = (...args: string[]) =>
        execFileSync("git", ["-c", "commit.gpgSign=false", ...args], {
          cwd: repo,
          env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        });
      g("init", "--initial-branch=main");
      g("config", "user.email", "t@example.invalid");
      g("config", "user.name", "T");
      await mkdir(join(repo, ".wardby"));
      await writeFile(join(repo, ".wardby", "services.yaml"), DECLARATION);
      g("add", ".");
      g("commit", "-m", "services");
      const vcs = new GitVcsProvider({ rootDir: join(root, "vcs"), remote: new LocalRemote({ roots: () => [root] }) });
      const agent = servicesAgent();
      agent.codingProfile.repository = `local:${repo}`;
      const state = fakeDb(agent, [], {}, CATALOG);
      const { executor } = servicesExecutor(null);
      executor.readCodingServiceDeclaration = (input) =>
        vcs.readRepositoryFile({ ...input, ref: input.baseRef, path: ".wardby/services.yaml", maxBytes: 8192 });
      const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });
      expect(result?.run.status).toBe("pending");
      expect(state.codingRuns[0].services).toEqual([resolvedFromDefinition(POSTGRES_16)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still fails over-long instructions with the generic size error when the run has no services", async () => {
    const agent = servicesAgent(["postgres"], "x".repeat(MAX_CODING_TASK_BYTES - 10));
    const state = fakeDb(agent, [], {}, CATALOG);
    const { executor } = servicesExecutor(null);
    await expect(dispatchRun({ db: state.db, executor, agentId: agent.id })).rejects.toThrow(
      /exceed the 16384-byte coding task limit/,
    );
  });

  it("refuses services on a deployment whose launcher can't start them", async () => {
    const agent = servicesAgent();
    const state = fakeDb(agent, [], {}, CATALOG);
    const { executor, start } = servicesExecutor(DECLARATION, false);
    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });
    expect(result?.run).toMatchObject({
      status: "refused",
      error: `service_launcher_unsupported: ${LAUNCHER_UNSUPPORTED_SENTENCE}`,
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("asks the executor about the agent's own coding provider", async () => {
    const agent = servicesAgent();
    const state = fakeDb(agent, [], {}, CATALOG);
    const supports = vi.fn(() => true);
    const executor: Executor = {
      start: vi.fn(async () => {}),
      async stop() {},
      readCodingServiceDeclaration: async () => DECLARATION,
      supportsCodingServices: supports,
    };
    await dispatchRun({ db: state.db, executor, agentId: agent.id });
    expect(supports).toHaveBeenCalledWith("codex");
  });

  // What the job launchers answer (jobs/types.ts supportsServicesFor): Kubernetes and Docker start
  // services for both providers; a deployment without a coding job launcher (local) for neither.
  const kubernetesSupport = () => true;
  const dockerSupport = (provider: string) => provider === "codex" || provider === "claude-code";
  const noLauncherSupport = () => false;

  it.each([
    ["Kubernetes", "claude-code", kubernetesSupport, "pending"],
    ["Kubernetes", "codex", kubernetesSupport, "pending"],
    ["Docker", "codex", dockerSupport, "pending"],
    ["Docker", "claude-code", dockerSupport, "pending"],
    ["local (no job launcher)", "claude-code", noLauncherSupport, "refused"],
  ] as const)("on the %s launcher, a %s run with services is %s", async (_launcher, provider, supports, status) => {
    const base = servicesAgent();
    const agent = {
      ...base,
      model: provider === "claude-code" ? "claude-sonnet-5" : base.model,
      codingProfile: { ...base.codingProfile, provider },
    };
    const state = fakeDb(agent, [], {}, CATALOG);
    const start = vi.fn(async () => {});
    const executor: Executor = {
      start,
      async stop() {},
      readCodingServiceDeclaration: async () => DECLARATION,
      supportsCodingServices: supports,
    };
    const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });
    expect(result?.run.status).toBe(status);
    if (status === "refused") {
      expect(result?.run.error).toBe(`service_launcher_unsupported: ${LAUNCHER_UNSUPPORTED_SENTENCE}`);
      expect(start).not.toHaveBeenCalled();
    } else {
      expect(state.codingRuns[0]).toMatchObject({ provider, services: [resolvedFromDefinition(POSTGRES_16)] });
    }
  });

  it("reads nothing for a native agent", async () => {
    const state = fakeDb(nativeAgent());
    const { executor, reads } = servicesExecutor(DECLARATION);
    await dispatchRun({ db: state.db, executor, agentId: "agent_1" });
    expect(reads).toEqual([]);
  });
});
