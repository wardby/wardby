import { describe, it, expect, vi } from "vitest";
import { GeminiLlmProvider } from "./gemini-provider.js";
import { SHIPPED_CATALOG } from "./catalog-shipped.js";

const entry = SHIPPED_CATALOG.find((e) => e.modelId === "gemini-4-neon")!;
const okBody =
  'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n';

function make(fetchImpl: typeof fetch) {
  return new GeminiLlmProvider(
    { url: () => "https://example.test/x", headers: async () => ({ "x-test": "1" }), fetch: fetchImpl },
    (id) => id,
  ).withEntry(entry);
}

describe("GeminiLlmProvider", () => {
  it("withEntry pins the entry: another model id is model_unavailable", async () => {
    const p = make(async () => new Response(okBody));
    await expect(
      (async () => {
        for await (const _ of p.stream({ model: "other", messages: [] })) void _;
      })(),
    ).rejects.toThrow(/model_unavailable/);
  });

  it("passes the abort signal to fetch", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const p = make((async (_u: string, init: RequestInit) => {
      seen.push(init.signal);
      return new Response(okBody);
    }) as unknown as typeof fetch);
    const ac = new AbortController();
    for await (const _ of p.stream({ model: entry.modelId, messages: [{ role: "user", content: "x" }] }, ac.signal))
      void _;
    expect(seen[0]).toBe(ac.signal);
  });

  it("calls onResponseStarted once after the response headers arrive", async () => {
    const p = make(async () => new Response(okBody));
    const onResponseStarted = vi.fn();
    for await (const _ of p.stream({ model: entry.modelId, messages: [{ role: "user", content: "x" }] }, undefined, {
      onResponseStarted,
    }))
      void _;
    expect(onResponseStarted).toHaveBeenCalledTimes(1);
  });

  it("does not call onResponseStarted on a non-200 response: nothing was generated, nothing to bill", async () => {
    const p = make(
      async () =>
        new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "slow down" } }), {
          status: 429,
        }),
    );
    const onResponseStarted = vi.fn();
    await expect(
      (async () => {
        for await (const _ of p.stream(
          { model: entry.modelId, messages: [{ role: "user", content: "x" }] },
          undefined,
          {
            onResponseStarted,
          },
        ))
          void _;
      })(),
    ).rejects.toThrow(/Gemini API error: HTTP 429 RESOURCE_EXHAUSTED/);
    expect(onResponseStarted).toHaveBeenCalledTimes(0);
  });
});
