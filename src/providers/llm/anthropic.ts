/**
 * Direct Anthropic (Claude) adapter for the LlmProvider seam. `@anthropic-ai/sdk`
 * is imported only here; the protocol logic lives in claude-messages.ts so a
 * future Bedrock-Claude adapter reuses it. countTokens stays offline (no
 * Anthropic count_tokens API call) to preserve the budget guardrail's
 * offline invariant — it uses the o200k_base tokenizer as a proxy with a
 * conservative inflation factor, calibrated via engine-side checkTokenCalibration.
 */
import Anthropic from "@anthropic-ai/sdk";
import { encode as encodeO200kBase } from "gpt-tokenizer/encoding/o200k_base";
import type { LlmMessage, LlmProvider, LlmRequest, LlmStreamEvent, LlmToolDef } from "./types.js";
import { toClaudeRequest, withCacheBreakpoints, mapClaudeStream, toClaudeTools, type ClaudeStreamEvent } from "./claude-messages.js";
import { anthropicPriceUsd, getAnthropicPricing } from "./pricing-anthropic.js";

export { anthropicSupportedModels } from "./pricing-anthropic.js";

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
const TOKENS_PER_MESSAGE = 3;

export function anthropicCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export class AnthropicLlmProvider implements LlmProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string = process.env.ANTHROPIC_API_KEY ?? "", client?: Anthropic) {
    if (client) { this.client = client; return; }
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set — required by the Anthropic LlmProvider adapter.");
    this.client = new Anthropic({ apiKey });
  }

  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const claudeReq = withCacheBreakpoints(toClaudeRequest(req, DEFAULT_MAX_TOKENS));
    const raw = this.client.messages.stream(
      { model: req.model, ...claudeReq } as Anthropic.MessageStreamParams,
      { signal },
    ) as AsyncIterable<ClaudeStreamEvent>;
    yield* mapClaudeStream(raw, (usage) => this.priceUsd(req.model, usage));
  }

  async countTokens(model: string, messages: LlmMessage[], tools?: LlmToolDef[]): Promise<number> {
    getAnthropicPricing(model); // fail-closed on unknown model
    let raw = 0;
    for (const m of messages) {
      raw += TOKENS_PER_MESSAGE + encodeO200kBase(m.content).length + encodeO200kBase(m.role).length;
    }
    if (tools && tools.length > 0) {
      raw += encodeO200kBase(JSON.stringify(toClaudeTools(tools))).length;
    }
    return Math.ceil(raw * CLAUDE_TOKEN_INFLATION);
  }

  priceUsd(model: string, usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number }): number {
    return anthropicPriceUsd(model, usage);
  }
}
