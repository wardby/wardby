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

export function parseAnthropicAuthoritativeUsage(value: unknown): ProxyUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_authoritative_usage");
  const usage = value as Record<string, unknown>;
  const cachedInputTokens = tokenCount(usage.cache_read_input_tokens ?? 0, "cache_read_input_tokens");
  return {
    inputTokens: tokenCount(usage.input_tokens, "input_tokens") + cachedInputTokens,
    outputTokens: tokenCount(usage.output_tokens, "output_tokens"),
    cachedInputTokens,
    cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens ?? 0, "cache_creation_input_tokens"),
    reasoningTokens: 0,
  };
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

function sseEvent(frame: string): { name?: string; value?: Record<string, unknown> } {
  const lines = frame.split("\n");
  const name = lines
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return { name };
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error("invalid_upstream_sse");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_upstream_sse");
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || (name && name !== record.type)) throw new Error("invalid_upstream_sse");
  return { name, value: record };
}

/** Accumulates Anthropic's split input/output usage until message_stop. */
export class AnthropicSseUsageTracker {
  private startUsage?: Record<string, unknown>;
  private outputTokens?: number;
  private stopped = false;

  consume(frame: string): TerminalUsage {
    const { value } = sseEvent(frame);
    if (!value) return { terminal: false };
    switch (value.type) {
      case "message_start": {
        if (this.startUsage || !value.message || typeof value.message !== "object") {
          throw new Error("invalid_upstream_sse");
        }
        const usage = (value.message as Record<string, unknown>).usage;
        if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("invalid_upstream_sse");
        const record = usage as Record<string, unknown>;
        tokenCount(record.input_tokens, "input_tokens");
        tokenCount(record.cache_read_input_tokens ?? 0, "cache_read_input_tokens");
        tokenCount(record.cache_creation_input_tokens ?? 0, "cache_creation_input_tokens");
        this.startUsage = record;
        if (record.output_tokens !== undefined) this.outputTokens = tokenCount(record.output_tokens, "output_tokens");
        return { terminal: false };
      }
      case "message_delta": {
        const usage = value.usage;
        if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("invalid_upstream_sse");
        this.outputTokens = tokenCount((usage as Record<string, unknown>).output_tokens, "output_tokens");
        return { terminal: false };
      }
      case "message_stop": {
        if (this.stopped || !this.startUsage || this.outputTokens === undefined) {
          return { terminal: true };
        }
        this.stopped = true;
        return {
          terminal: true,
          usage: parseAnthropicAuthoritativeUsage({ ...this.startUsage, output_tokens: this.outputTokens }),
        };
      }
      default:
        return { terminal: false };
    }
  }
}

export function pricingSnapshot(version: string, pricing: ModelPricing): PricingSnapshot {
  return { version, ...pricing };
}
