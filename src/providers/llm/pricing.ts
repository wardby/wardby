/**
 * Static price + tokenizer table for the budget guardrail.
 *
 * Sourced from OpenAI's public pricing page at write time. Deliberately
 * static (no pricing API call) so `priceUsd` stays synchronous and
 * network-free — the budget math must work offline and in tests. An unknown
 * model throws rather than silently pricing at zero, so a misconfigured
 * agent can never bypass the budget guardrail by accident.
 *
 * `encoding` is here too (not just price) because it drives which
 * `gpt-tokenizer` BPE table `countTokens` uses — every gpt-4o-and-later
 * model uses `o200k_base`, not the older `cl100k_base` gpt-tokenizer
 * defaults to. Keeping both in one table means a model can't be priced
 * without also being told which tokenizer estimates its input cost.
 *
 * `cachedInputPerMTok` / `cacheWritePerMTok` are optional: not every model's
 * entry carries verified cache rates. When a model has cached or
 * cache-write tokens but no rate for them, `priceUsd` falls back to the
 * full (non-cached) input rate — the same fail-toward-overestimate
 * direction as the unknown-model error, never fail-toward-underestimate.
 */

import { computeCost, type ModelPricing, type TokenizerEncoding, type UsageTokens } from "./pricing-core.js";
export { computeCost } from "./pricing-core.js";
export type { ModelPricing, TokenizerEncoding, UsageTokens } from "./pricing-core.js";

const PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { encoding: "o200k_base", inputPerMTok: 2.5, cachedInputPerMTok: 1.25, outputPerMTok: 10.0 },
  "gpt-4o-mini": { encoding: "o200k_base", inputPerMTok: 0.15, cachedInputPerMTok: 0.075, outputPerMTok: 0.6 },
  "gpt-4.1": { encoding: "o200k_base", inputPerMTok: 2.0, cachedInputPerMTok: 0.5, outputPerMTok: 8.0 },
  "gpt-4.1-mini": { encoding: "o200k_base", inputPerMTok: 0.4, cachedInputPerMTok: 0.1, outputPerMTok: 1.6 },
  "gpt-4.1-nano": { encoding: "o200k_base", inputPerMTok: 0.1, cachedInputPerMTok: 0.025, outputPerMTok: 0.4 },
  "gpt-6-astra": {
    encoding: "o200k_base",
    inputPerMTok: 10.0,
    cachedInputPerMTok: 1.0,
    cacheWritePerMTok: 12.5,
    outputPerMTok: 50.0,
  },
  "gpt-5.6-sol": {
    encoding: "o200k_base",
    inputPerMTok: 4.0,
    cachedInputPerMTok: 0.4,
    cacheWritePerMTok: 5.0,
    outputPerMTok: 20.0,
  },
  "gpt-5.6-terra": {
    encoding: "o200k_base",
    inputPerMTok: 2.0,
    cachedInputPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    outputPerMTok: 12.0,
  },
  "gpt-5.6-luna": {
    encoding: "o200k_base",
    inputPerMTok: 0.2,
    cachedInputPerMTok: 0.02,
    cacheWritePerMTok: 0.25,
    outputPerMTok: 1.2,
  },
};

/** Looks up a model's pricing/tokenizer entry, or throws (fail closed). */
export function getModelPricing(model: string): ModelPricing {
  const pricing = PRICING[model];
  if (!pricing) {
    throw new Error(
      `No pricing entry for model "${model}" — refusing to price at zero. ` +
        `Add it to src/providers/llm/pricing.ts.`,
    );
  }
  return pricing;
}

export function supportedModels(): string[] {
  return Object.keys(PRICING);
}

export function priceUsd(model: string, usage: UsageTokens): number {
  return computeCost(getModelPricing(model), usage);
}
