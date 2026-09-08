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

const PRICING: Record<string, ModelPricing> = {
  // Global-profile seed entry, same base rate as pricing-anthropic.ts's
  // "claude-sonnet-5" entry.
  "anthropic.claude-sonnet-5-v1:0": claude(2, 10),

  // agent-cron fleet roster (docs/private/2026-09-08-fleet-models-to-roster.md,
  // 2026-09-08 production export bundle, 81 agents / 4 distinct IDs). All
  // four are `us.` cross-region inference profiles (region us-east-1) —
  // routability is keyed by model ID only; region is a separate adapter
  // concern (BEDROCK_REGION/AWS_REGION). Rates confirmed against current AWS
  // Bedrock pricing, each its own literal entry — no computed regional
  // premium over a base rate.
  "us.anthropic.claude-sonnet-4-6": claude(3, 15),
  "us.anthropic.claude-opus-4-6-v1": claude(5, 25),
  "us.anthropic.claude-opus-4-8": claude(5, 25),
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": claude(1, 5),
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
