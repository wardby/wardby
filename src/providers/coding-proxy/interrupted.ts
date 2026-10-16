import { computeCost, type ModelPricing } from "../llm/pricing-core.js";
import type { ProxyUsage } from "./types.js";

export interface InterruptedFacts {
  /** Anthropic message_start usage already read (inputTokens includes cache reads, not writes). */
  readUsage?: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number };
  /** Output tokens the upstream reported so far (Anthropic message_delta), if any. */
  reportedOutputTokens?: number;
  /** UTF-8 bytes of output text relayed to the client before the break. */
  relayedOutputBytes: number;
  /** Usage of the session's latest completed, non-estimated reply for the same model. */
  previous?: ProxyUsage;
  /** Median outputTokens of the session's completed replies, if any. */
  medianOutputTokens?: number;
  /** The request's hold and the output tokens it reserved for. */
  reservationUsd: number;
  maxOutputTokens: number;
  /** The request's worst case (its ceiling); the estimate never exceeds it. Defaults to the hold. */
  ceilingUsd?: number;
}

export interface InterruptedEstimate {
  usage: ProxyUsage;
  costUsd: number;
}

/** Output tokens for relayed text: ceil(bytes / 3), a deliberately high count. */
export function relayedOutputTokens(bytes: number): number {
  return bytes > 0 ? Math.ceil(bytes / 3) : 0;
}

/**
 * The best known cost of a reply that broke before its final usage (spec PR 1
 * › 1b): usage already read, else the previous reply's input, else the input
 * part of the hold; plus the output seen so far. Never more than the request's worst case.
 */
export function estimateInterrupted(facts: InterruptedFacts, pricing: ModelPricing): InterruptedEstimate {
  const relayed = relayedOutputTokens(facts.relayedOutputBytes);
  const clamp = (cost: number) => Math.max(0, Math.min(cost, facts.ceilingUsd ?? facts.reservationUsd));
  if (facts.readUsage) {
    const usage: ProxyUsage = {
      ...facts.readUsage,
      outputTokens: facts.reportedOutputTokens ?? relayed,
      reasoningTokens: 0,
    };
    return { usage, costUsd: clamp(computeCost(pricing, usage)) };
  }
  if (facts.previous) {
    const usage: ProxyUsage = {
      inputTokens: facts.previous.inputTokens,
      cachedInputTokens: facts.previous.cachedInputTokens,
      cacheWriteTokens: facts.previous.cacheWriteTokens,
      outputTokens: facts.relayedOutputBytes > 0 ? relayed : (facts.medianOutputTokens ?? 0),
      reasoningTokens: 0,
    };
    return { usage, costUsd: clamp(computeCost(pricing, usage)) };
  }
  const usage: ProxyUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: relayed,
    reasoningTokens: 0,
  };
  const inputPart = facts.reservationUsd - (facts.maxOutputTokens * pricing.outputPerMTok) / 1_000_000;
  return { usage, costUsd: clamp(inputPart + (relayed * pricing.outputPerMTok) / 1_000_000) };
}
