import { createHash } from "node:crypto";
import { computeCost, type ModelPricing } from "../llm/pricing.js";
import type { PricingSnapshot, ProxyUsage } from "./types.js";

const MAX_SAFE_TOKENS = 2_000_000_000;

function tokenCount(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SAFE_TOKENS) {
    throw new Error(`invalid_authoritative_usage:${name}`);
  }
  return value as number;
}

export function parseAuthoritativeUsage(value: unknown): ProxyUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_authoritative_usage");
  const usage = value as Record<string, unknown>;
  const inputDetails =
    usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : {};
  const outputDetails =
    usage.output_tokens_details && typeof usage.output_tokens_details === "object"
      ? (usage.output_tokens_details as Record<string, unknown>)
      : {};
  const parsed: ProxyUsage = {
    inputTokens: tokenCount(usage.input_tokens, "input_tokens"),
    outputTokens: tokenCount(usage.output_tokens, "output_tokens"),
    cachedInputTokens: tokenCount(inputDetails.cached_tokens ?? 0, "cached_tokens"),
    cacheWriteTokens: tokenCount(inputDetails.cache_write_tokens ?? 0, "cache_write_tokens"),
    reasoningTokens: tokenCount(outputDetails.reasoning_tokens ?? 0, "reasoning_tokens"),
  };
  if (parsed.cachedInputTokens > parsed.inputTokens || parsed.reasoningTokens > parsed.outputTokens) {
    throw new Error("invalid_authoritative_usage:details_exceed_total");
  }
  return parsed;
}

export function actualCostUsd(usage: ProxyUsage, pricing: ModelPricing): number {
  return computeCost(pricing, usage);
}

export function estimateReservationUsd(bodyBytes: number, maxOutputTokens: number, pricing: ModelPricing): number {
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 1) throw new Error("invalid_request_size");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error("invalid_max_output_tokens");
  const cacheWriteRate = pricing.cacheWritePerMTok ?? pricing.inputPerMTok;
  return (bodyBytes * (pricing.inputPerMTok + cacheWriteRate) + maxOutputTokens * pricing.outputPerMTok) / 1_000_000;
}

export function fingerprintRequest(body: string): string {
  return createHash("sha256").update(body).digest("base64url");
}

export interface TerminalUsage {
  terminal: boolean;
  usage?: ProxyUsage;
}

export function terminalUsageFromSseFrame(frame: string): TerminalUsage {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return { terminal: false };
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    throw new Error("invalid_upstream_sse");
  }
  if (!event || typeof event !== "object") return { terminal: false };
  const record = event as Record<string, unknown>;
  if (record.type !== "response.completed" && record.type !== "response.failed") return { terminal: false };
  const response = record.response;
  if (!response || typeof response !== "object") throw new Error("invalid_upstream_terminal_event");
  const usage = (response as Record<string, unknown>).usage;
  return { terminal: true, usage: usage == null ? undefined : parseAuthoritativeUsage(usage) };
}

export function pricingSnapshot(version: string, pricing: ModelPricing): PricingSnapshot {
  return { version, ...pricing };
}
