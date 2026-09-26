import { describe, it, expect } from "vitest";
import {
  anthropicSupportedEfforts,
  anthropicSupportedModels,
  anthropicPriceUsd,
  getAnthropicPricing,
} from "./pricing-anthropic.js";

describe("anthropic effort support", () => {
  it("accepts every level on the 5-series models", () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
      expect(anthropicSupportedEfforts(m)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("accepts no effort on Haiku 4.5 or an unknown model", () => {
    expect(anthropicSupportedEfforts("claude-haiku-4-5")).toEqual([]);
    expect(anthropicSupportedEfforts("claude-unknown")).toEqual([]);
  });
});

describe("anthropic pricing", () => {
  it("lists the Claude roster with o200k_base encoding", () => {
    const models = anthropicSupportedModels();
    expect(models).toContain("claude-opus-5");
    expect(models).toContain("claude-haiku-4-5");
    for (const m of models) expect(getAnthropicPricing(m).encoding).toBe("o200k_base");
  });

  it("prices claude-sonnet-5 cache reads and writes at their published literal rates", () => {
    const p = getAnthropicPricing("claude-sonnet-5");
    expect(p.cachedInputPerMTok).toBe(0.2);
    expect(p.cacheWritePerMTok).toBe(2.5);
  });

  it("pins every model's published rates to exact literals (platform.claude.com pricing)", () => {
    const rates: Record<string, [number, number, number, number]> = {
      // [inputPerMTok, cacheWritePerMTok, cachedInputPerMTok, outputPerMTok]
      "claude-opus-5": [5, 6.25, 0.5, 25],
      "claude-sonnet-5": [2, 2.5, 0.2, 10],
      "claude-fable-5": [10, 12.5, 1, 50],
      "claude-haiku-4-5": [1, 1.25, 0.1, 5],
    };
    for (const [model, [inputPerMTok, cacheWritePerMTok, cachedInputPerMTok, outputPerMTok]] of Object.entries(rates)) {
      const p = getAnthropicPricing(model);
      expect(p.inputPerMTok).toBe(inputPerMTok);
      expect(p.cacheWritePerMTok).toBe(cacheWritePerMTok);
      expect(p.cachedInputPerMTok).toBe(cachedInputPerMTok);
      expect(p.outputPerMTok).toBe(outputPerMTok);
    }
  });

  it("fails closed on an unknown model", () => {
    expect(() => getAnthropicPricing("claude-unknown")).toThrow(/No pricing entry/);
  });

  it("does not double-count cache-write tokens", () => {
    // inputTokens excludes cache-write by contract; fresh = input - cachedRead.
    const cost = anthropicPriceUsd("claude-sonnet-5", {
      inputTokens: 1000,
      cachedInputTokens: 1000,
      cacheWriteTokens: 500,
      outputTokens: 0,
    });
    const p = getAnthropicPricing("claude-sonnet-5");
    const expected = (1000 / 1e6) * p.cachedInputPerMTok! + (500 / 1e6) * p.cacheWritePerMTok!;
    expect(cost).toBeCloseTo(expected, 9);
  });
});
