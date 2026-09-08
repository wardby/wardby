/**
 * Client-agnostic Claude Messages protocol. Pure functions, no SDK import,
 * so a future Bedrock-Claude adapter reuses them unchanged — Bedrock and the
 * direct API differ only in client/auth, model IDs, and pricing.
 */
import { encode as encodeO200kBase } from "gpt-tokenizer/encoding/o200k_base";
import type { LlmMessage, LlmRequest, LlmToolDef, LlmStreamEvent, LlmUsage } from "./types.js";

export interface CacheControl {
  type: "ephemeral";
}
export interface ClaudeTextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}
export interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: CacheControl;
}
export interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  cache_control?: CacheControl;
}
export type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock;
export interface ClaudeMessage {
  role: "user" | "assistant";
  content: ClaudeContentBlock[];
}
export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}
export interface ClaudeRequest {
  system?: ClaudeTextBlock[];
  messages: ClaudeMessage[];
  tools?: ClaudeTool[];
  max_tokens: number;
}

function parseArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson || "{}");
  } catch {
    return {};
  }
}

/**
 * Same shape sent to the API in `toClaudeRequest` — kept as one function so
 * a pre-flight token estimate (AnthropicLlmProvider.countTokens) can never
 * drift from what's actually serialized into the request. Mirrors the
 * OpenAI adapter's `toOpenAiTools`, which guards against the same failure
 * class: a duplicated tool-schema mapping once desynced the pre-flight
 * estimate from the real request and broke the budget guardrail's turn-1
 * refuse guarantee (measured 44-52% under-count).
 */
export function toClaudeTools(tools: LlmToolDef[]): ClaudeTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

const TOKENS_PER_MESSAGE = 3;

/**
 * Raw (pre-inflation) offline token estimate shared by every Claude-protocol
 * adapter. Each caller applies its own inflation constant on top.
 */
export function estimateClaudeTokens(messages: LlmMessage[], tools?: LlmToolDef[]): number {
  let raw = 0;
  for (const m of messages) {
    raw += TOKENS_PER_MESSAGE + encodeO200kBase(m.content).length + encodeO200kBase(m.role).length;
  }
  if (tools && tools.length > 0) {
    raw += encodeO200kBase(JSON.stringify(toClaudeTools(tools))).length;
  }
  return raw;
}

export function toClaudeRequest(req: LlmRequest, defaultMaxTokens: number): ClaudeRequest {
  const system: ClaudeTextBlock[] = [];
  const messages: ClaudeMessage[] = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      system.push({ type: "text", text: m.content });
      continue;
    }
    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }],
      });
      continue;
    }
    if (m.role === "assistant") {
      const content: ClaudeContentBlock[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: parseArgs(tc.argsJson) });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    // user
    messages.push({ role: "user", content: [{ type: "text", text: m.content }] });
  }

  const tools: ClaudeTool[] | undefined = req.tools ? toClaudeTools(req.tools) : undefined;

  return {
    ...(system.length > 0 ? { system } : {}),
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
    max_tokens: req.maxTokens ?? defaultMaxTokens,
  };
}

const EPHEMERAL: CacheControl = { type: "ephemeral" };

/**
 * Two-breakpoint canonical caching. Anthropic's cache order is
 * tools -> system -> messages, so a breakpoint on the last system block
 * caches tools+system (static across the run). A rolling breakpoint on the
 * last message's final block grows the conversation cache each turn.
 * Sub-minimum prefixes (1024/2048 tokens) are silently un-cached by Anthropic.
 */
export function withCacheBreakpoints(req: ClaudeRequest): ClaudeRequest {
  const system = req.system?.map((b, i, arr) => (i === arr.length - 1 ? { ...b, cache_control: EPHEMERAL } : b));

  const messages = req.messages.map((m, mi, marr) => {
    if (mi !== marr.length - 1) return m;
    const content = m.content.map((b, bi, barr) => (bi === barr.length - 1 ? { ...b, cache_control: EPHEMERAL } : b));
    return { ...m, content };
  });

  return { ...req, ...(system ? { system } : {}), messages };
}

interface ClaudeUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}
export type ClaudeStreamEvent =
  | { type: "message_start"; message: { usage: ClaudeUsage } }
  | {
      type: "content_block_start";
      index: number;
      content_block: { type: "text" | "tool_use"; id?: string; name?: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: string }; usage?: ClaudeUsage }
  | { type: "message_stop" };

export async function* mapClaudeStream(
  events: AsyncIterable<ClaudeStreamEvent>,
  priceUsd: (usage: LlmUsage) => number,
): AsyncIterable<LlmStreamEvent> {
  const toolBuffers = new Map<number, { id: string; name: string; argsJson: string }>();
  let start: ClaudeUsage = {};
  let outputTokens = 0;
  let stopReason = "stop";

  for await (const ev of events) {
    switch (ev.type) {
      case "message_start":
        start = ev.message.usage ?? {};
        outputTokens = ev.message.usage?.output_tokens ?? 0;
        break;
      case "content_block_start":
        if (ev.content_block.type === "tool_use") {
          toolBuffers.set(ev.index, { id: ev.content_block.id ?? "", name: ev.content_block.name ?? "", argsJson: "" });
        }
        break;
      case "content_block_delta":
        if (ev.delta.type === "text_delta") {
          yield { type: "text", delta: ev.delta.text };
        } else {
          const buf = toolBuffers.get(ev.index);
          if (buf) buf.argsJson += ev.delta.partial_json;
        }
        break;
      case "content_block_stop": {
        const buf = toolBuffers.get(ev.index);
        if (buf) {
          yield { type: "tool_call", id: buf.id, name: buf.name, argsJson: buf.argsJson };
          toolBuffers.delete(ev.index);
        }
        break;
      }
      case "message_delta":
        if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens;
        break;
      case "message_stop": {
        const cachedInputTokens = start.cache_read_input_tokens ?? 0;
        const cacheWriteTokens = start.cache_creation_input_tokens ?? 0;
        const inputTokens = (start.input_tokens ?? 0) + cachedInputTokens;
        const usage: LlmUsage = {
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheWriteTokens,
          costUsd: 0,
        };
        usage.costUsd = priceUsd(usage);
        yield { type: "done", stopReason, usage };
        break;
      }
    }
  }
}
