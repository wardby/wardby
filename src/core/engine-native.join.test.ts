import { describe, expect, it, vi } from "vitest";
import type { LlmProvider, LlmRequest, LlmStreamEvent } from "../providers/index.js";
import type { EngineJoin, EngineJoinAnswer, EngineRunContext, StepRunner } from "../providers/engine/types.js";
import { INTERRUPTED_TOOL_RESULT, JOIN_DEADLINE_MARGIN_MS, NativeEngine } from "./engine-native.js";
import { JOIN_INSTRUCTIONS_BASE, JOINED_MESSAGE_PREFIX } from "./join-wording.js";

const USAGE = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 };
const text = (delta: string): LlmStreamEvent[] => [
  { type: "text", delta },
  { type: "done", stopReason: "end_turn", usage: USAGE },
];
const toolCalls = (...ids: string[]): LlmStreamEvent[] => [
  ...ids.map((id) => ({ type: "tool_call" as const, id, name: "t", argsJson: "{}" })),
  { type: "done", stopReason: "tool_calls", usage: USAGE },
];

type Script = LlmStreamEvent[] | ((signal?: AbortSignal) => AsyncIterable<LlmStreamEvent>);

function scriptedLlm(turns: Script[]): LlmProvider & { calls: LlmRequest[] } {
  let index = 0;
  const calls: LlmRequest[] = [];
  return {
    calls,
    async *stream(req, signal) {
      calls.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
      const script = turns[index++] ?? text("");
      if (typeof script === "function") {
        yield* script(signal);
        return;
      }
      for (const event of script) yield event;
    },
    countTokens: async () => 1,
    priceUsd: () => 0.001,
  };
}

/** A join whose polls answer from a script (then: nobody joined); records each poll. */
function scriptedJoin(answers: Partial<EngineJoinAnswer>[], opts: { interrupt?: () => boolean } = {}) {
  const polls: { after: number; joined: boolean; wait: boolean }[] = [];
  const join: EngineJoin & { polls: typeof polls } = {
    polls,
    poll: vi.fn(async (request) => {
      polls.push(request);
      const next = answers.shift() ?? {};
      return { joined: false, messages: [], now: 1_000, ...next };
    }),
    interruptPending: vi.fn(async () => opts.interrupt?.() ?? false),
    interruptCheckMs: 5,
  };
  return join;
}

function context(llm: LlmProvider, join: EngineJoin, overrides: Partial<EngineRunContext> = {}): EngineRunContext {
  return {
    agent: { systemPrompt: "sys", model: "m", budgetUsd: 1000, maxTurns: 10 },
    tools: [{ name: "t", description: "t", jsonSchema: { type: "object" } }],
    providers: { llm },
    runSandboxTool: vi.fn(async () => '{"ok":true}'),
    join,
    ...overrides,
  };
}

const msg = (seq: number, body: string, interrupt = false) => ({ seq, text: body, interrupt });

function recordingStep(record: Map<string, unknown>, names: string[]): StepRunner {
  return async (name, fn) => {
    names.push(name);
    if (record.has(name)) return record.get(name) as never;
    const value = await fn();
    record.set(name, JSON.parse(JSON.stringify(value)));
    return value;
  };
}

