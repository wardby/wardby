import { describe, expect, it } from "vitest";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { Engine, EngineResult, EngineRunContext, StepRunner } from "../providers/engine/types.js";
import type { LlmProvider } from "../providers/index.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import { executeRun, runAgent, RunCancelledError, type RunnerDb } from "./runner.js";

// Phase 3: executeRun is a thin wrapper — budget/loop logic now lives in
// the Engine (covered by engine-native.test.ts). These tests cover the
// runner's own job: loading the agent + its attached tools, wiring
// runSandboxTool, calling the engine, and persisting the result.

interface FakeAgent {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  budgetUsd: number;
  maxTurns: number;
  kind?: "native" | "coding";
  budgetGroupId?: string | null;
  memoryEnabled?: boolean;
  effort?: string | null;
}

interface FakeTool {
  id: string;
  name: string;
  description: string;
  paramsZod: string;
  jsonSchema: Record<string, unknown>;
  code: string;
}

interface FakeAttachment {
  agentId: string;
  toolId: string;
  allowedSecrets?: string[];
  allowedDatastorePrefixes?: string[];
  allowedHosts?: string[];
  allowedSharedDatastorePrefixes?: Record<string, string[]>;
}

interface FakeAgentDatastore {
  agentId: string;
  boundName: string;
  datastoreId: string;
}

interface FakeBudgetGroup {
  id: string;
  name: string;
  dailyBudgetUsd?: number | null;
  weeklyBudgetUsd?: number | null;
  monthlyBudgetUsd?: number | null;
  warnThresholdRatio?: number;
}

function fakeDb(
  agents: FakeAgent[],
  tools: FakeTool[] = [],
  attachments: FakeAttachment[] = [],
  secretsData: { agentId: string; boundName: string; value: string }[] = [],
  budgetGroups: FakeBudgetGroup[] = [],
  priorRuns: { agentId: string; costUsd: number; startedAt: Date }[] = [],
  agentDatastores: FakeAgentDatastore[] = [],
): RunnerDb {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const toolsById = new Map(tools.map((t) => [t.id, t]));
  const groupsById = new Map(budgetGroups.map((g) => [g.id, g]));
  const runs = new Map<string, any>();
  let counter = 0;

  return {
    agent: {
      findUnique: (async ({ where }: any) => (where.name ? byName.get(where.name) : byId.get(where.id)) ?? null) as any,
    },
    run: {
      create: (async ({ data }: any) => {
        const id = `run_${++counter}`;
        const record = {
          id,
          status: "pending",
          trigger: "manual",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
          heartbeatAt: null,
          ...data,
        };
        runs.set(id, record);
        return record;
      }) as any,
      findUnique: (async ({ where }: any) => runs.get(where.id) ?? null) as any,
      findUniqueOrThrow: (async ({ where }: any) => {
        const record = runs.get(where.id);
        if (!record) throw new Error(`No Run with id "${where.id}".`);
        return record;
      }) as any,
      update: (async ({ where, data }: any) => {
        const record = { ...runs.get(where.id), ...data };
        runs.set(where.id, record);
        return record;
      }) as any,
      updateMany: (async ({ where, data }: any) => {
        const record = runs.get(where.id);
        if (!record) return { count: 0 };
        if (where.status !== undefined) {
          const allowed = typeof where.status === "string" ? [where.status] : where.status.in;
          if (!allowed.includes(record.status)) return { count: 0 };
        }
        runs.set(where.id, { ...record, ...data });
        return { count: 1 };
      }) as any,
      findMany: (async ({ where }: any) =>
        priorRuns.filter((r) => where.agentId.in.includes(r.agentId) && r.startedAt >= where.startedAt.gte)) as any,
    },
    agentTool: {
      findMany: (async ({ where }: any) =>
        attachments
          .filter((a) => a.agentId === where.agentId)
          .map((a) => ({ ...a, tool: toolsById.get(a.toolId) }))) as any,
    },
    agentSecret: {
      findFirst: (async ({ where }: any) => {
        const row = secretsData.find((s) => s.agentId === where.agentId && s.boundName === where.boundName);
        return row ? { secret: { ciphertext: row.value } } : null;
      }) as any,
    },
    agentDatastore: {
      findFirst: (async ({ where }: any) => {
        const row = agentDatastores.find((d) => d.agentId === where.agentId && d.boundName === where.boundName);
        return row ? { ...row } : null;
      }) as any,
    },
    budgetGroup: {
      findUnique: (async ({ where }: any) => {
        const g = groupsById.get(where.id);
        if (!g) return null;
        return {
          dailyBudgetUsd: null,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          ...g,
          agents: agents.filter((a) => a.budgetGroupId === where.id).map((a) => ({ id: a.id })),
        };
      }) as any,
    },
    // No test in this file dispatches a sub-agent (existingRun.parentRunId
    // is always null/undefined here), so a fixed "no edges" stub is enough.
    agentSubAgent: {
      findFirst: (async () => null) as any,
      findMany: (async () => []) as any,
    },
  } as unknown as RunnerDb;
}

