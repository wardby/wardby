import { computeCost, type ModelPricing } from "../llm/pricing-core.js";
import type { ProxyUsage } from "./types.js";

export interface InterruptedFacts {
  /** Anthropic message_start usage already read (inputTokens includes cache reads, not writes). */
  readUsage?: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number };
  /** Output tokens the upstream reported so far (Anthropic message_delta), if any. */
  reportedOutputTokens?: number;
  /** message_start's output count: a placeholder (usually 1), so only a floor, never the count. */
  outputFloorTokens?: number;
  /** UTF-8 bytes of output relayed to the client before the break: text, tool input, thinking. */
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
 * part of the hold; plus the output seen so far. With no output seen and no
 * run median to go by, the output the hold reserved for: an unknown output
 * fails toward overestimating. Never more than the request's worst case.
 */
export function estimateInterrupted(facts: InterruptedFacts, pricing: ModelPricing): InterruptedEstimate {
  const relayed = relayedOutputTokens(facts.relayedOutputBytes);
  const output = relayed > 0 ? relayed : (facts.medianOutputTokens ?? facts.maxOutputTokens);
  const clamp = (cost: number) => Math.max(0, Math.min(cost, facts.ceilingUsd ?? facts.reservationUsd));
  if (facts.readUsage) {
    const usage: ProxyUsage = {
      ...facts.readUsage,
      outputTokens: facts.reportedOutputTokens ?? Math.max(facts.outputFloorTokens ?? 0, output),
      reasoningTokens: 0,
    };
    return { usage, costUsd: clamp(computeCost(pricing, usage)) };
  }
  if (facts.previous) {
    const usage: ProxyUsage = {
      inputTokens: facts.previous.inputTokens,
      cachedInputTokens: facts.previous.cachedInputTokens,
      cacheWriteTokens: facts.previous.cacheWriteTokens,
      outputTokens: output,
      reasoningTokens: 0,
    };
    return { usage, costUsd: clamp(computeCost(pricing, usage)) };
  }
  const usage: ProxyUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: relayed > 0 ? relayed : facts.maxOutputTokens,
    reasoningTokens: 0,
  };
  const inputPart = facts.reservationUsd - (facts.maxOutputTokens * pricing.outputPerMTok) / 1_000_000;
  return { usage, costUsd: clamp(inputPart + (usage.outputTokens * pricing.outputPerMTok) / 1_000_000) };
}
