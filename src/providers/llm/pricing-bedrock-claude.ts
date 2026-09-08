/**
 * Bedrock-Claude pricing table. Every entry is a literal, hardcoded
 * ModelPricing — never computed at request time from a base rate times a
 * detected region prefix or model pattern. Base $/Mtok rates match
 * pricing-anthropic.ts (Bedrock prices Claude at parity with the direct
 * API). Cache multipliers assume the adapter only ever emits the default
 * 5-minute cache_control breakpoint (see claude-messages.ts's
 * withCacheBreakpoints) — Bedrock's 1-hour-TTL tier prices differently and
 * is out of scope.
 */
import { computeCost, type ModelPricing, type UsageTokens } from "./pricing-core.js";

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

function claude(inputPerMTok: number, outputPerMTok: number): ModelPricing {
  return {
    encoding: "o200k_base",
    inputPerMTok,
    outputPerMTok,
    cachedInputPerMTok: inputPerMTok * CACHE_READ_MULT,
    cacheWritePerMTok: inputPerMTok * CACHE_WRITE_MULT,
  };
}

// Seed roster: the global-profile Bedrock ID for claude-sonnet-5, same base
// rate as pricing-anthropic.ts's "claude-sonnet-5" entry. Add the rest of
// the supported fleet's model/inference-profile IDs here as they're
// confirmed (migration bundle / AWS Bedrock console) — each gets its own
// literal entry, including any regional-profile premium over this rate.
const PRICING: Record<string, ModelPricing> = {
  "anthropic.claude-sonnet-5-v1:0": claude(2, 10),
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