function fakeCipher(): SecretCipher {
  return {
    keyId: () => "k1",
    encrypt: async (v: string) => v,
    decrypt: async (v: string) => v,
  };
}

function fakeDatastore(): Datastore {
  const store = new Map<string, DatastoreValue>();
  const sharedStore = new Map<string, DatastoreValue>();
  return {
    async get(agentId, key) {
      return store.get(`${agentId}:${key}`);
    },
    async set(agentId, key, value) {
      store.set(`${agentId}:${key}`, value);
    },
    async delete(agentId, key) {
      store.delete(`${agentId}:${key}`);
    },
    async list(agentId, prefix) {
      const p = `${agentId}:${prefix ?? ""}`;
      return [...store.keys()].filter((k) => k.startsWith(p)).sort();
    },
    async getShared(datastoreId, key) {
      return sharedStore.get(`${datastoreId}:${key}`);
    },
    async setShared(datastoreId, key, value) {
      sharedStore.set(`${datastoreId}:${key}`, value);
    },
    async deleteShared(datastoreId, key) {
      sharedStore.delete(`${datastoreId}:${key}`);
    },
    async listShared(datastoreId, prefix) {
      const p = `${datastoreId}:${prefix ?? ""}`;
      return [...sharedStore.keys()]
        .filter((k) => k.startsWith(p))
        .map((k) => k.slice(datastoreId.length + 1))
        .sort();
    },
  };
}

function fakeMemory(): AgentMemoryStore {
  const store = new Map<string, string>();
  return {
    async get(agentId, key) {
      return store.get(`${agentId}:${key}`);
    },
    async set(agentId, key, content) {
      store.set(`${agentId}:${key}`, content);
    },
    async list(agentId) {
      const p = `${agentId}:`;
      return [...store.keys()]
        .filter((k) => k.startsWith(p))
        .map((k) => k.slice(p.length))
        .sort();
    },
    async search(agentId, query) {
      const p = `${agentId}:`;
      return [...store.entries()]
        .filter(([k, content]) => k.startsWith(p) && content.includes(query))
        .map(([k, content]) => ({ key: k.slice(p.length), content, rank: 1 }));
    },
    async delete(agentId, key) {
      store.delete(`${agentId}:${key}`);
    },
  };
}

const noopLlm = {} as LlmProvider;
// None of these tests' sandboxed tool bodies call secrets.get, so this
// cipher is constructed into a SecretsAccessor closure but never invoked.
const noopSecretCipher = {} as SecretCipher;

function fakeEngine(result: EngineResult, capture?: (ctx: EngineRunContext) => void): Engine {
  return {
    async run(ctx) {
      capture?.(ctx);
      return result;
    },
  };
}

