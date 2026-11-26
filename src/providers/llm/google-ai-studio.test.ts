import { describe, it, expect } from "vitest";
import { GoogleAiStudioLlmProvider, googleAiStudioCredentialsPresent } from "./google-ai-studio.js";
import { SHIPPED_CATALOG } from "./catalog-shipped.js";

const FAKE_KEY = "fake-gemini-key-do-not-leak-123";
const entry = SHIPPED_CATALOG.find((e) => e.modelId === "google-ai-studio.gemini-4-neon")!;
const okBody =
  'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3}}\n\n';

function recorder(status = 200, body = okBody) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("GoogleAiStudioLlmProvider", () => {
  it("strips the id prefix, puts the key only in x-goog-api-key, and prices from the catalog", async () => {
    const { calls, fetchImpl } = recorder();
    const p = new GoogleAiStudioLlmProvider(FAKE_KEY, { fetch: fetchImpl }).withEntry(entry);
    const events = [];
    for await (const e of p.stream({ model: entry.modelId, messages: [{ role: "user", content: "x" }] }))
      events.push(e);
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
    );
    expect(calls[0].url).not.toContain(FAKE_KEY);
    expect(new Headers(calls[0].init.headers).get("x-goog-api-key")).toBe(FAKE_KEY);
    expect(JSON.stringify(calls[0].init.body)).not.toContain(FAKE_KEY);
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costUsd: (10 * 3 + 5 * 15) / 1_000_000 },
    });
  });

  it("throws Google's status and message on a non-200, without the key", async () => {
    const { fetchImpl } = recorder(
      402,
      '{"error":{"code":402,"status":"RESOURCE_EXHAUSTED","message":"Your prepayment credits are depleted."}}',
    );
    const p = new GoogleAiStudioLlmProvider(FAKE_KEY, { fetch: fetchImpl }).withEntry(entry);
    const run = async () => {
      for await (const _ of p.stream({ model: entry.modelId, messages: [{ role: "user", content: "x" }] })) void _;
    };
    await expect(run()).rejects.toThrow(
      "Gemini API error: HTTP 402 RESOURCE_EXHAUSTED: Your prepayment credits are depleted.",
    );
    const err = await run().catch((e: Error) => e);
    expect(`${(err as Error).message}${(err as Error).stack}`).not.toContain(FAKE_KEY);
  });

  it("refuses to construct without a key", () => {
    expect(() => new GoogleAiStudioLlmProvider("")).toThrow("GEMINI_API_KEY is not set");
  });

  it("countTokens is the inflated o200k estimate and fails closed on an unknown model", async () => {
    const p = new GoogleAiStudioLlmProvider(FAKE_KEY).withEntry(entry);
    expect(await p.countTokens(entry.modelId, [{ role: "user", content: "hello world" }])).toBeGreaterThan(0);
    await expect(p.countTokens("gpt-4o", [])).rejects.toThrow(/model_unavailable/);
  });

  it("detects credentials from GEMINI_API_KEY", () => {
    expect(googleAiStudioCredentialsPresent({ GEMINI_API_KEY: "k" })).toBe(true);
    expect(googleAiStudioCredentialsPresent({})).toBe(false);
  });
});
