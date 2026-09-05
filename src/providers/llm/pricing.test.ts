import { describe, expect, it } from "vitest";
import { computeCost, priceUsd, type ModelPricing } from "./pricing.js";

describe("priceUsd", () => {
  it("throws for an unknown model rather than pricing at zero", () => {
    expect(() => priceUsd("not-a-real-model", { inputTokens: 1, outputTokens: 1 })).toThrow(
      /No pricing entry/,
    );
  });

  it("prices plain input/output at the base rates when no cache tokens are reported", () => {
    // gpt-5.6-luna: $0.2/1M in, $1.2/1M out
    const cost = priceUsd("gpt-5.6-luna", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.2 + 1.2, 6);
  });

  it("prices cached input tokens at the cached rate, not the base rate", () => {
    // gpt-5.6-luna: $0.2/1M fresh in, $0.02/1M cached in
    const cost = priceUsd("gpt-5.6-luna", {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.02, 6);
  });

  it("splits fresh vs cached input tokens correctly", () => {
    const cost = priceUsd("gpt-5.6-luna", {
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 0,
    });
    // 600k fresh @ $0.2/1M + 400k cached @ $0.02/1M
    expect(cost).toBeCloseTo(600_000 / 1_000_000 * 0.2 + 400_000 / 1_000_000 * 0.02, 6);
  });

  it("prices cache-write tokens at the cache-write rate", () => {
    const cost = priceUsd("gpt-5.6-luna", {
      inputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 0,
    });
    // 1M "fresh" (inputTokens isn't reduced by cacheWriteTokens) @ $0.2/1M + 1M write @ $0.25/1M
    expect(cost).toBeCloseTo(0.2 + 0.25, 6);
  });

  it("falls back to the base input rate for cached/write tokens when a model has no cache rates", () => {
    // Every shipped model now carries explicit cache rates, so exercise the
    // defensive fallback directly against a constructed cache-less entry.
    const cacheless: ModelPricing = {
      encoding: "o200k_base",
      inputPerMTok: 0.15,
      outputPerMTok: 0.6,
    };
    const withoutCacheRates = computeCost(cacheless, {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      cacheWriteTokens: 200_000,
      outputTokens: 0,
    });
    // No cache rates → all three input components bill at the $0.15 base rate.
    // cachedInputTokens splits out of inputTokens (500k fresh + 500k cached);
    // cacheWriteTokens (200k) bills on top. So (500k + 500k + 200k) @ $0.15/1M.
    expect(withoutCacheRates).toBeCloseTo(
      (500_000 / 1_000_000) * 0.15 +
        (500_000 / 1_000_000) * 0.15 +
        (200_000 / 1_000_000) * 0.15,
      6,
    );
  });
});
