import { describe, it, expect } from "vitest";
import { toGeminiBody, parseGeminiSse, mapGeminiStream, geminiError, geminiUsageTokens } from "./gemini-content.js";
import type { CatalogEntry } from "./catalog-types.js";

const NEON: CatalogEntry = {
  provider: "vertex-gemini",
  modelId: "gemini-4-neon",
  encoding: "o200k_base",
  inputPerMTok: 3,
  outputPerMTok: 15,
  cachedInputPerMTok: 0.15,
  cacheWritePerMTok: 3,
  efforts: ["low", "medium", "high", "xhigh"],
  thinkingMode: "level",
};

async function* bytes(text: string) {
  yield new TextEncoder().encode(text);
}
async function* oneByteAtATime(text: string) {
  for (const b of new TextEncoder().encode(text)) yield new Uint8Array([b]);
}
async function collect<T>(it: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
const sse = (...objs: unknown[]) => objs.map((o) => `data: ${JSON.stringify(o)}\r\n\r\n`).join("");

describe("toGeminiBody", () => {
  it("maps system, user, assistant tool calls with signatures, and merged tool results", () => {
    const body = toGeminiBody(
      {
        model: "gemini-4-neon",
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call_1", name: "get_weather", argsJson: '{"city":"Paris"}', providerData: "SIG" },
              { id: "call_2", name: "get_weather", argsJson: '{"city":"Rome"}' },
            ],
          },
          { role: "tool", toolCallId: "call_1", content: "sunny" },
          { role: "tool", toolCallId: "call_2", content: "rain" },
        ],
        tools: [{ name: "get_weather", description: "d", parameters: { type: "object", properties: {} } }],
        effort: "xhigh",
        temperature: 0.3,
      },
      NEON,
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be terse." }] });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "weather?" }] },
      {
        role: "model",
        parts: [
          { functionCall: { id: "call_1", name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "SIG" },
          { functionCall: { id: "call_2", name: "get_weather", args: { city: "Rome" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "call_1", name: "get_weather", response: { result: "sunny" } } },
          { functionResponse: { id: "call_2", name: "get_weather", response: { result: "rain" } } },
        ],
      },
    ]);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: "get_weather", description: "d", parametersJsonSchema: { type: "object", properties: {} } },
        ],
      },
    ]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 32000, thinkingConfig: { thinkingLevel: "xhigh" } });
  });

  it("passes a full JSON Schema through unchanged as parametersJsonSchema, never parameters", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["filter"],
      properties: {
        filter: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
        },
      },
    };
    const body = toGeminiBody(
      {
        model: "gemini-4-neon",
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "search", description: "s", parameters: schema }],
      },
      NEON,
    );
    const decl = body.tools?.[0]?.functionDeclarations[0];
    expect(decl).toEqual({ name: "search", description: "s", parametersJsonSchema: schema });
    expect(decl).not.toHaveProperty("parameters");
  });

  it("drops an effort the model does not accept, and never sends temperature", () => {
    const body = toGeminiBody(
      { model: "gemini-4-neon", messages: [{ role: "user", content: "x" }], effort: "max", temperature: 1 },
      NEON,
    );
    expect(body.generationConfig).toEqual({ maxOutputTokens: 32000 });
    expect(JSON.stringify(body)).not.toContain("temperature");
  });

  it("keeps assistant text before its calls, and wraps non-object tool args", () => {
    const body = toGeminiBody(
      {
        model: "gemini-4-neon",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "Checking.",
            toolCalls: [
              { id: "a", name: "t", argsJson: "" },
              { id: "b", name: "t", argsJson: "not json" },
            ],
          },
        ],
      },
      NEON,
    );
    expect(body.contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "Checking." },
        { functionCall: { id: "a", name: "t", args: {} } },
        { functionCall: { id: "b", name: "t", args: { _raw: "not json" } } },
      ],
    });
  });
});

