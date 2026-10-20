import { computeCost, type ModelPricing } from "../llm/pricing-core.js";
import { CACHE_WINDOW_MS } from "./hold.js";
import type { PreviousReply, ProxyUsage } from "./types.js";

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
  /** UTF-8 bytes of the request body the proxy forwarded, when known. */
  bodyBytes?: number;
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
 * Prompt tokens for request-body bytes in a settled estimate: ceil(bytes / 3), the same high count
 * as the native gateway's byte estimate. Coding-agent bodies are mostly code, JSON and English,
 * which tokenize at about 3.5 to 4.5 bytes a token, so a token per 3 bytes stays above the real
 * count. Text that tokenizes tighter is mostly multi-byte UTF-8 (3 bytes a character, rarely more
 * than a token each), and base64 images are billed by size, not bytes, so both still lean high.
 * The hold itself still counts a token per byte (hold.ts): this is only the settled estimate.
 */
export function bodyInputTokens(bytes: number): number {
  return bytes > 0 ? Math.ceil(bytes / 3) : 0;
}

/**
 * New prompt tokens as usage, at the higher of the model's fresh-input and cache-write rates: the
 * provider may write them to its cache (Claude Code marks the latest message; OpenAI GPT-5.6 and
 * later bill cache writes above input), or bill them as input.
 */
function uncachedInput(tokens: number, pricing: ModelPricing): { inputTokens: number; cacheWriteTokens: number } {
  const written = (pricing.cacheWritePerMTok ?? pricing.inputPerMTok) > pricing.inputPerMTok;
  return { inputTokens: written ? 0 : tokens, cacheWriteTokens: written ? tokens : 0 };
}

/**
 * The input of a cut request from its conversation's previous reply: that reply's prompt and cache
 * split, plus the body's growth since (bodyInputTokens) as uncached input (uncachedInput).
 * Undefined when that reply can't stand for this prompt, as for the hold (hold.ts): another model,
 * estimated or unfinished, an unknown or larger body, or a cache that had expired by the time the
 * request was reserved. The estimate then prices the whole body as uncached input.
 */
export function previousInput(input: {
  model: string;
  bodyBytes: number | undefined;
  previous: PreviousReply | null;
  pricing: ModelPricing;
  /** When the request was reserved: the hold's own clock. */
  now: Date;
}): ProxyUsage | undefined {
  const { previous, bodyBytes } = input;
  if (!previous || previous.model !== input.model || previous.costEstimated) return undefined;
  if (previous.status !== "completed" || !previous.usage) return undefined;
  if (bodyBytes === undefined || previous.requestBytes === null || bodyBytes < previous.requestBytes) return undefined;
  if (input.now.getTime() - previous.startedAt.getTime() > CACHE_WINDOW_MS) return undefined;
  const growth = uncachedInput(bodyInputTokens(bodyBytes - previous.requestBytes), input.pricing);
  const usage = previous.usage;
  return {
    inputTokens: usage.inputTokens + growth.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens + growth.cacheWriteTokens,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

/**
 * The best known cost of a reply that broke before its final usage (spec PR 1
 * › 1b): usage already read, else the input from its conversation's previous
 * reply (previousInput), else the whole body as uncached input
 * (bodyInputTokens), else (body size unknown) the input part of the hold; plus
 * the output seen so far. With no output seen, the model's median completed
 * reply, or none while there is no completed reply (a deliberate rule: one cut
 * must not book a whole reserved reply). A stream that failed before its
 * response started generated none. Never more than the request's worst case.
 */
export function estimateInterrupted(facts: InterruptedFacts, pricing: ModelPricing): InterruptedEstimate {
  const relayed = relayedOutputTokens(facts.relayedOutputBytes);
  const output = relayed > 0 || facts.beforeResponse ? relayed : (facts.medianOutputTokens ?? 0);
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
  if (facts.bodyBytes !== undefined) {
    const usage: ProxyUsage = {
      ...uncachedInput(bodyInputTokens(facts.bodyBytes), pricing),
      cachedInputTokens: 0,
      outputTokens: output,
      reasoningTokens: 0,
    };
    return { usage, costUsd: clamp(computeCost(pricing, usage)) };
  }
  const usage: ProxyUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: output,
    reasoningTokens: 0,
  };
  const inputPart = facts.reservationUsd - (facts.maxOutputTokens * pricing.outputPerMTok) / 1_000_000;
  return { usage, costUsd: clamp(inputPart + (usage.outputTokens * pricing.outputPerMTok) / 1_000_000) };
}
