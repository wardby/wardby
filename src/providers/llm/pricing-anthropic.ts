import { computeCost, type ModelPricing, type UsageTokens } from "./pricing-core.js";
import type { LlmEffort } from "./types.js";

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
  "claude-opus-5": claude(5, 25),
  "claude-sonnet-5": claude(2, 10),
  "claude-fable-5": claude(10, 50),
  "claude-haiku-4-5": claude(1, 5),
};

// Reasoning effort levels each model accepts (`output_config.effort`). The
// single source of truth for direct-API Claude models; a model missing here
// accepts no effort, so a new roster entry never gets one by accident.
// Haiku 4.5 rejects the parameter outright.
const ALL_EFFORTS: readonly LlmEffort[] = ["low", "medium", "high", "xhigh", "max"];
const EFFORTS: Record<string, readonly LlmEffort[]> = {
  "claude-opus-5": ALL_EFFORTS,
  "claude-sonnet-5": ALL_EFFORTS,
  "claude-fable-5": ALL_EFFORTS,
  "claude-haiku-4-5": [],
};

export function anthropicSupportedEfforts(model: string): readonly LlmEffort[] {
  return EFFORTS[model] ?? [];
}

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
