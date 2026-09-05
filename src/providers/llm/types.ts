/**
 * LLM seam — streaming chat with tool-calling and usage accounting.
 *
 * The budget guardrail (reevo-run's differentiator) hangs off `countTokens`
 * and `priceUsd`: the core estimates cost pre-flight and can stop a run
 * *before* it incurs spend, not just report spend after the fact.
 *
 * Default adapter: OpenAiLlmProvider.
 * Native adapter:  BedrockLlmProvider.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on `role: "tool"` messages to correlate with the originating call. */
  toolCallId?: string;
  /** Optional tool/function name (for tool results or named messages). */
  name?: string;
}

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: object;
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
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type LlmStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; argsJson: string }
  | { type: "done"; stopReason: string; usage: LlmUsage };

export interface LlmProvider {
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent>;
  /** Pre-flight token count for budget enforcement. */
  countTokens(model: string, messages: LlmMessage[]): Promise<number>;
  /** Deterministic price for a given token usage (no network call). */
  priceUsd(
    model: string,
    usage: { inputTokens: number; outputTokens: number },
  ): number;
}
