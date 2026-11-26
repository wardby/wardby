/**
 * The model catalog's shapes. A CatalogEntry is everything wardby needs to
 * route, price, tokenize and shape requests for one model; every field is
 * required (CLAUDE.md "LLM pricing tables — STRICT": cache rates are never
 * omitted and never derived).
 */
import type { TokenizerEncoding } from "./pricing-core.js";
import { isLlmEffort, type LlmEffort } from "./types.js";

export const MODEL_PROVIDERS = ["openai", "anthropic", "bedrock-claude", "vertex-gemini", "google-ai-studio"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * How a Claude model takes extended thinking. adaptive: `{type: "adaptive"}`
 * plus an effort level. manual: `{type: "enabled", budget_tokens}` and no
 * effort (Claude Haiku 4.5 returns a 400 for adaptive). none: no thinking
 * parameter (OpenAI models). level: Gemini's
 * generationConfig.thinkingConfig.thinkingLevel, set from the effort level;
 * thinking cannot be turned off.
 */
export const THINKING_MODES = ["adaptive", "manual", "none", "level"] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];

export const TOKENIZER_ENCODINGS = ["cl100k_base", "o200k_base"] as const;

export interface CatalogEntry {
  provider: ModelProvider;
  /** Exact string an Agent.model must equal. */
  modelId: string;
  encoding: TokenizerEncoding;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
  cacheWritePerMTok: number;
  /** Effort levels the model accepts; empty = never send one. */
  efforts: readonly LlmEffort[];
  thinkingMode: ThinkingMode;
}

/** An entry as the merged catalog serves it. */
export interface ResolvedCatalogEntry extends CatalogEntry {
  origin: "shipped" | "override";
  /** "shipped:<SHIPPED_CATALOG_VERSION>" or the override row's updatedAt (ISO). */
  priceVersion: string;
  /** Overrides of a shipped model only: whether the shipped entry now differs. */
  shippedDiffers?: boolean;
  /** Overrides only. */
  sourceUrl?: string;
  updatedBy?: string;
  updatedAt?: Date;
}

/** A ModelCatalogEntry row, validated. */
export interface CatalogRow extends CatalogEntry {
  enabled: boolean;
  sourceUrl: string;
  updatedBy: string;
  /** When the row was first written: decides which provider owns a non-shipped id (ownerOf). */
  createdAt: Date;
  updatedAt: Date;
}

export type ModelUnavailableReason = "not_in_catalog" | "disabled" | "provider_not_configured";

const REASON_TEXT: Record<ModelUnavailableReason, string> = {
  not_in_catalog: "is not in this deployment's model catalog",
  disabled: "is disabled in this deployment's model catalog",
  provider_not_configured: "belongs to a provider with no credentials configured in this deployment",
};

/** A model the deployment cannot run. Thrown before any spend. */
export class ModelUnavailableError extends Error {
  readonly code = "model_unavailable" as const;
  constructor(
    readonly modelId: string,
    readonly reason: ModelUnavailableReason,
  ) {
    super(`model_unavailable: Model "${modelId}" ${REASON_TEXT[reason]} (reason: ${reason}). See list_models.`);
    this.name = "ModelUnavailableError";
  }
}

/** Strips a resolved entry down to the stored snapshot shape. */
export function entryOf(entry: CatalogEntry): CatalogEntry {
  return {
    provider: entry.provider,
    modelId: entry.modelId,
    encoding: entry.encoding,
    inputPerMTok: entry.inputPerMTok,
    outputPerMTok: entry.outputPerMTok,
    cachedInputPerMTok: entry.cachedInputPerMTok,
    cacheWritePerMTok: entry.cacheWritePerMTok,
    efforts: [...entry.efforts],
    thinkingMode: entry.thinkingMode,
  };
}

export function sameEntry(a: CatalogEntry, b: CatalogEntry): boolean {
  return JSON.stringify(entryOf(a)) === JSON.stringify(entryOf(b));
}

const rate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Parses a stored snapshot (Run.pricingSnapshot, CodingProxySession.catalogEntry); null if absent or malformed. */
export function parseStoredEntry(value: unknown): CatalogEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!(MODEL_PROVIDERS as readonly unknown[]).includes(v.provider)) return null;
  if (typeof v.modelId !== "string" || v.modelId.length === 0) return null;
  if (!(TOKENIZER_ENCODINGS as readonly unknown[]).includes(v.encoding)) return null;
  if (![v.inputPerMTok, v.outputPerMTok, v.cachedInputPerMTok, v.cacheWritePerMTok].every(rate)) return null;
  if (!Array.isArray(v.efforts) || !v.efforts.every(isLlmEffort)) return null;
  if (!(THINKING_MODES as readonly unknown[]).includes(v.thinkingMode)) return null;
  return entryOf(v as unknown as CatalogEntry);
}
