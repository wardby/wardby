/**
 * A model request's hold: what the proxy reserves against the run's budget before forwarding it.
 * After a mostly cached reply in the same conversation, the part of the prompt the previous reply
 * read from (or wrote to) the cache is priced at the cache-read rate; everything else, including
 * what the body grew by (one token per byte), at the input + cache-write rates. Capped at the
 * ceiling, today's worst case (the whole body as uncached input), which a reply may never exceed.
 */
import { createHash } from "node:crypto";
import type { ModelPricing } from "../llm/pricing-core.js";
import { estimateReservationUsd } from "./metering.js";
import type { PreviousReply, ProxyProtocol, ReservationBasis } from "./types.js";

/** Anthropic's prompt cache lives 5 minutes; an older previous reply says nothing about the cache. */
export const CACHE_WINDOW_MS = 5 * 60_000;
export const MIN_CACHED_SHARE = 0.5;

export type HoldFallback =
  | "no_previous"
  | "model_changed"
  | "previous_estimated"
  | "previous_not_completed"
  | "no_request_bytes"
  | "cache_expired"
  | "body_shrank"
  | "low_cache_share";

export interface HoldEstimate {
  holdUsd: number;
  ceilingUsd: number;
  basis: ReservationBasis;
  fallback?: HoldFallback;
  cachedTokens?: number;
  uncachedTokens?: number;
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "cache_control")
      .map(([key, inner]) => [key, withoutCacheControl(inner)]),
  );
}

/**
 * What identifies one conversation within a run (Claude Code runs several: the main one and its
 * sub-agents). Anthropic: the first message without cache markers (the system prompt carries a
 * per-version billing line). OpenAI: prompt_cache_key, else instructions + the first input item.
 */
export function conversationKey(protocol: ProxyProtocol, body: Record<string, unknown>): string | null {
  let basis: unknown;
  if (protocol === "anthropic-messages") {
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    basis = ["anthropic", withoutCacheControl(messages[0])];
  } else if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key) {
    basis = ["openai-key", body.prompt_cache_key];
  } else {
    const input = body.input;
    const first = typeof input === "string" ? input : Array.isArray(input) ? (input[0] as unknown) : undefined;
    if (first === undefined) return null;
    basis = ["openai-first", body.instructions ?? null, first];
  }
  return createHash("sha256").update(JSON.stringify(basis)).digest("base64url");
}

export function estimateHold(input: {
  protocol: ProxyProtocol;
  model: string;
  bodyBytes: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  previous: PreviousReply | null;
  now: Date;
}): HoldEstimate {
  const ceilingUsd = estimateReservationUsd(input.bodyBytes, input.maxOutputTokens, input.pricing);
  const full = (fallback: HoldFallback): HoldEstimate => ({ holdUsd: ceilingUsd, ceilingUsd, basis: "full", fallback });
  const previous = input.previous;
  if (!previous) return full("no_previous");
  if (previous.model !== input.model) return full("model_changed");
  if (previous.costEstimated) return full("previous_estimated");
  if (previous.status !== "completed" || !previous.usage) return full("previous_not_completed");
  if (previous.requestBytes === null) return full("no_request_bytes");
  if (!previous.completedAt || input.now.getTime() - previous.completedAt.getTime() > CACHE_WINDOW_MS) {
    return full("cache_expired");
  }
  if (input.bodyBytes < previous.requestBytes) return full("body_shrank");
  const usage = previous.usage;
  const prevPrompt = usage.inputTokens + usage.cacheWriteTokens;
  const cachedTokens =
    input.protocol === "anthropic-messages"
      ? usage.cachedInputTokens + usage.cacheWriteTokens
      : usage.cachedInputTokens;
  if (prevPrompt <= 0 || cachedTokens < prevPrompt * MIN_CACHED_SHARE) return full("low_cache_share");
  const uncachedTokens = prevPrompt + (input.bodyBytes - previous.requestBytes) - cachedTokens;
  const { pricing } = input;
  const cacheReadRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  const cacheWriteRate = pricing.cacheWritePerMTok ?? pricing.inputPerMTok;
  const holdUsd =
    (cachedTokens * cacheReadRate +
      uncachedTokens * (pricing.inputPerMTok + cacheWriteRate) +
      input.maxOutputTokens * pricing.outputPerMTok) /
    1_000_000;
  return { holdUsd: Math.min(holdUsd, ceilingUsd), ceilingUsd, basis: "cached", cachedTokens, uncachedTokens };
}
