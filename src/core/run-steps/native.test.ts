import { describe, expect, it, vi } from "vitest";
import {
  NativeStreamSteps,
  STREAM_STEPS_BOUND_MS,
  nativeRequestResults,
  nativeToolResults,
  nativeToolStatus,
  nativeTurnSteps,
  recordStreamSteps,
  runStepsHook,
} from "./native.js";
import type { LlmMessage } from "../../providers/llm/types.js";
import { UNTRUSTED_TOOL_OUTPUT_TAG } from "../untrusted-content.js";
import { MAX_RESULT_OUTPUT_CHARS, MAX_STEP_TEXT_CHARS, type RunStepSink } from "./types.js";

const wrapped = (content: string) => `<untrusted_tool_output>\n${content}\n</untrusted_tool_output>`;

describe("nativeToolStatus", () => {
  it.each([
    ['{"error":"unknown_tool","message":"no"}', "error"],
    [wrapped('{"error":"bridge_error"}'), "error"],
    ['  {\n "error": 1}', "error"],
    ['{"ok":true}', "ok"],
    ["plain text", "ok"],
  ])("%j -> %s", (content, status) => {
    expect(nativeToolStatus(content)).toBe(status);
  });
});

describe("nativeTurnSteps / nativeToolResults", () => {
  it("makes a said step keyed by the turn and a tool step per call", () => {
    expect(
      nativeTurnSteps("turn:1", "Looking up.", [{ id: "c1", name: "lookup", argsJson: '{"query":"weather"}' }]),
    ).toEqual([
      { kind: "said", callId: "said:turn:1", text: "Looking up.", truncated: false },
      {
        kind: "tool",
        callId: "c1",
        tool: "lookup",
        text: "weather",
        truncated: false,
        input: '{"query":"weather"}',
        inputTruncated: false,
      },
    ]);
    expect(nativeTurnSteps("turn:2", "  ", [])).toEqual([]);
    expect(nativeToolResults([{ id: "c1" }, { id: "c2" }], ['{"error":"x"}', "fine"])).toEqual([
      { callId: "c1", status: "error", output: '{"error":"x"}', outputCut: false },
      { callId: "c2", status: "ok", output: "fine", outputCut: false },
    ]);
  });
});

describe("native detail material", () => {
  it("attaches a tool's raw input and the end of its result", () => {
    const args = JSON.stringify({ command: "npm test" });
    const [step] = nativeTurnSteps("t1", "", [{ id: "c1", name: "run_command", argsJson: args }]);
    expect(step).toMatchObject({ kind: "tool", input: args, inputTruncated: false });
    const long = `<${UNTRUSTED_TOOL_OUTPUT_TAG}>\n${"x".repeat(10_000)}END\n</${UNTRUSTED_TOOL_OUTPUT_TAG}>`;
    const [result] = nativeToolResults([{ id: "c1" }], [long]);
    expect(result.output!.endsWith("END")).toBe(true);
    expect(result.output!.length).toBe(MAX_RESULT_OUTPUT_CHARS);
    expect(result.outputCut).toBe(true);
    expect(result.status).toBe("ok");
  });

  it("cuts an over-long input and says so", () => {
    const args = JSON.stringify({ text: "y".repeat(MAX_STEP_TEXT_CHARS + 50) });
    const [step] = nativeTurnSteps("t1", "", [{ id: "c1", name: "lookup", argsJson: args }]);
    expect(step).toMatchObject({ input: args.slice(0, MAX_STEP_TEXT_CHARS), inputTruncated: true });
  });

  it("the gateway's request results carry their output too", () => {
    const results = nativeRequestResults([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_command", argsJson: "{}" }] },
      { role: "tool", toolCallId: "c1", content: '{"error":"boom"}' },
    ] as LlmMessage[]);
    expect(results).toEqual([{ callId: "c1", status: "error", output: '{"error":"boom"}', outputCut: false }]);
  });
});

describe("nativeRequestResults", () => {
  it("reads only the tool results after the newest assistant message", () => {
    expect(
      nativeRequestResults([
        { role: "user", content: "Begin." },
        { role: "assistant", content: "", toolCalls: [{ id: "old", name: "lookup", argsJson: "{}" }] },
        { role: "tool", toolCallId: "old", content: wrapped("ok") },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "lookup", argsJson: "{}" }] },
        { role: "tool", toolCallId: "c1", content: wrapped('{"error":"x"}') },
        { role: "tool", toolCallId: "c2", content: wrapped("done") },
      ]),
    ).toEqual([
      { callId: "c1", status: "error", output: '{"error":"x"}', outputCut: false },
      { callId: "c2", status: "ok", output: "done", outputCut: false },
    ]);
    expect(nativeRequestResults([{ role: "user", content: "Begin." }])).toEqual([]);
  });

  it("still finds the results when a user message (the wind-down note) follows them", () => {
    expect(
      nativeRequestResults([
        { role: "user", content: "Begin." },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "lookup", argsJson: "{}" }] },
        { role: "tool", toolCallId: "c1", content: wrapped('{"error":"x"}') },
        { role: "user", content: "Wrap up now." },
      ]),
    ).toEqual([{ callId: "c1", status: "error", output: '{"error":"x"}', outputCut: false }]);
  });
});

