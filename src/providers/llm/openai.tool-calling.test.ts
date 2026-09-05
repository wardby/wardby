import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { OpenAiLlmProvider, estimateTokens } from "./openai.js";
import type { LlmMessage, LlmStreamEvent, LlmToolDef } from "./types.js";

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

describe("estimateTokens with tools", () => {
  const messages: LlmMessage[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is the weather in Boston?" },
  ];
  const tools: LlmToolDef[] = [
    {
      name: "getWeather",
      description: "Gets the current weather for a named city, returning temperature and conditions.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "The city name, e.g. Boston" },
          units: { type: "string", enum: ["fahrenheit", "celsius"] },
        },
        required: ["city"],
      },
    },
  ];

  it("counts tool schema tokens — the estimate with tools attached must exceed the messages-only estimate", () => {
    // This is the regression test for the real bug: the pre-flight
    // estimate used to ignore `tools` entirely, so an agent with a tool
    // roster large enough to matter could pass the turn-1 refuse gate
    // (cumulative spend still zero) even though the real request — which
    // does include the serialized tool schemas — would cost meaningfully
    // more than the messages alone.
    const withoutTools = estimateTokens("gpt-4o-mini", messages);
    const withTools = estimateTokens("gpt-4o-mini", messages, tools);

    expect(withTools).toBeGreaterThan(withoutTools);
  });

  it("scales with the size of the tool roster", () => {
    const oneTool = estimateTokens("gpt-4o-mini", messages, tools);
    const twoTools = estimateTokens("gpt-4o-mini", messages, [
      ...tools,
      {
        name: "getForecast",
        description: "Gets a multi-day forecast for a named city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" }, days: { type: "number" } },
          required: ["city", "days"],
        },
      },
    ]);

    expect(twoTools).toBeGreaterThan(oneTool);
  });

  it("is a no-op for an empty tool array (matches the omitted-tools estimate)", () => {
    expect(estimateTokens("gpt-4o-mini", messages, [])).toBe(estimateTokens("gpt-4o-mini", messages));
  });
});