describe("mapGeminiStream", () => {
  it("emits text, tool calls with ids and signatures, and done with the LATEST usage (cumulative chunks)", async () => {
    const chunks = parseGeminiSse(
      bytes(
        sse(
          {
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { id: "call_9", name: "t", args: { a: 1 } }, thoughtSignature: "S1" }],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 104, candidatesTokenCount: 16, thoughtsTokenCount: 64 },
          },
          {
            candidates: [{ content: { parts: [{ functionCall: { id: "call_10", name: "t", args: {} } }] } }],
            usageMetadata: { promptTokenCount: 104, candidatesTokenCount: 32, thoughtsTokenCount: 64 },
          },
          {
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: 104,
              candidatesTokenCount: 37,
              thoughtsTokenCount: 64,
              cachedContentTokenCount: 50,
            },
          },
        ),
      ),
    );
    const events = await collect(mapGeminiStream(chunks, () => 0.5));
    expect(events).toEqual([
      { type: "tool_call", id: "call_9", name: "t", argsJson: '{"a":1}', providerData: "S1" },
      { type: "tool_call", id: "call_10", name: "t", argsJson: "{}" },
      { type: "text", delta: "ok" },
      {
        type: "done",
        stopReason: "tool_calls",
        usage: { inputTokens: 104, outputTokens: 101, cachedInputTokens: 50, costUsd: 0.5 },
      },
    ]);
  });

  it("uses usage from the last chunk when earlier chunks carry none (Vertex)", async () => {
    const chunks = parseGeminiSse(
      bytes(
        sse(
          { candidates: [{ content: { parts: [{ text: "a" }] } }], usageMetadata: { trafficType: "ON_DEMAND" } },
          {
            candidates: [{ content: { parts: [{ text: "b" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3 },
          },
        ),
      ),
    );
    const events = await collect(mapGeminiStream(chunks, () => 0.25));
    expect(events).toEqual([
      { type: "text", delta: "a" },
      { type: "text", delta: "b" },
      {
        type: "done",
        stopReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.25 },
      },
    ]);
  });

  it("generates a unique id when a functionCall has none", async () => {
    const chunks = parseGeminiSse(
      bytes(
        sse({
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: "t", args: {} } }, { functionCall: { name: "t", args: {} } }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      ),
    );
    const events = await collect(mapGeminiStream(chunks, () => 0));
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls).toHaveLength(2);
    const ids = calls.map((c) => (c.type === "tool_call" ? c.id : ""));
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id.startsWith("gemini_call_")).toBe(true);
  });

  it("maps MAX_TOKENS to stopReason length, and skips thought parts (thought: true) from text", async () => {
    const chunks = parseGeminiSse(
      bytes(
        sse({
          candidates: [
            { content: { parts: [{ text: "hidden", thought: true }, { text: "shown" }] }, finishReason: "MAX_TOKENS" },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      ),
    );
    const events = await collect(mapGeminiStream(chunks, () => 0));
    expect(events).toEqual([
      { type: "text", delta: "shown" },
      {
        type: "done",
        stopReason: "length",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      },
    ]);
  });

  it("adds toolUsePromptTokenCount to inputTokens and prices it", async () => {
    const chunks = parseGeminiSse(
      bytes(
        sse({
          candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 100, toolUsePromptTokenCount: 40, candidatesTokenCount: 5 },
        }),
      ),
    );
    const seen: unknown[] = [];
    const events = await collect(
      mapGeminiStream(chunks, (u) => {
        seen.push(u);
        return u.inputTokens / 1000;
      }),
    );
    expect(seen).toEqual([{ inputTokens: 140, outputTokens: 5, cachedInputTokens: 0 }]);
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "stop",
      usage: { inputTokens: 140, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.14 },
    });
  });

  it("rejects a stream that ends without a usage summary, instead of a $0 success", async () => {
    const chunks = parseGeminiSse(
      bytes(sse({ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "STOP" }] })),
    );
    await expect(collect(mapGeminiStream(chunks, () => 0))).rejects.toThrow(
      "Gemini stream ended without a usage summary",
    );
  });

  it("still finishes with done when usage arrived but no finishReason did", async () => {
    const chunks = parseGeminiSse(
      bytes(sse({ candidates: [{ content: { parts: [{ text: "y" }] } }], usageMetadata: { promptTokenCount: 2 } })),
    );
    const events = await collect(mapGeminiStream(chunks, () => 0));
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });

  it("throws on a mid-stream error object", async () => {
    const chunks = parseGeminiSse(bytes(sse({ error: { code: 500, status: "INTERNAL", message: "boom" } })));
    await expect(collect(mapGeminiStream(chunks, () => 0))).rejects.toThrow(
      /Gemini API error: HTTP 500 INTERNAL: boom/,
    );
  });

  it("parses SSE split across byte chunks", async () => {
    const payload = sse(
      { candidates: [{ content: { parts: [{ text: "héllo" }] } }] },
      {
        candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      },
    );
    const whole = await collect(mapGeminiStream(parseGeminiSse(bytes(payload)), () => 0));
    const split = await collect(mapGeminiStream(parseGeminiSse(oneByteAtATime(payload)), () => 0));
    expect(split).toEqual(whole);
    expect(split[0]).toEqual({ type: "text", delta: "héllo" });
  });
});

describe("geminiError", () => {
  it("formats Google's status and message, bounded", () => {
    const err = geminiError(
      402,
      JSON.stringify({
        error: { code: 402, status: "RESOURCE_EXHAUSTED", message: "Your prepayment credits are depleted." },
      }),
    );
    expect(err.message).toBe("Gemini API error: HTTP 402 RESOURCE_EXHAUSTED: Your prepayment credits are depleted.");
    expect(geminiError(500, "x".repeat(5000)).message.length).toBeLessThan(400);
  });
});

describe("geminiUsageTokens", () => {
  it("adds tool-use prompt tokens to input and thoughts to output, and reads cached as is", () => {
    expect(
      geminiUsageTokens({
        promptTokenCount: 100,
        toolUsePromptTokenCount: 7,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 5,
        cachedContentTokenCount: 60,
      }),
    ).toEqual({ inputTokens: 107, outputTokens: 25, cachedInputTokens: 60 });
    expect(geminiUsageTokens({ promptTokenCount: 3 })).toEqual({
      inputTokens: 3,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });
});