describe("NativeStreamSteps", () => {
  it("collects text and tool calls from model events, and bounds the text", () => {
    const tap = new NativeStreamSteps("call-7");
    tap.observe({ type: "text", delta: "x".repeat(MAX_STEP_TEXT_CHARS) });
    tap.observe({ type: "text", delta: "more" });
    tap.observe({ type: "tool_call", id: "t1", name: "mcp__wardby_mcp__echo", argsJson: '{"text":"hi"}' });
    tap.observe({ type: "done", stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } });
    const [said, tool] = tap.steps();
    // The said id is a hash of the worker's request id: no worker text is stored as an id.
    expect(said).toMatchObject({ kind: "said", callId: "said:4a01086e5a3c8ba8c531dad0cf21c81c", truncated: true });
    expect(said.text).toHaveLength(MAX_STEP_TEXT_CHARS);
    expect(tool).toEqual({
      kind: "tool",
      callId: "t1",
      tool: "mcp:echo",
      text: "hi",
      truncated: false,
      input: '{"text":"hi"}',
      inputTruncated: false,
    });
  });
});

describe("recordStreamSteps", () => {
  const tap = () => {
    const steps = new NativeStreamSteps("call-1");
    steps.observe({ type: "text", delta: "Hi." });
    return steps;
  };
  const messages = [{ role: "tool" as const, toolCallId: "c0", content: "fine" }];

  it("waits for the write, and hands the sink the batch and the extra secret values", async () => {
    let done = false;
    const record = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done = true;
    });
    await recordStreamSteps({ record }, "r1", tap(), messages, ["extra"]);
    expect(done).toBe(true);
    expect(record).toHaveBeenCalledWith(
      "r1",
      {
        steps: [{ kind: "said", callId: expect.stringMatching(/^said:[0-9a-f]{32}$/), text: "Hi.", truncated: false }],
        results: [{ callId: "c0", status: "ok", output: "fine", outputCut: false }],
      },
      ["extra"],
    );
  });

  it("returns at the bound when the write never settles", async () => {
    vi.useFakeTimers();
    try {
      let returned = false;
      const sink: RunStepSink = { record: () => new Promise<void>(() => undefined) };
      void recordStreamSteps(sink, "r1", tap(), messages).then(() => (returned = true));
      await vi.advanceTimersByTimeAsync(STREAM_STEPS_BOUND_MS - 1);
      expect(returned).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(returned).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws: not when building the batch, nor when the sink throws or rejects", async () => {
    const record = vi.fn(async () => undefined);
    const broken = {
      steps: () => {
        throw new Error("bad event");
      },
    };
    await expect(recordStreamSteps({ record }, "r1", broken, messages)).resolves.toBeUndefined();
    expect(record).not.toHaveBeenCalled();
    const throwing: RunStepSink = {
      record: () => {
        throw new Error("sync");
      },
    };
    await expect(recordStreamSteps(throwing, "r1", tap(), messages)).resolves.toBeUndefined();
    const rejecting: RunStepSink = { record: async () => Promise.reject(new Error("db down")) };
    await expect(recordStreamSteps(rejecting, "r1", tap(), messages)).resolves.toBeUndefined();
  });

  it("does nothing without a sink or a tap", async () => {
    const record = vi.fn(async () => undefined);
    await recordStreamSteps(undefined, "r1", tap(), messages);
    await recordStreamSteps({ record }, "r1", undefined, messages);
    expect(record).not.toHaveBeenCalled();
  });
});

describe("runStepsHook", () => {
  it("is absent without a sink", () => {
    expect(runStepsHook(undefined, "r1")).toBeUndefined();
  });

  it("hands each engine event's batch to the sink for the run", () => {
    const sink: RunStepSink = { record: vi.fn(async () => undefined) };
    const hook = runStepsHook(sink, "r1")!;
    hook({ kind: "turn", turn: 3, text: "Hi.", toolCalls: [{ id: "c1", name: "lookup", argsJson: "{}" }] });
    hook({ kind: "results", turn: 3, toolCalls: [{ id: "c1" }], results: ['{"error":"x"}'] });
    expect(sink.record).toHaveBeenNthCalledWith(1, "r1", {
      steps: [
        { kind: "said", callId: "said:turn:3", text: "Hi.", truncated: false },
        expect.objectContaining({ kind: "tool", callId: "c1", tool: "lookup" }),
      ],
      results: [],
    });
    expect(sink.record).toHaveBeenNthCalledWith(2, "r1", {
      steps: [],
      results: [{ callId: "c1", status: "error", output: '{"error":"x"}', outputCut: false }],
    });
  });

  it("records nothing for a turn with no text and no tool calls", () => {
    const sink: RunStepSink = { record: vi.fn(async () => undefined) };
    runStepsHook(sink, "r1")!({ kind: "turn", turn: 1, text: "  ", toolCalls: [] });
    expect(sink.record).not.toHaveBeenCalled();
  });
});