describe("NativeEngine join", () => {
  it("without join behaves as before: no join instructions, no polls", async () => {
    const llm = scriptedLlm([text("done")]);
    const ctx = context(llm, scriptedJoin([]));
    delete ctx.join;
    const result = await new NativeEngine().run(ctx);
    expect(result).toMatchObject({ status: "succeeded", finalText: "done", turns: 1 });
    expect(llm.calls[0].messages[0].content).not.toContain(JOIN_INSTRUCTIONS_BASE);
  });

  it("tells the model joined messages come from people allowed to direct the run", async () => {
    const llm = scriptedLlm([text("done")]);
    await new NativeEngine().run(context(llm, scriptedJoin([])));
    expect(llm.calls[0].messages[0].content).toContain(JOIN_INSTRUCTIONS_BASE);
    expect(JOIN_INSTRUCTIONS_BASE).toContain("not a prompt");
  });

  it("delivers a message after a turn's tool results, before the next model turn", async () => {
    const llm = scriptedLlm([toolCalls("c1"), text("PINEAPPLE: done")]);
    const join = scriptedJoin([{ joined: true, messages: [msg(2, "start with PINEAPPLE")] }]);
    const result = await new NativeEngine().run(context(llm, join));
    expect(result).toMatchObject({ status: "succeeded", finalText: "PINEAPPLE: done", turns: 2 });
    const last = llm.calls[1].messages.at(-1);
    expect(last).toEqual({ role: "user", content: `${JOINED_MESSAGE_PREFIX}\n\nstart with PINEAPPLE` });
    expect(join.polls[0]).toEqual({ after: 0, joined: false, wait: false });
    // The next poll asks only for what came after the delivered message.
    expect(join.polls[1].after).toBe(2);
  });

  it("waits for the next message while someone is joined, and ends when the last person leaves", async () => {
    const llm = scriptedLlm([text("first"), text("second")]);
    const join = scriptedJoin([
      { joined: true },
      { joined: true, messages: [msg(3, "more please")] },
      { joined: false },
    ]);
    const names: string[] = [];
    const result = await new NativeEngine().run(context(llm, join, { step: recordingStep(new Map(), names) }));
    expect(result).toMatchObject({ status: "succeeded", finalText: "second", turns: 2 });
    expect(join.polls.map((p) => p.wait)).toEqual([false, true, true]);
    expect(names.filter((n) => n.startsWith("join:"))).toEqual(["join:1:check", "join:2:wait", "join:3:wait"]);
  });

  it("stops waiting a minute before the run's deadline", async () => {
    const deadlineAt = 100_000;
    const llm = scriptedLlm([text("answer")]);
    const join = scriptedJoin([
      { joined: true, now: 10_000 },
      { joined: true, now: deadlineAt - JOIN_DEADLINE_MARGIN_MS },
    ]);
    const result = await new NativeEngine().run(context(llm, join, { deadlineAt }));
    expect(result).toMatchObject({ status: "succeeded", finalText: "answer" });
    expect(join.polls).toHaveLength(2);
  });

  it("counts maxTurns from the latest message: a joined message gets turns of its own", async () => {
    const llm = scriptedLlm([toolCalls("c1"), toolCalls("c2"), text("never")]);
    const join = scriptedJoin([{ joined: true, messages: [msg(2, "one more step")] }]);
    const ctx = context(llm, join);
    ctx.agent = { ...ctx.agent, maxTurns: 1 };
    const result = await new NativeEngine().run(ctx);
    // Turn 1 used the task's turn; the message bought turn 2; turn 3 was over the limit again.
    expect(result).toMatchObject({ status: "succeeded", turns: 2 });
    expect(llm.calls).toHaveLength(2);
  });

  it("an interrupt stops the model reply at once; the interrupt is the next message", async () => {
    let interrupted = false;
    const llm = scriptedLlm([
      async function* (signal) {
        yield { type: "text", delta: "partial" };
        interrupted = true;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      },
      text("changed course"),
    ]);
    const join = scriptedJoin([{ joined: true, messages: [msg(4, "stop that", true)] }], {
      interrupt: () => interrupted,
    });
    const result = await new NativeEngine().run(context(llm, join));
    expect(result).toMatchObject({ status: "succeeded", finalText: "changed course", turns: 2 });
    expect(llm.calls[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "partial" },
      { role: "user", content: `${JOINED_MESSAGE_PREFIX}\n\nstop that` },
    ]);
    expect(result.usage.costUsd).toBeGreaterThan(0);
  });

  it("an interrupt during tool calls lets the running call finish and skips the rest", async () => {
    let interrupted = false;
    const runSandboxTool = vi.fn(async () => {
      interrupted = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return '{"ok":1}';
    });
    const llm = scriptedLlm([toolCalls("c1", "c2"), text("ok")]);
    const join = scriptedJoin([{ joined: true, messages: [msg(5, "wait", true)] }], { interrupt: () => interrupted });
    const result = await new NativeEngine().run(context(llm, join, { runSandboxTool }));
    expect(result.status).toBe("succeeded");
    expect(runSandboxTool).toHaveBeenCalledTimes(1);
    const toolMessages = llm.calls[1].messages.filter((m) => m.role === "tool");
    expect(toolMessages[1].content).toContain(INTERRUPTED_TOOL_RESULT);
  });

  it("a replay sees the same joined messages from its recorded steps, without polling again", async () => {
    const record = new Map<string, unknown>();
    const run = async (join: EngineJoin) => {
      const llm = scriptedLlm([toolCalls("c1"), text("done")]);
      const result = await new NativeEngine().run(context(llm, join, { step: recordingStep(record, []) }));
      return { result, llm };
    };
    const first = await run(scriptedJoin([{ joined: false, messages: [msg(2, "hello")] }]));
    const replayJoin = scriptedJoin([]);
    const second = await run(replayJoin);
    expect(replayJoin.poll).not.toHaveBeenCalled();
    expect(second.result).toEqual(first.result);
  });
});
