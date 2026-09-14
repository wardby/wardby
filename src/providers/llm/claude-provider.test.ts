import { describe, it, expect } from "vitest";
import { ClaudeLlmProvider, type ClaudeMessagesClient, type ClaudePricingModule } from "./claude-provider.js";
import type { LlmStreamEvent } from "./types.js";
import type { ModelPricing } from "./pricing-core.js";

function fakeClient(events: any[], onParams?: (params: any) => void): ClaudeMessagesClient {
  return {
    messages: {
      stream: (params: any) => {
        onParams?.(params);
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  };
}

const FAKE_PRICING: ModelPricing = {
  encoding: "o200k_base",
  inputPerMTok: 2,
  outputPerMTok: 10,
  cachedInputPerMTok: 0.2,
  cacheWritePerMTok: 2.5,
};
const KNOWN_MODEL = "fake-claude-model";

function fakePricingModule(): ClaudePricingModule {
  function getPricing(model: string): ModelPricing {
    if (model !== KNOWN_MODEL) throw new Error(`No pricing entry for model "${model}"`);
    return FAKE_PRICING;
  }
  return {
    getPricing,
    priceUsd(model, usage) {
      const p = getPricing(model);
      const cached = usage.cachedInputTokens ?? 0;
      const write = usage.cacheWriteTokens ?? 0;
      const fresh = usage.inputTokens - cached;
      return (
        (fresh / 1e6) * p.inputPerMTok +
        (cached / 1e6) * p.cachedInputPerMTok! +
        (write / 1e6) * p.cacheWritePerMTok! +
        (usage.outputTokens / 1e6) * p.outputPerMTok
      );
    },
  };
}

async function collect(it: AsyncIterable<LlmStreamEvent>) {
  const o: LlmStreamEvent[] = [];
  for await (const e of it) o.push(e);
  return o;
}

describe("ClaudeLlmProvider", () => {
  it("streams text and a done event with a priced usage, including cache accounting", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const p = new ClaudeLlmProvider(fakeClient(events), fakePricingModule());
    const out = await collect(p.stream({ model: KNOWN_MODEL, messages: [{ role: "user", content: "hi" }] }));
    const done = out.find((e) => e.type === "done") as any;
    // inputTokens = input_tokens + cache_read (mapClaudeStream's contract, see claude-messages.ts)
    expect(done.usage.inputTokens).toBe(14);
    expect(done.usage.cachedInputTokens).toBe(4);
    expect(done.usage.cacheWriteTokens).toBe(2);
    expect(done.usage.costUsd).toBeGreaterThan(0);
  });

  it("defaults max_tokens well above a short report's worth of output", async () => {
    let sentParams: any;
    const events = [
      {
        type: "message_start",
        message: {
          usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const p = new ClaudeLlmProvider(
      fakeClient(events, (params) => {
        sentParams = params;
      }),
      fakePricingModule(),
    );
    await collect(p.stream({ model: KNOWN_MODEL, messages: [{ role: "user", content: "hi" }] }));
    expect(sentParams.max_tokens).toBeGreaterThanOrEqual(16000);
  });

  it("countTokens is offline, inflates over the raw estimate, counts tools, and fails closed on an unknown model", async () => {
    const p = new ClaudeLlmProvider(fakeClient([]), fakePricingModule());
    const withoutTools = await p.countTokens(KNOWN_MODEL, [{ role: "user", content: "hello world" }]);
    const withTools = await p.countTokens(
      KNOWN_MODEL,
      [{ role: "user", content: "hello world" }],
      [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }],
    );
    expect(withoutTools).toBeGreaterThan(0);
    expect(withTools).toBeGreaterThan(withoutTools);
    await expect(p.countTokens("unknown-model", [{ role: "user", content: "hi" }])).rejects.toThrow(/No pricing entry/);
  });

  it("priceUsd delegates to the injected pricing module", () => {
    const p = new ClaudeLlmProvider(fakeClient([]), fakePricingModule());
    const cost = p.priceUsd(KNOWN_MODEL, { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost).toBeCloseTo(2, 9); // 1M fresh input tokens @ $2/MTok
  });
});
