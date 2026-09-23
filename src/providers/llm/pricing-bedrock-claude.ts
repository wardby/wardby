/**
 * Bedrock-Claude pricing table. Every entry is a fully literal, hardcoded
 * ModelPricing — every field, including cache read/write, is the provider's
 * own published rate for that exact model, never derived from another
 * field via a ratio (see CLAUDE.md "LLM pricing tables — STRICT": a
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

// These are `us.` cross-region inference profiles (region us-east-1) — routability
// is keyed by model ID only; region is a separate adapter concern
// (BEDROCK_REGION/AWS_REGION). Rates below are the exact published 5-minute
// cache-TTL numbers (platform.claude.com/docs/en/about-claude/pricing,
// confirmed 2026-09-08) — this adapter only ever emits the default 5-minute
// cache_control breakpoint (see claude-messages.ts's withCacheBreakpoints),
// so the 1-hour-TTL rates are out of scope and not stored here.
const PRICING: Record<string, ModelPricing> = {
  "us.anthropic.claude-sonnet-4-6": claude(3, 15, 0.3, 3.75),
  "us.anthropic.claude-opus-4-6-v1": claude(5, 25, 0.5, 6.25),
  "us.anthropic.claude-opus-4-8": claude(5, 25, 0.5, 6.25),
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": claude(1, 5, 0.1, 1.25),
};

export function getBedrockClaudePricing(model: string): ModelPricing {
  const p = PRICING[model];
  if (!p)
    throw new Error(
      `No pricing entry for model "${model}" — refusing to price at zero. Add it to src/providers/llm/pricing-bedrock-claude.ts.`,
    );
  return p;
}

export function bedrockClaudeSupportedModels(): string[] {
  return Object.keys(PRICING);
}

export function bedrockClaudePriceUsd(model: string, usage: UsageTokens): number {
  return computeCost(getBedrockClaudePricing(model), usage);
}
