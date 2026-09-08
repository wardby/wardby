import { describe, it, expect } from "vitest";
import {
  bedrockClaudeSupportedModels,
  bedrockClaudePriceUsd,
  getBedrockClaudePricing,
} from "./pricing-bedrock-claude.js";

describe("bedrock-claude pricing", () => {
  it("lists the supported Bedrock-Claude model IDs with o200k_base encoding", () => {
    const models = bedrockClaudeSupportedModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) expect(getBedrockClaudePricing(m).encoding).toBe("o200k_base");
  });

  it("prices cache reads at ~0.1x and cache writes at ~1.25x of fresh input", () => {
    const [model] = bedrockClaudeSupportedModels();
    const p = getBedrockClaudePricing(model);
    expect(p.cachedInputPerMTok).toBeCloseTo(p.inputPerMTok * 0.1, 6);
    expect(p.cacheWritePerMTok).toBeCloseTo(p.inputPerMTok * 1.25, 6);
  });

  it("fails closed on an unknown model", () => {
    expect(() => getBedrockClaudePricing("us.anthropic.claude-unknown")).toThrow(/No pricing entry/);
  });

  it("does not double-count cache-write tokens", () => {
    const [model] = bedrockClaudeSupportedModels();
    const cost = bedrockClaudePriceUsd(model, {
      inputTokens: 1000,
      cachedInputTokens: 1000,
      cacheWriteTokens: 500,
      outputTokens: 0,
    });
    const p = getBedrockClaudePricing(model);
    const expected = (1000 / 1e6) * p.cachedInputPerMTok! + (500 / 1e6) * p.cacheWritePerMTok!;
    expect(cost).toBeCloseTo(expected, 9);
  });
});
