import { computeCost, type ModelPricing } from "../llm/pricing-core.js";
import { CACHE_WINDOW_MS } from "./hold.js";
import type { PreviousReply, ProxyProtocol, ProxyUsage } from "./types.js";

export interface InterruptedFacts {
  /** Anthropic message_start usage already read (inputTokens includes cache reads, not writes). */
  readUsage?: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number };
  /** Output tokens the upstream reported so far (Anthropic message_delta), if any. */
  reportedOutputTokens?: number;
  /** message_start's output count: a placeholder (usually 1), so only a floor, never the count. */
  outputFloorTokens?: number;
  /** A stream that failed before its response started: the provider generated no output. */
  beforeResponse?: boolean;
  /** UTF-8 bytes of output relayed to the client before the break: text, tool input, thinking. */
  relayedOutputBytes: number;
  /** The input of the request's own prompt, from its conversation's previous reply (previousInput). */
  previous?: ProxyUsage;
  /** Median outputTokens of the session's completed replies for the same model, if any. */
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
 * The input of a cut request from its conversation's previous reply: that reply's prompt and cache
 * split, plus the body's growth since (a token per byte, a deliberately high count) as uncached
 * input. On Anthropic the growth is a cache write (Claude Code marks the latest message), the higher
 * rate. Undefined when that reply can't stand for this prompt, as for the hold (hold.ts): another
 * model, estimated or unfinished, an unknown or larger body, or an expired cache. The estimate then
 * keeps the input part of the hold.
 */
export function previousInput(input: {
  protocol: ProxyProtocol;
  model: string;
  bodyBytes: number | undefined;
  previous: PreviousReply | null;
  now: Date;
}): ProxyUsage | undefined {
  const { previous, bodyBytes } = input;
  if (!previous || previous.model !== input.model || previous.costEstimated) return undefined;
  if (previous.status !== "completed" || !previous.usage) return undefined;
  if (bodyBytes === undefined || previous.requestBytes === null || bodyBytes < previous.requestBytes) return undefined;
  if (input.now.getTime() - previous.startedAt.getTime() > CACHE_WINDOW_MS) return undefined;
  const growth = bodyBytes - previous.requestBytes;
  const written = input.protocol === "anthropic-messages";
  const usage = previous.usage;
  return {
    inputTokens: usage.inputTokens + (written ? 0 : growth),
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens + (written ? growth : 0),
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

/**
 * The best known cost of a reply that broke before its final usage (spec PR 1
 * › 1b): usage already read, else the input from its conversation's previous
 * reply (previousInput), else the input part of the hold; plus the output seen
 * so far. With no output seen and no run median to go by, the output the hold reserved for: an unknown output
 * fails toward overestimating. A stream that failed before its response
 * started generated none. Never more than the request's worst case.
 */
export function estimateInterrupted(facts: InterruptedFacts, pricing: ModelPricing): InterruptedEstimate {
  const relayed = relayedOutputTokens(facts.relayedOutputBytes);
  const unknown = facts.beforeResponse ? 0 : facts.maxOutputTokens;
  const output = relayed > 0 || facts.beforeResponse ? relayed : (facts.medianOutputTokens ?? unknown);
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
    outputTokens: relayed > 0 ? relayed : unknown,
    reasoningTokens: 0,
  };
  const inputPart = facts.reservationUsd - (facts.maxOutputTokens * pricing.outputPerMTok) / 1_000_000;
  return { usage, costUsd: clamp(inputPart + (usage.outputTokens * pricing.outputPerMTok) / 1_000_000) };
}