describe("runAgent", () => {
  it("fails closed instead of executing a coding agent in the native engine", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "coder",
        systemPrompt: "code",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        maxTurns: 10,
        kind: "coding",
      },
    ]);
    let engineCalled = false;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "unsafe", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.1 } },
      () => {
        engineCalled = true;
      },
    );

    await expect(
      runAgent(
        "coder",
        { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
        db,
      ),
    ).rejects.toThrow(/coding.*executor|executor.*coding/i);
    expect(engineCalled).toBe(false);
  });

  it("persists the engine's result onto the run", async () => {
    const db = fakeDb([
      { id: "a1", name: "greeter", systemPrompt: "be nice", model: "m", budgetUsd: 10, maxTurns: 10 },
    ]);
    const engine = fakeEngine({
      status: "succeeded",
      finalText: "hi there",
      turns: 1,
      usage: { tokensIn: 13, tokensOut: 8, costUsd: 0.0005 },
    });

    const run = await runAgent(
      "greeter",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(run.status).toBe("succeeded");
    expect(run.tokensIn).toBe(13);
    expect(run.tokensOut).toBe(8);
    expect(run.costUsd).toBe(0.0005);
    expect(run.finalText).toBe("hi there");
    expect(run.turns).toBe(1);
  });

  it("persists a refused/budget_exhausted/failed status and error message verbatim", async () => {
    const db = fakeDb([{ id: "a1", name: "tight", systemPrompt: "sys", model: "m", budgetUsd: 0.01, maxTurns: 10 }]);
    const engine = fakeEngine({
      status: "refused",
      finalText: "",
      turns: 1,
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      error: "Estimated input cost exceeds budget before any LLM call.",
    });

    const run = await runAgent(
      "tight",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(run.status).toBe("refused");
    expect(run.error).toBe("Estimated input cost exceeds budget before any LLM call.");
  });

  it("passes the agent's own budgetUsd unchanged to the engine when it has no budget group", async () => {
    const db = fakeDb([{ id: "a1", name: "solo", systemPrompt: "s", model: "m", budgetUsd: 5, maxTurns: 10 }]);
    let capturedBudget: number | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 } },
      (ctx) => {
        capturedBudget = ctx.agent.budgetUsd;
      },
    );
    await runAgent(
      "solo",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );
    expect(capturedBudget).toBe(5);
  });

  it("tightens the budget handed to the engine when the agent's group has a smaller remaining daily cap", async () => {
    const db = fakeDb(
      [{ id: "a1", name: "grouped", systemPrompt: "s", model: "m", budgetUsd: 5, maxTurns: 10, budgetGroupId: "g1" }],
      [],
      [],
      [],
      [{ id: "g1", name: "team", dailyBudgetUsd: 10 }],
      [{ agentId: "a1", costUsd: 8, startedAt: new Date() }],
    );
    let capturedBudget: number | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 } },
      (ctx) => {
        capturedBudget = ctx.agent.budgetUsd;
      },
    );
    await runAgent(
      "grouped",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );
    expect(capturedBudget).toBe(2); // 10 cap - 8 already spent = 2 remaining, tighter than the agent's own 5
  });

  it("hands the engine a 0 budget once the group's daily cap is fully spent, regardless of the agent's own budgetUsd", async () => {
    const db = fakeDb(
      [{ id: "a1", name: "exhausted", systemPrompt: "s", model: "m", budgetUsd: 5, maxTurns: 10, budgetGroupId: "g1" }],
      [],
      [],
      [],
      [{ id: "g1", name: "team", dailyBudgetUsd: 10 }],
      [{ agentId: "a1", costUsd: 10, startedAt: new Date() }],
    );
    let capturedBudget: number | undefined;
    const engine = fakeEngine(
      {
        status: "refused",
        finalText: "",
        turns: 1,
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        error: "budget exhausted before any LLM call",
      },
      (ctx) => {
        capturedBudget = ctx.agent.budgetUsd;
      },
    );
    const run = await runAgent(
      "exhausted",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );
    expect(capturedBudget).toBe(0);
    // The engine result is a fake here (its own zero-budget refuse behavior
    // is engine-native.test.ts's job, not this file's) -- this test's job
    // is only to prove runner.ts computed and passed a 0, then persisted
    // whatever status the engine returned for it.
    expect(run.status).toBe("refused");
  });

  it("builds the EngineRunContext with the agent's fields and no tools when none are attached", async () => {
    const db = fakeDb([{ id: "a1", name: "solo", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 7 }]);
    let captured: EngineRunContext | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.001 } },
      (ctx) => {
        captured = ctx;
      },
    );

    await runAgent(
      "solo",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(captured?.agent).toEqual({ systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 7 });
    expect(captured?.tools).toEqual([]);
  });

  it.each([
    { stored: "low", expected: "low" },
    { stored: null, expected: undefined },
    { stored: "extreme", expected: undefined },
  ])("pins the agent's effort ($stored) into the engine context", async ({ stored, expected }) => {
    const db = fakeDb([
      { id: "a1", name: "solo", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 7, effort: stored },
    ]);
    let captured: EngineRunContext | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.001 } },
      (ctx) => {
        captured = ctx;
      },
    );

    await runAgent(
      "solo",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(captured?.agent.effort).toBe(expected);
    expect("effort" in captured!.agent).toBe(expected !== undefined);
  });

  it("loads attached tools' cached JSON Schema for the engine (not re-derived per run)", async () => {
    // jsonSchema is derived once at `wardby tool create` time (cli.ts) and
    // cached on the row — executeRun just reads it, it never re-derives.
    const cachedJsonSchema = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    const tool: FakeTool = {
      id: "t1",
      name: "getWeather",
      description: "Get the weather for a city",
      paramsZod: "z.object({ city: z.string() })",
      jsonSchema: cachedJsonSchema,
      code: "return { tempF: 72 };",
    };
    const db = fakeDb(
      [{ id: "a1", name: "weatherbot", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 10 }],
      [tool],
      [{ agentId: "a1", toolId: "t1" }],
    );
    let captured: EngineRunContext | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.001 } },
      (ctx) => {
        captured = ctx;
      },
    );

    await runAgent(
      "weatherbot",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(captured?.tools).toHaveLength(1);
    expect(captured?.tools[0].name).toBe("getWeather");
    expect(captured?.tools[0].jsonSchema).toEqual(cachedJsonSchema);
  });

  it("wires runSandboxTool to real Zod-in-sandbox validation and the real WASM sandbox", async () => {
    const tool: FakeTool = {
      id: "t1",
      name: "double",
      description: "Doubles a number",
      paramsZod: "z.object({ n: z.number() })",
      jsonSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      code: "return { doubled: params.n * 2 };",
    };
    const db = fakeDb(
      [{ id: "a1", name: "doubler", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 10 }],
      [tool],
      [{ agentId: "a1", toolId: "t1" }],
    );

    const results: string[] = [];
    const engine: Engine = {
      async run(ctx) {
        results.push(await ctx.runSandboxTool("double", JSON.stringify({ n: 21 })));
        results.push(await ctx.runSandboxTool("double", JSON.stringify({ n: "not a number" })));
        results.push(await ctx.runSandboxTool("missingTool", "{}"));
        return { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.001 } };
      },
    };

    await runAgent(
      "doubler",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(JSON.parse(results[0])).toEqual({ doubled: 42 });
    expect(JSON.parse(results[1]).error).toBe("validation_failed");
    expect(JSON.parse(results[2]).error).toBe("unknown_tool");
  });

  it("appends the built-in memory tools only when the agent has memoryEnabled", async () => {
    const db = fakeDb([
      { id: "a1", name: "remembers", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 10, memoryEnabled: true },
      { id: "a2", name: "forgets", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 10, memoryEnabled: false },
    ]);
    const captured: EngineRunContext[] = [];
    const engine = fakeEngine(
      { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.001 } },
      (ctx) => {
        captured.push(ctx);
      },
    );

    await runAgent(
      "remembers",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );
    await runAgent(
      "forgets",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(captured[0].tools.map((t) => t.name).sort()).toEqual([
      "memory_get",
      "memory_list",
      "memory_search",
      "memory_set",
    ]);
    expect(captured[1].tools).toEqual([]);
  });

  it("dispatches memory_set/memory_get through the memory provider, scoped to the agent's own id", async () => {
    const db = fakeDb([
      { id: "a1", name: "remembers", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 10, memoryEnabled: true },
    ]);
    const memory = fakeMemory();
    const results: string[] = [];
    const engine: Engine = {
      async run(ctx) {
        results.push(await ctx.runSandboxTool("memory_set", JSON.stringify({ key: "k", content: "v" })));
        results.push(await ctx.runSandboxTool("memory_get", JSON.stringify({ key: "k" })));
        return { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.001 } };
      },
    };

    await runAgent(
      "remembers",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory },
      db,
    );

    expect(JSON.parse(results[0])).toEqual({ ok: true });
    expect(JSON.parse(results[1])).toEqual({ content: "v" });
    expect(await memory.get("a1", "k")).toBe("v");
  });

  it("a memory-disabled agent gets unknown_tool for a memory tool name, never silent dispatch", async () => {
    const db = fakeDb([
      { id: "a1", name: "forgets", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 10, memoryEnabled: false },
    ]);
    let result = "";
    const engine: Engine = {
      async run(ctx) {
        result = await ctx.runSandboxTool("memory_set", JSON.stringify({ key: "k", content: "v" }));
        return { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.001 } };
      },
    };

    await runAgent(
      "forgets",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(JSON.parse(result).error).toBe("unknown_tool");
  });

  it("runSandboxTool treats an empty argsJson as {} for a zero-parameter tool (some providers stream no delta at all for empty args)", async () => {
    const tool: FakeTool = {
      id: "t1",
      name: "ping",
      description: "Takes no arguments",
      paramsZod: "z.object({})",
      jsonSchema: { type: "object", properties: {} },
      code: "return { pong: true };",
    };
    const db = fakeDb(
      [{ id: "a1", name: "pinger", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 10 }],
      [tool],
      [{ agentId: "a1", toolId: "t1" }],
    );

    let result = "";
    const engine: Engine = {
      async run(ctx) {
        result = await ctx.runSandboxTool("ping", "");
        return { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.001 } };
      },
    };

    await runAgent(
      "pinger",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(JSON.parse(result)).toEqual({ pong: true });
  });

  it("marks the run failed when the engine throws unexpectedly", async () => {
    const db = fakeDb([{ id: "a1", name: "flaky", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 }]);
    const engine: Engine = {
      async run() {
        throw new Error("engine bug");
      },
    };

    const run = await runAgent(
      "flaky",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(run.status).toBe("failed");
    expect(run.error).toBe("engine bug");
  });

  it("refuses to load an agent holding two same-named tools instead of letting one shadow the other", async () => {
    // Every attach path refuses this (core/tool-names.ts); the load-time
    // check is defence in depth for rows that bypassed those guards.
    const tool = (id: string): FakeTool => ({
      id,
      name: "foo",
      description: "d",
      paramsZod: "z.object({})",
      jsonSchema: {},
      code: `return "${id}";`,
    });
    const db = fakeDb(
      [{ id: "a1", name: "dupes", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 3 }],
      [tool("t1"), tool("t2")],
      [
        { agentId: "a1", toolId: "t1" },
        { agentId: "a1", toolId: "t2" },
      ],
    );
    let engineRan = false;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "", turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      () => {
        engineRan = true;
      },
    );

    await expect(
      runAgent(
        "dupes",
        { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
        db,
      ),
    ).rejects.toThrow(/more than one attached tool named "foo"/);
    expect(engineRan).toBe(false);
  });

  it("throws for an unknown agent without creating a Run", async () => {
    const db = fakeDb([]);
    const engine = fakeEngine({
      status: "succeeded",
      finalText: "",
      turns: 0,
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });

    await expect(
      runAgent(
        "ghost",
        { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
        db,
      ),
    ).rejects.toThrow(/Unknown agent/);
  });

  it("scopes a sandboxed tool's datastore access to its declared allowedDatastorePrefixes", async () => {
    const db = fakeDb(
      [{ id: "a1", name: "scoped-ds", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 }],
      [
        {
          id: "t1",
          name: "write_key",
          description: "x",
          paramsZod: "z.object({ key: z.string() })",
          jsonSchema: {},
          code: "await datastore.set(params.key, 'v'); return 'ok';",
        },
      ],
      [{ agentId: "a1", toolId: "t1", allowedDatastorePrefixes: ["allowed:"] }],
    );
    let captured: EngineRunContext | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "", turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      (ctx) => {
        captured = ctx;
      },
    );

    await runAgent(
      "scoped-ds",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    const allowed = JSON.parse(await captured!.runSandboxTool("write_key", JSON.stringify({ key: "allowed:1" })));
    expect(allowed).toBe("ok");

    const blocked = JSON.parse(await captured!.runSandboxTool("write_key", JSON.stringify({ key: "blocked:1" })));
    expect(blocked).toMatchObject({
      error: "thrown",
      message: expect.stringContaining("datastore_prefix_not_allowed"),
    });
  });

  it("round-trips a bound sharedDatastore through the sandbox, scoped per-tool-call to that tool's own allowedSharedDatastorePrefixes", async () => {
    const db = fakeDb(
      [{ id: "a1", name: "shared-ds", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 }],
      [
        {
          id: "t1",
          name: "kb_writer",
          description: "x",
          paramsZod: "z.object({ key: z.string() })",
          jsonSchema: {},
          code: "await sharedDatastore.set('kb', params.key, 'v'); return await sharedDatastore.get('kb', params.key);",
        },
        {
          id: "t2",
          name: "kb_reader_unscoped",
          description: "x",
          paramsZod: "z.object({ key: z.string() })",
          jsonSchema: {},
          code: "const v = await sharedDatastore.get('kb', params.key); return v === undefined ? null : v;",
        },
      ],
      [
        { agentId: "a1", toolId: "t1", allowedSharedDatastorePrefixes: { kb: ["allowed:"] } },
        // t2 is attached to the same agent, same "kb" bound name, but was
        // never granted any allowedSharedDatastorePrefixes at all — proves
        // scoping is applied per-tool-call from that tool's own capability
        // declaration, not once for the whole run (t2 must NOT see what t1
        // wrote, even though both resolve to the same underlying datastore).
        { agentId: "a1", toolId: "t2", allowedSharedDatastorePrefixes: {} },
      ],
      [],
      [],
      [],
      [{ agentId: "a1", boundName: "kb", datastoreId: "ds1" }],
    );
    let captured: EngineRunContext | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "", turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      (ctx) => {
        captured = ctx;
      },
    );

    await runAgent(
      "shared-ds",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    const allowedWrite = JSON.parse(await captured!.runSandboxTool("kb_writer", JSON.stringify({ key: "allowed:1" })));
    expect(allowedWrite).toBe("v");

    const blockedWrite = JSON.parse(await captured!.runSandboxTool("kb_writer", JSON.stringify({ key: "blocked:1" })));
    expect(blockedWrite).toMatchObject({
      error: "thrown",
      message: expect.stringContaining("datastore_prefix_not_allowed"),
    });

    const unscopedRead = JSON.parse(
      await captured!.runSandboxTool("kb_reader_unscoped", JSON.stringify({ key: "allowed:1" })),
    );
    expect(unscopedRead).toBeNull();
  });

  it("two separate agents share one datastore end to end: agent A's tool writes, agent B's tool reads it back", async () => {
    // Both agents attach a tool to the SAME underlying datastoreId ("ds-shared")
    // under their own boundName, each independently granted
    // allowedSharedDatastorePrefixes for that binding — proves the full
    // wiring (attachment lookup, per-attachment scoping, and the shared
    // Datastore provider methods) works across two independently-run
    // agents, not just two tools within one runAgent call.
    const db = fakeDb(
      [
        { id: "a1", name: "writer-agent", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 },
        { id: "a2", name: "reader-agent", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 },
      ],
      [
        {
          id: "t1",
          name: "kb_writer",
          description: "x",
          paramsZod: "z.object({ key: z.string() })",
          jsonSchema: {},
          code: "await sharedDatastore.set('kb', params.key, params.key + '-value'); return 'ok';",
        },
        {
          id: "t2",
          name: "kb_reader",
          description: "x",
          paramsZod: "z.object({ key: z.string() })",
          jsonSchema: {},
          code: "const v = await sharedDatastore.get('kb', params.key); return v === undefined ? null : v;",
        },
      ],
      [
        { agentId: "a1", toolId: "t1", allowedSharedDatastorePrefixes: { kb: ["allowed:"] } },
        { agentId: "a2", toolId: "t2", allowedSharedDatastorePrefixes: { kb: ["allowed:"] } },
      ],
      [],
      [],
      [],
      [
        { agentId: "a1", boundName: "kb", datastoreId: "ds-shared" },
        { agentId: "a2", boundName: "kb", datastoreId: "ds-shared" },
      ],
    );

    // One shared Datastore provider instance across both runs — a real
    // deployment has exactly one PostgresDatastore behind both agents too.
    const sharedProviderDatastore = fakeDatastore();

    let writerCtx: EngineRunContext | undefined;
    const writerEngine = fakeEngine(
      { status: "succeeded", finalText: "", turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      (ctx) => {
        writerCtx = ctx;
      },
    );
    await runAgent(
      "writer-agent",
      {
        llm: noopLlm,
        engine: writerEngine,
        datastore: sharedProviderDatastore,
        secrets: noopSecretCipher,
        memory: fakeMemory(),
      },
      db,
    );
    const writeResult = JSON.parse(await writerCtx!.runSandboxTool("kb_writer", JSON.stringify({ key: "allowed:1" })));
    expect(writeResult).toBe("ok");

    let readerCtx: EngineRunContext | undefined;
    const readerEngine = fakeEngine(
      { status: "succeeded", finalText: "", turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      (ctx) => {
        readerCtx = ctx;
      },
    );
    await runAgent(
      "reader-agent",
      {
        llm: noopLlm,
        engine: readerEngine,
        datastore: sharedProviderDatastore,
        secrets: noopSecretCipher,
        memory: fakeMemory(),
      },
      db,
    );
    const readResult = JSON.parse(await readerCtx!.runSandboxTool("kb_reader", JSON.stringify({ key: "allowed:1" })));
    expect(readResult).toBe("allowed:1-value");

    // Outside the granted prefix, agent B's reader sees nothing, even
    // though the key exists in the underlying shared store for a
    // different key.
    const missResult = JSON.parse(await readerCtx!.runSandboxTool("kb_reader", JSON.stringify({ key: "blocked:1" })));
    expect(missResult).toBeNull();
  });

  it("scopes a sandboxed tool's secrets access to its declared allowedSecrets", async () => {
    const db = fakeDb(
      [{ id: "a1", name: "scoped-secrets", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 }],
      [
        {
          id: "t1",
          name: "read_secret",
          description: "x",
          paramsZod: "z.object({ name: z.string() })",
          jsonSchema: {},
          code: "const v = await secrets.get(params.name); return v === undefined ? null : v;",
        },
      ],
      [{ agentId: "a1", toolId: "t1", allowedSecrets: ["ALLOWED"] }],
      [
        { agentId: "a1", boundName: "ALLOWED", value: "secret-a" },
        { agentId: "a1", boundName: "BLOCKED", value: "secret-b" },
      ],
    );
    let captured: EngineRunContext | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "", turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      (ctx) => {
        captured = ctx;
      },
    );

    await runAgent(
      "scoped-secrets",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: fakeCipher(), memory: fakeMemory() },
      db,
    );

    const allowed = JSON.parse(await captured!.runSandboxTool("read_secret", JSON.stringify({ name: "ALLOWED" })));
    expect(allowed).toBe("secret-a");

    const blocked = JSON.parse(await captured!.runSandboxTool("read_secret", JSON.stringify({ name: "BLOCKED" })));
    expect(blocked).toBeNull();
  });

  it("pins agent fields, tools, and effective budget in a 'load' step so a replay sees first-run values", async () => {
    const agent = { id: "a1", name: "pinned", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 3 };
    const db = fakeDb([agent]);
    const run = await db.run.create({ data: { agentId: "a1" } });

    const record = new Map<string, unknown>();
    const names: string[] = [];
    const step: StepRunner = async (name, fn) => {
      names.push(name);
      if (record.has(name)) return record.get(name) as never;
      const value = await fn();
      record.set(name, JSON.parse(JSON.stringify(value)));
      return value;
    };

    const seenBudgets: number[] = [];
    const engine: Engine = {
      async run(ctx: EngineRunContext) {
        seenBudgets.push(ctx.agent.budgetUsd);
        return {
          status: "succeeded",
          finalText: "",
          turns: 1,
          usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        };
      },
    };
    const providers = {
      llm: noopLlm,
      engine,
      datastore: fakeDatastore(),
      secrets: noopSecretCipher,
      memory: fakeMemory(),
    };

    await executeRun(run.id, providers, db, undefined, step);
    // A resumed workflow re-enters executeRun on a row that is still
    // non-terminal (the crash is what stopped the terminal write from
    // landing) — a terminal row is short-circuited by the pre-flight guard.
    await db.run.update({ where: { id: run.id }, data: { status: "running", finishedAt: null } });
    // Simulate the agent being edited between crash and resume.
    agent.budgetUsd = 999;
    await executeRun(run.id, providers, db, undefined, step);

    expect(names[0]).toBe("load");
    expect(seenBudgets).toEqual([5, 5]);
  });
});

