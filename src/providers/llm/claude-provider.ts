/**
 * LlmProvider implementation shared by every Claude-protocol adapter (direct
 * Anthropic API, Bedrock-Claude, and any future Claude-protocol client).
 * Imports no SDK — the client and catalog lookup are injected, so this file
 * stays exactly what each concrete adapter (anthropic.ts, bedrock.ts) has in
 * common, and nothing more.
 */
import type { LlmMessage, LlmRequest, LlmStreamEvent, LlmStreamHooks, LlmToolDef } from "./types.js";
import {
  toClaudeRequest,
  withCacheBreakpoints,
  mapClaudeStream,
  estimateClaudeTokens,
  type ClaudeStreamEvent,
} from "./claude-messages.js";
import { computeCost } from "./pricing-core.js";
import { currentLookup, pinnedLookup, type CatalogLookup } from "./catalog-lookup.js";
import type { CatalogEntry } from "./catalog-types.js";
import type { CatalogLlmAdapter } from "./routing.js";

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

export class ClaudeLlmProvider implements CatalogLlmAdapter {
  constructor(
    protected readonly client: ClaudeMessagesClient,
    private readonly lookup: CatalogLookup = currentLookup,
  ) {}

  withEntry(entry: CatalogEntry): ClaudeLlmProvider {
    return new ClaudeLlmProvider(this.client, pinnedLookup(entry));
  }

  async *stream(req: LlmRequest, signal?: AbortSignal, hooks?: LlmStreamHooks): AsyncIterable<LlmStreamEvent> {
    // Defence in depth behind config-time validation: a level the model
    // doesn't accept would fail the whole call, so it is dropped here.
    const { effort, ...rest } = req;
    const accepted = effort && this.lookup(req.model).efforts.includes(effort);
    const claudeReq = withCacheBreakpoints(toClaudeRequest(accepted ? { ...rest, effort } : rest, DEFAULT_MAX_TOKENS));
    const raw = this.client.messages.stream(
      { model: req.model, ...claudeReq },
      { signal },
    ) as AsyncIterable<ClaudeStreamEvent>;
    yield* mapClaudeStream(raw, (usage) => this.priceUsd(req.model, usage), hooks?.onResponseStarted);
  }

  async countTokens(model: string, messages: LlmMessage[], tools?: LlmToolDef[]): Promise<number> {
    this.lookup(model); // fail-closed on a model the catalog does not serve
    return Math.ceil(estimateClaudeTokens(messages, tools) * CLAUDE_TOKEN_INFLATION);
  }

  priceUsd(
    model: string,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number },
  ): number {
    return computeCost(this.lookup(model), usage);
  }
}
