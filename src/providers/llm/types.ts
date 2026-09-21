/**
 * LLM seam — streaming chat with tool-calling and usage accounting.
 *
 * The budget guardrail (wardby's differentiator) hangs off `countTokens`
 * and `priceUsd`: the core estimates cost pre-flight and can stop a run
 * *before* it incurs spend, not just report spend after the fact.
 *
 * Default adapter: OpenAiLlmProvider. Anthropic adapter: AnthropicLlmProvider.
 * Selected per-agent by RoutingLlmProvider (Agent.model -> provider).
 * Bedrock-hosted Claude is a reserved future adapter (shared claude-messages.ts core).
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on `role: "tool"` messages to correlate with the originating call. */
  toolCallId?: string;
  /** Optional tool/function name (for tool results or named messages). */
  name?: string;
  /**
   * Set on an `role: "assistant"` message that made tool calls. Providers
   * require the assistant message preceding tool-result messages to
   * replay the calls it made — omitting this on a follow-up turn breaks
   * the conversation, since the provider can no longer correlate the
   * `role: "tool"` results that follow it.
   */
  toolCalls?: { id: string; name: string; argsJson: string }[];
}

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

export interface LlmUsage {
  /** Total input tokens, including any served from cache. */
  inputTokens: number;
  outputTokens: number;
  /** Subset of `inputTokens` served from a provider-side prompt cache, if reported. */
  cachedInputTokens?: number;
  /** Tokens billed for writing a new prompt-cache entry, if the provider charges for it. */
  cacheWriteTokens?: number;
  costUsd: number;
}

export type LlmStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; argsJson: string }
  | { type: "done"; stopReason: string; usage: LlmUsage };

export interface LlmProvider {
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent>;
  /**
   * Pre-flight token count for budget enforcement. `tools`, when passed,
   * must be counted too — a provider bills the serialized tool schemas as
   * input tokens alongside the messages, so an estimate that ignores them
   * under-counts by however large the attached tool roster is.
   */
  countTokens(model: string, messages: LlmMessage[], tools?: LlmToolDef[]): Promise<number>;
  /** Deterministic price for a given token usage (no network call). */
  priceUsd(
    model: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
    },
  ): number;
}
