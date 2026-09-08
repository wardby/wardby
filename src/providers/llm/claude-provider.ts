/**
 * LlmProvider implementation shared by every Claude-protocol adapter (direct
 * Anthropic API, Bedrock-Claude, and any future Claude-protocol client).
 * Imports no SDK — the client and pricing module are injected, so this file
 * stays exactly what each concrete adapter (anthropic.ts, bedrock.ts) has in
 * common, and nothing more.
 */
import type { LlmMessage, LlmProvider, LlmRequest, LlmStreamEvent, LlmToolDef } from "./types.js";
import {
  toClaudeRequest,
  withCacheBreakpoints,
  mapClaudeStream,
  estimateClaudeTokens,
  type ClaudeStreamEvent,
} from "./claude-messages.js";
import type { ModelPricing, UsageTokens } from "./pricing-core.js";

/**
 * Structural shape every Claude-protocol SDK client satisfies. Loose on
 * purpose — params/return are untyped here, mirroring the cast anthropic.ts
 * already needed before this extraction (its own SDK's stream() params/
 * return never lined up 1:1 with this codebase's own request/event shapes).
 */
export interface ClaudeMessagesClient {
  messages: {
    stream(params: unknown, options?: { signal?: AbortSignal }): unknown;
  };
}

export interface ClaudePricingModule {
  /** Must throw on an unknown model — fail-closed, never price at zero. */
  getPricing(model: string): ModelPricing;
  priceUsd(model: string, usage: UsageTokens): number;
}

// Anthropic's own guidance: don't lowball max_tokens — hitting the cap
// truncates output mid-thought with no error, silently handing engine-native.ts
// (which never sets LlmRequest.maxTokens, and never checks stopReason) a
// clipped "final" answer it treats as complete. This adapter streams, so a
// generous ceiling costs nothing in latency; the budget guardrail is driven
// by actual token counts (core/budget.ts), not by this cap.
const DEFAULT_MAX_TOKENS = 16000;
// Claude has no offline tokenizer; o200k_base is a proxy. Bias high so the
// pre-flight refuse never admits an over-budget run on an under-count.
const CLAUDE_TOKEN_INFLATION = 1.2;

export class ClaudeLlmProvider implements LlmProvider {
  constructor(
    private readonly client: ClaudeMessagesClient,
    private readonly pricing: ClaudePricingModule,
  ) {}

  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const claudeReq = withCacheBreakpoints(toClaudeRequest(req, DEFAULT_MAX_TOKENS));
    const raw = this.client.messages.stream({ model: req.model, ...claudeReq }, { signal }) as AsyncIterable<
      ClaudeStreamEvent
    >;
    yield* mapClaudeStream(raw, (usage) => this.priceUsd(req.model, usage));
  }

  async countTokens(model: string, messages: LlmMessage[], tools?: LlmToolDef[]): Promise<number> {
    this.pricing.getPricing(model); // fail-closed on unknown model
    return Math.ceil(estimateClaudeTokens(messages, tools) * CLAUDE_TOKEN_INFLATION);
  }

  priceUsd(
    model: string,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number },
  ): number {
    return this.pricing.priceUsd(model, usage);
  }
}
