import { describe, expect, it } from "vitest";
import type { LlmProvider } from "../llm/types.js";
import type { SecretCipher } from "../secrets/types.js";
import type { Datastore, DatastoreValue } from "../datastore/types.js";
import type { AgentMemoryStore } from "../memory/types.js";
import type { RunnerDb } from "../../core/runner.js";
import { NativeEngine } from "../../core/engine-native.js";
import { InProcessExecutor } from "./in-process.js";

interface FakeAgent {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  budgetUsd: number;
  maxTurns: number;
}

function fakeDb(agents: FakeAgent[], runs: Record<string, any>): RunnerDb {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const byName = new Map(agents.map((a) => [a.name, a]));
  const store = new Map(Object.entries(runs));

  return {
    agent: {
      findUnique: (async ({ where }: any) => (where.name ? byName.get(where.name) : byId.get(where.id)) ?? null) as any,
    },
    run: {
      findUnique: (async ({ where }: any) => store.get(where.id) ?? null) as any,
      findUniqueOrThrow: (async ({ where }: any) => {
        const record = store.get(where.id);
        if (!record) throw new Error(`No Run with id "${where.id}".`);
        return record;
      }) as any,
      update: (async ({ where, data }: any) => {
        const record = { ...store.get(where.id), ...data };
        store.set(where.id, record);
        return record;
      }) as any,
      // executeRun's writes are conditional on the run still being drivable
      // (pending/running) so the first terminal write wins — the fake has to
      // apply that filter, or these tests would not exercise the real path.
      updateMany: (async ({ where, data }: any) => {
        const record = store.get(where.id);
        if (!record) return { count: 0 };
        if (where.status !== undefined) {
          const allowed = typeof where.status === "string" ? [where.status] : where.status.in;
          if (!allowed.includes(record.status)) return { count: 0 };
        }
        store.set(where.id, { ...record, ...data });
        return { count: 1 };
      }) as any,
      create: (async () => {
        throw new Error("not used in this test");
      }) as any,
    },
    agentTool: {
      findMany: (async () => []) as any,
    },
    agentSecret: {
      findMany: (async () => []) as any,
    },
    agentSubAgent: {
      findFirst: (async () => null) as any,
      findMany: (async () => []) as any,
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
    async list() {
      return [];
    },
    async getShared() {
      return undefined;
    },
    async setShared() {},
    async deleteShared() {},
    async listShared() {
      return [];
    },
  };
}

// Slow fake provider: yields deltas with a real delay so multiple heartbeat
// ticks land during a single run.
function slowLlm(deltas: string[], delayMs: number): LlmProvider {
  return {
    async *stream() {
      for (const delta of deltas) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield { type: "text" as const, delta };
      }
      yield {
        // inputTokens (9) matches the fake tokenizer's count for "sys" +
        // "Begin." so this test doesn't also trip a calibration warning.
        type: "done" as const,
        stopReason: "stop",
        usage: { inputTokens: 9, outputTokens: deltas.length, costUsd: 0.0001 },
      };
    },
    async countTokens(_model, messages) {
      return messages.reduce((sum, m) => sum + m.content.length, 0);
    },
    priceUsd() {
      return 0.0001;
    },
  };
}