describe("update_tool semantics: a run pins the tool version its load step saw", () => {
  it("a replayed run keeps the code it loaded; a new run picks up the updated code", async () => {
    const tool: FakeTool = {
      id: "t1",
      name: "version",
      description: "d",
      paramsZod: "z.object({})",
      jsonSchema: { type: "object", properties: {} },
      code: "return 'v1';",
    };
    const agent = { id: "a1", name: "pinned-tool", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 3 };
    const db = fakeDb([agent], [tool], [{ agentId: "a1", toolId: "t1" }]);

    // A DBOS-style step runner: a recorded step is replayed, never re-run.
    const record = new Map<string, unknown>();
    const step: StepRunner = async (name, fn) => {
      if (record.has(name)) return record.get(name) as never;
      const value = await fn();
      record.set(name, JSON.parse(JSON.stringify(value)));
      return value;
    };
    const seen: string[] = [];
    const engine: Engine = {
      async run(ctx: EngineRunContext) {
        seen.push(JSON.parse(await ctx.runSandboxTool("version", "{}")) as string);
        return { status: "succeeded", finalText: "", turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } };
      },
    };
    const providers = {
      llm: noopLlm,
      engine,
      datastore: fakeDatastore(),
      secrets: noopSecretCipher,
      memory: fakeMemory(),
    };

    const first = await db.run.create({ data: { agentId: "a1" } });
    await executeRun(first.id, providers, db, undefined, step);
    tool.code = "return 'v2';"; // what update_tool writes
    // The same run resumed after a crash replays its recorded load step.
    await db.run.update({ where: { id: first.id }, data: { status: "running", finishedAt: null } });
    await executeRun(first.id, providers, db, undefined, step);
    // A new run loads afresh.
    const second = await db.run.create({ data: { agentId: "a1" } });
    await executeRun(second.id, providers, db);

    expect(seen).toEqual(["v1", "v1", "v2"]);
  });
});

