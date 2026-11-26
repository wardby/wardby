/**
 * LlmProvider shared by both Gemini backends. Endpoint and auth come from a
 * GeminiTransport (google-ai-studio.ts, vertex-gemini.ts); everything else is
 * gemini-content.ts. Mirrors claude-provider.ts for the Claude backends.
 */
import type { LlmMessage, LlmRequest, LlmStreamEvent, LlmStreamHooks, LlmToolDef } from "./types.js";
import { toGeminiBody, parseGeminiSse, mapGeminiStream, geminiError } from "./gemini-content.js";
import { estimateClaudeTokens } from "./claude-messages.js";
import { computeCost } from "./pricing-core.js";
import { currentLookup, pinnedLookup, type CatalogLookup } from "./catalog-lookup.js";
import type { CatalogEntry } from "./catalog-types.js";
import type { CatalogLlmAdapter } from "./routing.js";

// No offline Gemini tokenizer: o200k_base as a proxy, biased high so the pre-flight
// refuse never admits an over-budget run on an under-count (same as Claude).
const GEMINI_TOKEN_INFLATION = 1.2;
const MAX_ERROR_BODY_BYTES = 16_384;

export interface GeminiTransport {
  url(googleModel: string, modelId: string): string;
  headers(): Promise<Record<string, string>>;
  fetch: typeof globalThis.fetch;
}

export class GeminiLlmProvider implements CatalogLlmAdapter {
  constructor(
    protected readonly transport: GeminiTransport,
    private readonly toGoogleModel: (modelId: string) => string,
    private readonly lookup: CatalogLookup = currentLookup,
  ) {}

  withEntry(entry: CatalogEntry): GeminiLlmProvider {
    return new GeminiLlmProvider(this.transport, this.toGoogleModel, pinnedLookup(entry));
  }

  async *stream(req: LlmRequest, signal?: AbortSignal, hooks?: LlmStreamHooks): AsyncIterable<LlmStreamEvent> {
    const entry = this.lookup(req.model);
    const response = await this.transport.fetch(this.transport.url(this.toGoogleModel(req.model), req.model), {
      method: "POST",
      headers: { ...(await this.transport.headers()), "content-type": "application/json" },
      body: JSON.stringify(toGeminiBody(req, entry)),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = (await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY_BYTES);
      throw geminiError(response.status, text);
    }
    hooks?.onResponseStarted?.();
    yield* mapGeminiStream(parseGeminiSse(response.body), (u) => computeCost(entry, u));
  }

  async countTokens(model: string, messages: LlmMessage[], tools?: LlmToolDef[]): Promise<number> {
    this.lookup(model);
    return Math.ceil(estimateClaudeTokens(messages, tools) * GEMINI_TOKEN_INFLATION);
  }

  priceUsd(
    model: string,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number },
  ): number {
    return computeCost(this.lookup(model), usage);
  }
}