describe("InProcessExecutor", () => {
  it("beats the heartbeat on an interval while the run executes, then stops", async () => {
    const agent: FakeAgent = {
      id: "a1",
      name: "heartbeater",
      systemPrompt: "sys",
      model: "m",
      budgetUsd: 10,
      maxTurns: 10,
    };
    const db = fakeDb([agent], { run_1: { id: "run_1", agentId: "a1", status: "pending", heartbeatAt: null } });
    const llm = slowLlm(["a", "b", "c"], 15);

    const executor = new InProcessExecutor(
      {
        llm,
        engine: new NativeEngine(),
        datastore: fakeDatastore(),
        secrets: {} as SecretCipher,
        memory: {} as AgentMemoryStore,
      },
      db,
      /* heartbeatIntervalMs */ 5,
    );
    await executor.start("run_1");

    const finalRun = await db.run.findUnique({ where: { id: "run_1" } });
    expect(finalRun?.status).toBe("succeeded");
    // At least one heartbeat was recorded (the immediate one on start).
    expect(finalRun?.heartbeatAt).not.toBeNull();
  });

  it("still reaches a terminal state (and stops heartbeating) when the run fails", async () => {
    const agent: FakeAgent = {
      id: "a1",
      name: "flaky",
      systemPrompt: "sys",
      model: "m",
      budgetUsd: 10,
      maxTurns: 10,
    };
    const db = fakeDb([agent], { run_1: { id: "run_1", agentId: "a1", status: "pending", heartbeatAt: null } });
    const llm: LlmProvider = {
      async *stream() {
        yield { type: "text", delta: "x" };
        throw new Error("boom");
      },
      async countTokens(_model, messages) {
        return messages.reduce((sum, m) => sum + m.content.length, 0);
      },
      priceUsd() {
        return 0;
      },
    };

    const executor = new InProcessExecutor(
      {
        llm,
        engine: new NativeEngine(),
        datastore: fakeDatastore(),
        secrets: {} as SecretCipher,
        memory: {} as AgentMemoryStore,
      },
      db,
      5,
    );
    await executor.start("run_1");

    const finalRun = await db.run.findUnique({ where: { id: "run_1" } });
    expect(finalRun?.status).toBe("failed");
    expect(finalRun?.error).toBe("boom");
  });
  it("stop records a pending run cancelled, and starting it afterwards runs nothing", async () => {
    const agent: FakeAgent = { id: "a1", name: "never", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 };
    const db = fakeDb([agent], { run_1: { id: "run_1", agentId: "a1", status: "pending", heartbeatAt: null } });
    let calls = 0;
    const base = slowLlm(["x"], 0);
    const llm: LlmProvider = {
      ...base,
      stream: (...args: Parameters<LlmProvider["stream"]>) => {
        calls += 1;
        return base.stream(...args);
      },
    };
    const executor = new InProcessExecutor(
      {
        llm,
        engine: new NativeEngine(),
        datastore: fakeDatastore(),
        secrets: {} as SecretCipher,
        memory: {} as AgentMemoryStore,
      },
      db,
      5,
    );
    await executor.stop("run_1", "Stopped by p1 with stop_run.");
    await executor.start("run_1");
    const finalRun = await db.run.findUnique({ where: { id: "run_1" } });
    expect(finalRun).toMatchObject({ status: "cancelled", error: "Stopped by p1 with stop_run." });
    expect(calls).toBe(0);
  });

  it("stops a running run at its next step boundary, keeping the stop's reason", async () => {
    const agent: FakeAgent = { id: "a1", name: "looper", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 };
    const db = fakeDb([agent], { run_1: { id: "run_1", agentId: "a1", status: "pending", heartbeatAt: null } });
    let calls = 0;
    const ref: { executor?: InProcessExecutor } = {};
    const llm: LlmProvider = {
      async *stream() {
        calls += 1;
        // The stop lands while this turn is in flight (from another process, in production).
        await ref.executor!.stop("run_1", "operator stopped it");
        yield { type: "tool_call" as const, id: "c1", name: "anything", argsJson: "{}" };
        yield {
          type: "done" as const,
          stopReason: "tool_use",
          usage: { inputTokens: 9, outputTokens: 1, costUsd: 0.0001 },
        };
      },
      async countTokens(_model, messages) {
        return messages.reduce((sum, m) => sum + m.content.length, 0);
      },
      priceUsd() {
        return 0.0001;
      },
    };
    const executor = (ref.executor = new InProcessExecutor(
      {
        llm,
        engine: new NativeEngine(),
        datastore: fakeDatastore(),
        secrets: {} as SecretCipher,
        memory: {} as AgentMemoryStore,
      },
      db,
      5,
    ));
    await executor.start("run_1");
    const finalRun = await db.run.findUnique({ where: { id: "run_1" } });
    expect(finalRun).toMatchObject({ status: "cancelled", error: "operator stopped it" });
    // The tool call and any later turn never ran.
    expect(calls).toBe(1);
  });

  it("stop leaves a finished run alone", async () => {
    const db = fakeDb([], { run_1: { id: "run_1", agentId: "a1", status: "succeeded", error: null } });
    const executor = new InProcessExecutor(
      {
        llm: slowLlm([], 0),
        engine: new NativeEngine(),
        datastore: fakeDatastore(),
        secrets: {} as SecretCipher,
        memory: {} as AgentMemoryStore,
      },
      db,
    );
    await executor.stop("run_1", "too late");
    expect(await db.run.findUnique({ where: { id: "run_1" } })).toMatchObject({ status: "succeeded", error: null });
  });
});