describe("executeRun terminal-write races", () => {
  const noTools: FakeTool[] = [];

  function pendingRun(agentBudget = 5) {
    const db = fakeDb(
      [{ id: "a1", name: "racer", systemPrompt: "sys", model: "m", budgetUsd: agentBudget, maxTurns: 3 }],
      noTools,
    );
    return db;
  }

  it("lets the first terminal write win: a second attempt's result is discarded", async () => {
    const db = pendingRun();
    const run = await db.run.create({ data: { agentId: "a1" } });
    const providers = (engine: Engine) => ({
      llm: noopLlm,
      engine,
      datastore: fakeDatastore(),
      secrets: noopSecretCipher,
      memory: fakeMemory(),
    });

    const first = await executeRun(
      run.id,
      providers(
        fakeEngine({
          status: "succeeded",
          finalText: "first wins",
          turns: 2,
          usage: { tokensIn: 5, tokensOut: 6, costUsd: 0.02 },
        }),
      ),
      db,
    );
    expect(first.status).toBe("succeeded");

    // The still-live original attempt returns after the adopted attempt
    // already finished the run. Its write must be a no-op.
    let secondEngineCalled = false;
    const second = await executeRun(
      run.id,
      providers(
        fakeEngine(
          {
            status: "failed",
            finalText: "",
            turns: 1,
            usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.5 },
            error: "late loser",
          },
          () => {
            secondEngineCalled = true;
          },
        ),
      ),
      db,
    );

    expect(secondEngineCalled).toBe(false);
    expect(second.status).toBe("succeeded");
    expect(second.finalText).toBe("first wins");
    expect(second.error).toBeNull();
    expect(second.costUsd).toBe(0.02);
    const stored = await db.run.findUnique({ where: { id: run.id } });
    expect(stored?.status).toBe("succeeded");
  });

  it("does not resurrect a run the reconciler already marked lost: no engine call, row untouched", async () => {
    const db = pendingRun();
    const run = await db.run.create({ data: { agentId: "a1" } });
    await db.run.update({
      where: { id: run.id },
      data: { status: "lost", error: "Orphaned: no heartbeat.", finishedAt: new Date() },
    });

    let engineCalled = false;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "resurrected", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 9 } },
      () => {
        engineCalled = true;
      },
    );

    const result = await executeRun(
      run.id,
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(engineCalled).toBe(false);
    expect(result.status).toBe("lost");
    expect(result.error).toBe("Orphaned: no heartbeat.");
    expect(result.finalText).toBeUndefined();
  });

  it("persists a cancelled status (not failed) when the backstop catches a RunCancelledError", async () => {
    const db = pendingRun();
    const run = await db.run.create({ data: { agentId: "a1" } });
    const engine: Engine = {
      async run() {
        throw new RunCancelledError("Run cancelled: operator cancelled");
      },
    };

    const result = await executeRun(
      run.id,
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
      db,
    );

    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("Run cancelled: operator cancelled");
    expect(result.finishedAt).not.toBeNull();
  });
});

