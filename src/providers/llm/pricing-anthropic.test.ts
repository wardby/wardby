import { describe, it, expect } from "vitest";
import { anthropicSupportedModels, anthropicPriceUsd, getAnthropicPricing } from "./pricing-anthropic.js";

describe("anthropic pricing", () => {
  it("lists the Claude roster with o200k_base encoding", () => {
    const models = anthropicSupportedModels();
    expect(models).toContain("claude-opus-5");
    expect(models).toContain("claude-haiku-4-5");
    for (const m of models) expect(getAnthropicPricing(m).encoding).toBe("o200k_base");
  });

  it("prices cache reads at ~0.1x and cache writes at ~1.25x of fresh input", () => {
    const p = getAnthropicPricing("claude-sonnet-5");
    expect(p.cachedInputPerMTok).toBeCloseTo(p.inputPerMTok * 0.1, 6);
    expect(p.cacheWritePerMTok).toBeCloseTo(p.inputPerMTok * 1.25, 6);
  });

  it("fails closed on an unknown model", () => {
    expect(() => getAnthropicPricing("claude-unknown")).toThrow(/No pricing entry/);
  });

  it("does not double-count cache-write tokens", () => {
    // inputTokens excludes cache-write by contract; fresh = input - cachedRead.
    const cost = anthropicPriceUsd("claude-sonnet-5", { inputTokens: 1000, cachedInputTokens: 1000, cacheWriteTokens: 500, outputTokens: 0 });
    const p = getAnthropicPricing("claude-sonnet-5");
    const expected = (1000 / 1e6) * p.cachedInputPerMTok! + (500 / 1e6) * p.cacheWritePerMTok!;
    expect(cost).toBeCloseTo(expected, 9);
  });
});
