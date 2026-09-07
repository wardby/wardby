import { describe, expect, it } from "vitest";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import type { Engine, EngineResult, EngineRunContext } from "../providers/engine/types.js";
import type { LlmProvider } from "../providers/index.js";
import type { SecretCipher } from "../providers/secrets/types.js";
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
  kind?: "native" | "coding";
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
}

function fakeDb(
  agents: FakeAgent[],
  tools: FakeTool[] = [],
  attachments: FakeAttachment[] = [],
  secretsData: { agentId: string; name: string; value: string }[] = [],
): RunnerDb {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const toolsById = new Map(tools.map((t) => [t.id, t]));
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
    agentSecret: {
      findFirst: (async ({ where }: any) => {
        const row = secretsData.find((s) => s.agentId === where.agentId && s.name === where.secret.name);
        return row ? { secret: { ciphertext: row.value } } : null;
      }) as any,
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
      runAgent("coder", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher }, db),
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
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher },
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
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher },
      db,
    );

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

    await runAgent("solo", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher }, db);

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

    await runAgent("weatherbot", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher }, db);

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

    await runAgent("doubler", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher }, db);

    expect(JSON.parse(results[0])).toEqual({ doubled: 42 });
    expect(JSON.parse(results[1]).error).toBe("validation_failed");
    expect(JSON.parse(results[2]).error).toBe("unknown_tool");
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

    await runAgent("pinger", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher }, db);

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
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher },
      db,
    );

    expect(run.status).toBe("failed");
    expect(run.error).toBe("engine bug");
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
      runAgent("ghost", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher }, db),
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

    await runAgent("scoped-ds", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher }, db);

    const allowed = JSON.parse(await captured!.runSandboxTool("write_key", JSON.stringify({ key: "allowed:1" })));
    expect(allowed).toBe("ok");

    const blocked = JSON.parse(await captured!.runSandboxTool("write_key", JSON.stringify({ key: "blocked:1" })));
    expect(blocked).toMatchObject({
      error: "thrown",
      message: expect.stringContaining("datastore_prefix_not_allowed"),
    });
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
        { agentId: "a1", name: "ALLOWED", value: "secret-a" },
        { agentId: "a1", name: "BLOCKED", value: "secret-b" },
      ],
    );
    let captured: EngineRunContext | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "", turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      (ctx) => {
        captured = ctx;
      },
    );

    await runAgent("scoped-secrets", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: fakeCipher() }, db);

    const allowed = JSON.parse(await captured!.runSandboxTool("read_secret", JSON.stringify({ name: "ALLOWED" })));
    expect(allowed).toBe("secret-a");

    const blocked = JSON.parse(await captured!.runSandboxTool("read_secret", JSON.stringify({ name: "BLOCKED" })));
    expect(blocked).toBeNull();
  });
});