describe("coding agents on a deployment without a container executor", () => {
  const codingAgent: FakeAgent = {
    id: "c1",
    name: "coder",
    systemPrompt: "sys",
    model: "m",
    budgetUsd: 1,
    maxTurns: 3,
    kind: "coding",
  };
  const providers = {
    llm: noopLlm,
    engine: fakeEngine({
      status: "succeeded",
      finalText: "",
      turns: 0,
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    }),
    datastore: fakeDatastore(),
    secrets: noopSecretCipher,
    memory: fakeMemory(),
  };
  // The message must name the real cause (no container executor configured)
  // and the fix, not read as if Phase 5 were unbuilt.
  const expectedCause = /container executor.*JOB_LAUNCHER=local/;

  it("runAgent refuses up front, naming the missing executor", async () => {
    const db = fakeDb([codingAgent]);
    await expect(runAgent("coder", providers, db)).rejects.toThrow(expectedCause);
  });

  it("executeRun fails an existing coding run with the same explanation, spending nothing", async () => {
    const db = fakeDb([codingAgent]);
    const run = await db.run.create({ data: { agentId: "c1" } });
    const result = await executeRun(run.id, providers, db);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(expectedCause);
    expect(result.error).not.toMatch(/Phase 5/);
    expect(Number(result.costUsd)).toBe(0);
  });
});
