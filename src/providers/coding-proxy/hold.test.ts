import { describe, expect, it } from "vitest";
import { CACHE_WINDOW_MS, conversationKey, estimateHold } from "./hold.js";
import { estimateReservationUsd } from "./metering.js";
import type { PreviousReply } from "./types.js";

// claude-sonnet-5-5 catalog rates (CLAUDE.md): input 2, cache write 2.5, cache read 0.10, output 10.
const PRICING = {
  encoding: "o200k_base" as const,
  inputPerMTok: 2,
  cacheWritePerMTok: 2.5,
  cachedInputPerMTok: 0.1,
  outputPerMTok: 10,
};
const NOW = new Date("2026-10-16T12:00:00Z");
const prev = (change: Partial<PreviousReply> = {}): PreviousReply => ({
  model: "m",
  status: "completed",
  costEstimated: false,
  usage: {
    inputTokens: 100_000,
    outputTokens: 2_000,
    cachedInputTokens: 90_000,
    cacheWriteTokens: 8_000,
    reasoningTokens: 0,
  },
  requestBytes: 400_000,
  completedAt: new Date(NOW.getTime() - 60_000),
  ...change,
});
const base = {
  protocol: "anthropic-messages" as const,
  model: "m",
  bodyBytes: 406_000,
  maxOutputTokens: 32_000,
  pricing: PRICING,
  now: NOW,
};

describe("estimateHold", () => {
  it("prices the previous reply's cached part at the cache-read rate (spec example)", () => {
    const hold = estimateHold({ ...base, previous: prev() });
    // prevPrompt 108k; cached (anthropic: reads + writes) 98k; upperIn 108k + 6k = 114k; uncached 16k.
    const expected = (98_000 * 0.1 + 16_000 * (2 + 2.5) + 32_000 * 10) / 1e6;
    expect(hold).toMatchObject({ basis: "cached", cachedTokens: 98_000, uncachedTokens: 16_000 });
    expect(hold.holdUsd).toBeCloseTo(expected, 10);
    expect(hold.ceilingUsd).toBeCloseTo(estimateReservationUsd(406_000, 32_000, PRICING), 10);
    expect(hold.holdUsd).toBeLessThan(hold.ceilingUsd / 4);
  });

  it("counts OpenAI cache writes as uncached", () => {
    const hold = estimateHold({ ...base, protocol: "openai-responses", previous: prev() });
    expect(hold).toMatchObject({ basis: "cached", cachedTokens: 90_000, uncachedTokens: 24_000 });
  });

  it("never holds more than the ceiling", () => {
    const tiny = {
      ...base,
      bodyBytes: 1_000,
      previous: prev({
        requestBytes: 1_000,
        usage: {
          inputTokens: 900_000,
          outputTokens: 1,
          cachedInputTokens: 900_000,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      }),
    };
    const hold = estimateHold(tiny);
    expect(hold.holdUsd).toBe(hold.ceilingUsd);
    expect(hold.basis).toBe("cached");
  });

  it.each([
    ["no_previous", null],
    ["model_changed", prev({ model: "other" })],
    ["previous_estimated", prev({ status: "uncertain", costEstimated: true })],
    ["previous_not_completed", prev({ status: "uncertain", usage: undefined })],
    ["no_request_bytes", prev({ requestBytes: null })],
    ["cache_expired", prev({ completedAt: new Date(NOW.getTime() - CACHE_WINDOW_MS - 1) })],
    ["cache_expired", prev({ completedAt: null })],
    ["body_shrank", prev({ requestBytes: 406_001 })],
    [
      "low_cache_share",
      prev({
        usage: {
          inputTokens: 100_000,
          outputTokens: 1,
          cachedInputTokens: 40_000,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      }),
    ],
  ] as const)("falls back to the ceiling: %s", (fallback, previous) => {
    const hold = estimateHold({ ...base, previous });
    expect(hold).toMatchObject({ basis: "full", fallback });
    expect(hold.holdUsd).toBe(hold.ceilingUsd);
  });

  it("counts Anthropic cache writes toward the 50% cached share", () => {
    // 40k read + 30k written of 100k+30k: 70k/130k ≥ 50% on Anthropic, 40k/130k < 50% on OpenAI.
    const usage = {
      inputTokens: 100_000,
      outputTokens: 1,
      cachedInputTokens: 40_000,
      cacheWriteTokens: 30_000,
      reasoningTokens: 0,
    };
    expect(estimateHold({ ...base, previous: prev({ usage }) }).basis).toBe("cached");
    expect(estimateHold({ ...base, protocol: "openai-responses", previous: prev({ usage }) }).fallback).toBe(
      "low_cache_share",
    );
  });
});

describe("conversationKey", () => {
  it("keys an Anthropic conversation by its first message, ignoring cache_control and the system prompt", () => {
    const first = { role: "user", content: [{ type: "text", text: "task" }] };
    const a = conversationKey("anthropic-messages", {
      system: "one",
      messages: [{ ...first, content: [{ type: "text", text: "task", cache_control: { type: "ephemeral" } }] }],
    });
    const b = conversationKey("anthropic-messages", {
      system: "two",
      messages: [first, { role: "assistant", content: "x" }],
    });
    expect(a).toBe(b);
    expect(conversationKey("anthropic-messages", { messages: [{ role: "user", content: "other" }] })).not.toBe(a);
    expect(conversationKey("anthropic-messages", { messages: [] })).toBeNull();
  });

  it("keys an OpenAI conversation by prompt_cache_key, else instructions and the first input item", () => {
    expect(conversationKey("openai-responses", { prompt_cache_key: "c1", input: ["a"] })).toBe(
      conversationKey("openai-responses", { prompt_cache_key: "c1", input: ["b"] }),
    );
    const x = conversationKey("openai-responses", {
      instructions: "i",
      input: [
        { role: "user", content: "t" },
        { role: "user", content: "1" },
      ],
    });
    const y = conversationKey("openai-responses", { instructions: "i", input: [{ role: "user", content: "t" }] });
    expect(x).toBe(y);
    expect(conversationKey("openai-responses", { input: [] })).toBeNull();
  });
});
