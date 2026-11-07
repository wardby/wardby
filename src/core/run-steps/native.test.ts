import { describe, expect, it, vi } from "vitest";
import {
  NativeStreamSteps,
  nativeRequestResults,
  nativeToolResults,
  nativeToolStatus,
  nativeTurnSteps,
  runStepsHook,
} from "./native.js";
import { MAX_STEP_TEXT_CHARS, type RunStepSink } from "./types.js";

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
      { kind: "tool", callId: "c1", tool: "lookup", text: "weather", truncated: false },
    ]);
    expect(nativeTurnSteps("turn:2", "  ", [])).toEqual([]);
    expect(nativeToolResults([{ id: "c1" }, { id: "c2" }], ['{"error":"x"}', "fine"])).toEqual([
      { callId: "c1", status: "error" },
      { callId: "c2", status: "ok" },
    ]);
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
      { callId: "c1", status: "error" },
      { callId: "c2", status: "ok" },
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
    ).toEqual([{ callId: "c1", status: "error" }]);
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
    expect(said).toMatchObject({ kind: "said", callId: "said:call-7", truncated: true });
    expect(said.text).toHaveLength(MAX_STEP_TEXT_CHARS);
    expect(tool).toEqual({ kind: "tool", callId: "t1", tool: "mcp:echo", text: "hi", truncated: false });
  });
});

describe("runStepsHook", () => {
  it("hands each batch to the sink for the run, and is absent without a sink", () => {
    expect(runStepsHook(undefined, "r1")).toBeUndefined();
    const sink: RunStepSink = { record: vi.fn(async () => undefined) };
    const batch = { steps: [], results: [{ callId: "c1", status: "ok" as const }] };
    runStepsHook(sink, "r1")!(batch);
    expect(sink.record).toHaveBeenCalledWith("r1", batch);
  });
});
