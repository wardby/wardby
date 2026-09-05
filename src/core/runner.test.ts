import { describe, expect, it } from "vitest";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import type { Engine, EngineResult, EngineRunContext } from "../providers/engine/types.js";
import type { LlmProvider } from "../providers/index.js";
import { runAgent, type RunnerDb } from "./runner.js";

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
}

interface FakeTool {
  id: string;
  name: string;
  description: string;
  paramsZod: string;
  jsonSchema: Record<string, unknown>;
  code: string;
}

function fakeDb(
  agents: FakeAgent[],
  tools: FakeTool[] = [],
  attachments: { agentId: string; toolId: string }[] = [],
): RunnerDb {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const toolsById = new Map(tools.map((t) => [t.id, t]));
  const runs = new Map<string, any>();
  let counter = 0;

  return {
    agent: {
      findUnique: (async ({ where }: any) =>
        (where.name ? byName.get(where.name) : byId.get(where.id)) ?? null) as any,
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
      update: (async ({ where, data }: any) => {
        const record = { ...runs.get(where.id), ...data };
        runs.set(where.id, record);
        return record;
      }) as any,
    },
    agentTool: {
      findMany: (async ({ where }: any) =>
        attachments
          .filter((a) => a.agentId === where.agentId)
          .map((a) => ({ ...a, tool: toolsById.get(a.toolId) }))) as any,
    },
  } as unknown as RunnerDb;
}

function fakeDatastore(): Datastore {
  const store = new Map<string, DatastoreValue>();
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
  };
}

const noopLlm = {} as LlmProvider;

function fakeEngine(result: EngineResult, capture?: (ctx: EngineRunContext) => void): Engine {
  return {
    async run(ctx) {
      capture?.(ctx);
      return result;
    },
  };
}

describe("runAgent", () => {
  it("persists the engine's result onto the run", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", systemPrompt: "be nice", model: "m", budgetUsd: 10, maxTurns: 10 }]);
    const engine = fakeEngine({
      status: "succeeded",
      finalText: "hi there",
      turns: 1,
      usage: { tokensIn: 13, tokensOut: 8, costUsd: 0.0005 },
    });

    const run = await runAgent("greeter", { llm: noopLlm, engine, datastore: fakeDatastore() }, db);

    expect(run.status).toBe("succeeded");
    expect(run.tokensIn).toBe(13);
    expect(run.tokensOut).toBe(8);
    expect(run.costUsd).toBe(0.0005);
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

    const run = await runAgent("tight", { llm: noopLlm, engine, datastore: fakeDatastore() }, db);

    expect(run.status).toBe("refused");
    expect(run.error).toBe("Estimated input cost exceeds budget before any LLM call.");
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

    await runAgent("solo", { llm: noopLlm, engine, datastore: fakeDatastore() }, db);

    expect(captured?.agent).toEqual({ systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 7 });
    expect(captured?.tools).toEqual([]);
  });

  it("loads attached tools' cached JSON Schema for the engine (not re-derived per run)", async () => {
    // jsonSchema is derived once at `reevo tool create` time (cli.ts) and
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

    await runAgent("weatherbot", { llm: noopLlm, engine, datastore: fakeDatastore() }, db);

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

    await runAgent("doubler", { llm: noopLlm, engine, datastore: fakeDatastore() }, db);

    expect(JSON.parse(results[0])).toEqual({ doubled: 42 });
    expect(JSON.parse(results[1]).error).toBe("validation_failed");
    expect(JSON.parse(results[2]).error).toBe("unknown_tool");
  });

  it("marks the run failed when the engine throws unexpectedly", async () => {
    const db = fakeDb([{ id: "a1", name: "flaky", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 }]);
    const engine: Engine = {
      async run() {
        throw new Error("engine bug");
      },
    };

    const run = await runAgent("flaky", { llm: noopLlm, engine, datastore: fakeDatastore() }, db);

    expect(run.status).toBe("failed");
    expect(run.error).toBe("engine bug");
  });

  it("throws for an unknown agent without creating a Run", async () => {
    const db = fakeDb([]);
    const engine = fakeEngine({ status: "succeeded", finalText: "", turns: 0, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } });

    await expect(runAgent("ghost", { llm: noopLlm, engine, datastore: fakeDatastore() }, db)).rejects.toThrow(
      /Unknown agent/,
    );
  });
});
