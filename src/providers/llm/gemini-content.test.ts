import { describe, it, expect } from "vitest";
import { toGeminiBody, parseGeminiSse, mapGeminiStream, geminiError } from "./gemini-content.js";
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
          { name: "get_weather", description: "d", parameters: { type: "object", properties: {} } },
        ],
      },
    ]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 32000, thinkingConfig: { thinkingLevel: "xhigh" } });
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
