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

  it("every entry has its own literal cache read/write rate set (never left undefined)", () => {
    for (const m of bedrockClaudeSupportedModels()) {
      const p = getBedrockClaudePricing(m);
      expect(p.cachedInputPerMTok, `${m} is missing cachedInputPerMTok`).toBeGreaterThan(0);
      expect(p.cacheWritePerMTok, `${m} is missing cacheWritePerMTok`).toBeGreaterThan(0);
    }
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

  it("routes the agent-cron fleet's four Bedrock model IDs at their exact published rates (2026-09-08 production export, 81 agents)", () => {
    // Keys must match
    // agent.model verbatim; the Phase-9 importer's routability gate is an
    // exact-set membership test against bedrockClaudeSupportedModels().
    // Rates from platform.claude.com/docs/en/about-claude/pricing
    // (confirmed 2026-09-08), 5-minute cache TTL — see CLAUDE.md.
    expect(getBedrockClaudePricing("us.anthropic.claude-sonnet-4-6")).toMatchObject({
      inputPerMTok: 3,
      outputPerMTok: 15,
      cachedInputPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    });
    expect(getBedrockClaudePricing("us.anthropic.claude-opus-4-6-v1")).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cachedInputPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    });
    expect(getBedrockClaudePricing("us.anthropic.claude-opus-4-8")).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cachedInputPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    });
    expect(getBedrockClaudePricing("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toMatchObject({
      inputPerMTok: 1,
      outputPerMTok: 5,
      cachedInputPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    });
  });
});
