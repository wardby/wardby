/**
 * Shared pricing types + cost math, provider-agnostic. Each LLM adapter
 * owns its own model table but prices through this one `computeCost`, so the
 * cache-read/cache-write accounting can never diverge between providers.
 */
export type TokenizerEncoding = "cl100k_base" | "o200k_base";

export interface ModelPricing {
  encoding: TokenizerEncoding;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * A model missing `cachedInputPerMTok` / `cacheWritePerMTok` falls back to the
 * full input rate — fail-toward-overestimate, never underestimate.
 * `inputTokens` is the total billed at the *fresh* rate PLUS cache-read;
 * cache-write tokens are billed separately and are NOT part of `inputTokens`.
 */
export function computeCost(pricing: ModelPricing, usage: UsageTokens): number {
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const freshInputTokens = usage.inputTokens - cachedInputTokens;
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  const cacheWriteRate = pricing.cacheWritePerMTok ?? pricing.inputPerMTok;
  return (
    (freshInputTokens / 1_000_000) * pricing.inputPerMTok +
    (cachedInputTokens / 1_000_000) * cachedRate +
    (cacheWriteTokens / 1_000_000) * cacheWriteRate +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}
