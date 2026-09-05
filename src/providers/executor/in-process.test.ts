import { describe, expect, it } from "vitest";
import type { LlmProvider } from "../llm/types.js";
import type { RunnerDb } from "../../core/runner.js";
import { InProcessExecutor } from "./in-process.js";

interface FakeAgent {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  budgetUsd: number;
}

function fakeDb(agents: FakeAgent[], runs: Record<string, any>): RunnerDb {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const byName = new Map(agents.map((a) => [a.name, a]));
  const store = new Map(Object.entries(runs));

  return {
    agent: {
      findUnique: (async ({ where }: any) =>
        (where.name ? byName.get(where.name) : byId.get(where.id)) ?? null) as any,
    },
    run: {
      findUnique: (async ({ where }: any) => store.get(where.id) ?? null) as any,
      update: (async ({ where, data }: any) => {
        const record = { ...store.get(where.id), ...data };
        store.set(where.id, record);
        return record;
      }) as any,
      create: (async () => {
        throw new Error("not used in this test");
      }) as any,
    },
  } as unknown as RunnerDb;
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
    };
    const db = fakeDb(
      [agent],
      { run_1: { id: "run_1", agentId: "a1", status: "pending", heartbeatAt: null } },
    );
    const llm = slowLlm(["a", "b", "c"], 15);

    const executor = new InProcessExecutor({ llm }, db, /* heartbeatIntervalMs */ 5);
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
    };
    const db = fakeDb(
      [agent],
      { run_1: { id: "run_1", agentId: "a1", status: "pending", heartbeatAt: null } },
    );
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

    const executor = new InProcessExecutor({ llm }, db, 5);
    await executor.start("run_1");

    const finalRun = await db.run.findUnique({ where: { id: "run_1" } });
    expect(finalRun?.status).toBe("failed");
    expect(finalRun?.error).toBe("boom");
  });
});
