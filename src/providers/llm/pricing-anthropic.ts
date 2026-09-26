/**
 * Anthropic direct-API pricing table. Every entry is a fully literal,
 * hardcoded ModelPricing — every field, including cache read/write, is the
 * provider's own published rate for that exact model, never derived from
 * another field via a ratio (see CLAUDE.md "LLM pricing tables — STRICT": a
 * multiplier that happens to be correct today silently goes stale the
 * moment one model's real cache pricing diverges from the pattern).
 */
import { computeCost, type ModelPricing, type UsageTokens } from "./pricing-core.js";

function claude(
  inputPerMTok: number,
  outputPerMTok: number,
  cachedInputPerMTok: number,
  cacheWritePerMTok: number,
): ModelPricing {
  return { encoding: "o200k_base", inputPerMTok, outputPerMTok, cachedInputPerMTok, cacheWritePerMTok };
}

// Rates are the exact published 5-minute cache-TTL numbers
// (platform.claude.com/docs/en/about-claude/pricing, "Model pricing" table)
// — wardby only ever emits the default 5-minute cache_control breakpoint,
// so the 1-hour-TTL rates are out of scope and not stored here.
const PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": claude(5, 25, 0.5, 6.25),
  "claude-sonnet-5": claude(2, 10, 0.2, 2.5),
  "claude-fable-5": claude(10, 50, 1, 12.5),
  "claude-haiku-4-5": claude(1, 5, 0.1, 1.25),
};

export function getAnthropicPricing(model: string): ModelPricing {
  const p = PRICING[model];
  if (!p)
    throw new Error(
      `No pricing entry for model "${model}" — refusing to price at zero. Add it to src/providers/llm/pricing-anthropic.ts.`,
    );
  return p;
}

export function anthropicSupportedModels(): string[] {
  return Object.keys(PRICING);
}

export function anthropicPriceUsd(model: string, usage: UsageTokens): number {
  return computeCost(getAnthropicPricing(model), usage);
}
