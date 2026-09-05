import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { OpenAiLlmProvider } from "./openai.js";
import type { LlmStreamEvent } from "./types.js";

function fakeOpenAiClient(chunks: unknown[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          async function* generator() {
            for (const chunk of chunks) yield chunk;
          }
          return generator();
        },
      },
    },
  } as unknown as OpenAI;
}

describe("OpenAiLlmProvider tool-call reassembly", () => {
  it("reassembles tool-call deltas fragmented across chunks into one tool_call event", async () => {
    // OpenAI streams function.arguments in pieces, keyed by tool_calls[].index.
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weath" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "er" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Boston"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
      },
    ];
    const llm = new OpenAiLlmProvider("fake-key", fakeOpenAiClient(chunks));

    const events: LlmStreamEvent[] = [];
    for await (const event of llm.stream({ model: "gpt-4o-mini", messages: [{ role: "user", content: "weather?" }] })) {
      events.push(event);
    }

    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "get_weather",
      argsJson: '{"city":"Boston"}',
    });
  });

  it("reassembles two concurrent tool calls by index independently", async () => {
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", function: { name: "toolA", arguments: "{}" } },
                { index: 1, id: "call_b", function: { name: "toolB", arguments: '{"x":1}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];
    const llm = new OpenAiLlmProvider("fake-key", fakeOpenAiClient(chunks));

    const events: LlmStreamEvent[] = [];
    for await (const event of llm.stream({ model: "gpt-4o-mini", messages: [] })) {
      events.push(event);
    }

    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents).toEqual([
      { type: "tool_call", id: "call_a", name: "toolA", argsJson: "{}" },
      { type: "tool_call", id: "call_b", name: "toolB", argsJson: '{"x":1}' },
    ]);
  });

  it("still emits text/done as before for a text-only stream", async () => {
    const chunks = [
      { choices: [{ delta: { content: "hel" } }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ];
    const llm = new OpenAiLlmProvider("fake-key", fakeOpenAiClient(chunks));

    const events: LlmStreamEvent[] = [];
    for await (const event of llm.stream({ model: "gpt-4o-mini", messages: [] })) {
      events.push(event);
    }

    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual([
      "hel",
      "lo",
    ]);
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(0);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") {
      expect(done.usage.inputTokens).toBe(3);
      expect(done.usage.outputTokens).toBe(2);
    }
  });
});
