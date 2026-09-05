import { describe, expect, it, vi } from "vitest";
import type { LlmProvider, LlmStreamEvent } from "../providers/index.js";
import { runAgent, type RunnerDb } from "./runner.js";

interface FakeAgent {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  budgetUsd: number;
}

function fakeDb(agents: FakeAgent[]): RunnerDb {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const runs = new Map<string, any>();
  let counter = 0;

  return {
    agent: {
      findUnique: (async ({ where }: any) => byName.get(where.name) ?? null) as any,
    },
    run: {
      create: (async ({ data }: any) => {
        const id = `run_${++counter}`;
        const record = {
          id,
          status: "pending",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
          ...data,
        };
        runs.set(id, record);
        return record;
      }) as any,
      update: (async ({ where, data }: any) => {
        const record = { ...runs.get(where.id), ...data };
        runs.set(where.id, record);
        return record;
      }) as any,
    },
  } as unknown as RunnerDb;
}

// Cheap fake tokenizer: one token per character, so cost math is predictable.
function charCountingLlm(opts: {
  events: LlmStreamEvent[];
  inputPerMTok: number;
  outputPerMTok: number;
  onStream?: (signal?: AbortSignal) => void;
}): LlmProvider {
  return {
    async *stream(_req, signal) {
      opts.onStream?.(signal);
      for (const event of opts.events) {
        if (signal?.aborted) return;
        yield event;
      }
    },
    async countTokens(_model, messages) {
      return messages.reduce((sum, m) => sum + m.content.length, 0);
    },
    priceUsd(_model, usage) {
      return (
        (usage.inputTokens / 1_000_000) * opts.inputPerMTok +
        (usage.outputTokens / 1_000_000) * opts.outputPerMTok
      );
    },
  };
}

describe("runAgent", () => {
  it("succeeds and persists usage/cost from the done event", async () => {
    const db = fakeDb([
      { id: "a1", name: "greeter", systemPrompt: "be nice", model: "m", budgetUsd: 10 },
    ]);
    const llm = charCountingLlm({
      events: [
        { type: "text", delta: "hi" },
        { type: "text", delta: " there" },
        {
          // inputTokens (13) matches the fake tokenizer's own pre-flight count
          // for "be nice" + "Begin." so this test doesn't also trip a
          // calibration warning — that's covered by its own test below.
          type: "done",
          stopReason: "stop",
          usage: { inputTokens: 13, outputTokens: 8, costUsd: 0.0005 },
        },
      ],
      inputPerMTok: 1,
      outputPerMTok: 1,
    });

    let streamed = "";
    const run = await runAgent("greeter", { llm }, db, (delta) => (streamed += delta));

    expect(run.status).toBe("succeeded");
    expect(run.tokensIn).toBe(13);
    expect(run.tokensOut).toBe(8);
    expect(run.costUsd).toBe(0.0005);
    expect(streamed).toBe("hi there");
  });

  it("logs a non-blocking calibration warning when the estimate diverges from actual usage, without affecting the outcome", async () => {
    const db = fakeDb([
      { id: "a1", name: "driftER", systemPrompt: "be nice", model: "m", budgetUsd: 10 },
    ]);
    // Fake tokenizer estimates 13 input tokens ("be nice" + "Begin."); real
    // usage reports 100 — a huge (dangerous, under-the-real-count) drift.
    const llm = charCountingLlm({
      events: [
        { type: "text", delta: "hi" },
        {
          type: "done",
          stopReason: "stop",
          usage: { inputTokens: 100, outputTokens: 1, costUsd: 0.0001 },
        },
      ],
      inputPerMTok: 1,
      outputPerMTok: 1,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = await runAgent("driftER", { llm }, db);
      expect(run.status).toBe("succeeded");
      expect(run.tokensIn).toBe(100);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/token calibration drift/);
      expect(warnSpy.mock.calls[0][0]).toMatch(/UNDERestimated/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("refuses before any LLM call when the input estimate already meets budget", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "expensive",
        systemPrompt: "x".repeat(1000),
        model: "m",
        budgetUsd: 0.0001,
      },
    ]);
    let streamCalled = false;
    const llm = charCountingLlm({
      events: [],
      inputPerMTok: 10,
      outputPerMTok: 10,
      onStream: () => {
        streamCalled = true;
      },
    });

    const run = await runAgent("expensive", { llm }, db);

    expect(run.status).toBe("refused");
    expect(run.error).toMatch(/before any LLM call/);
    expect(streamCalled).toBe(false);
  });

  it("aborts mid-stream and marks the run failed when projected cost crosses budget", async () => {
    const db = fakeDb([
      { id: "a1", name: "chatty", systemPrompt: "sys", model: "m", budgetUsd: 0.000_015 },
    ]);
    let abortedSignal: AbortSignal | undefined;
    const llm = charCountingLlm({
      events: [
        { type: "text", delta: "a".repeat(5) },
        { type: "text", delta: "b".repeat(50) }, // pushes projected cost over budget
        { type: "text", delta: "c".repeat(50) }, // must never be reached
        {
          type: "done",
          stopReason: "stop",
          usage: { inputTokens: 999, outputTokens: 999, costUsd: 999 },
        },
      ],
      inputPerMTok: 1,
      outputPerMTok: 1,
      onStream: (signal) => {
        abortedSignal = signal;
      },
    });

    let streamed = "";
    const run = await runAgent("chatty", { llm }, db, (delta) => (streamed += delta));

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Budget exceeded mid-stream/);
    expect(streamed).toBe("a".repeat(5) + "b".repeat(50));
    expect(abortedSignal?.aborted).toBe(true);
  });

  it("marks the run failed when the provider throws mid-stream", async () => {
    const db = fakeDb([
      { id: "a1", name: "flaky", systemPrompt: "sys", model: "m", budgetUsd: 10 },
    ]);
    const llm: LlmProvider = {
      async *stream() {
        yield { type: "text", delta: "partial" };
        throw new Error("connection reset");
      },
      async countTokens(_model, messages) {
        return messages.reduce((sum, m) => sum + m.content.length, 0);
      },
      priceUsd() {
        return 0;
      },
    };

    const run = await runAgent("flaky", { llm }, db);

    expect(run.status).toBe("failed");
    expect(run.error).toBe("connection reset");
  });

  it("throws for an unknown agent without creating a Run", async () => {
    const db = fakeDb([]);
    const llm = charCountingLlm({ events: [], inputPerMTok: 1, outputPerMTok: 1 });

    await expect(runAgent("ghost", { llm }, db)).rejects.toThrow(/Unknown agent/);
  });
});
