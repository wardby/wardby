/**
 * Client-agnostic Claude Messages protocol. Pure functions, no SDK import,
 * so a future Bedrock-Claude adapter reuses them unchanged — Bedrock and the
 * direct API differ only in client/auth, model IDs, and pricing.
 */
import type { LlmMessage, LlmRequest, LlmToolDef } from "./types.js";

export interface CacheControl { type: "ephemeral"; }
export interface ClaudeTextBlock { type: "text"; text: string; cache_control?: CacheControl; }
export interface ClaudeToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: CacheControl; }
export interface ClaudeToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; cache_control?: CacheControl; }
export type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock;
export interface ClaudeMessage { role: "user" | "assistant"; content: ClaudeContentBlock[]; }
export interface ClaudeTool { name: string; description: string; input_schema: Record<string, unknown>; cache_control?: CacheControl; }
export interface ClaudeRequest {
  system?: ClaudeTextBlock[];
  messages: ClaudeMessage[];
  tools?: ClaudeTool[];
  max_tokens: number;
}

function parseArgs(argsJson: string): unknown {
  try { return JSON.parse(argsJson || "{}"); } catch { return {}; }
}

export function toClaudeRequest(req: LlmRequest, defaultMaxTokens: number): ClaudeRequest {
  const system: ClaudeTextBlock[] = [];
  const messages: ClaudeMessage[] = [];

  for (const m of req.messages as LlmMessage[]) {
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

  const tools: ClaudeTool[] | undefined = req.tools?.map((t: LlmToolDef) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }));

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
  const system = req.system?.map((b, i, arr) =>
    i === arr.length - 1 ? { ...b, cache_control: EPHEMERAL } : b,
  );

  const messages = req.messages.map((m, mi, marr) => {
    if (mi !== marr.length - 1) return m;
    const content = m.content.map((b, bi, barr) =>
      bi === barr.length - 1 ? { ...b, cache_control: EPHEMERAL } : b,
    );
    return { ...m, content };
  });

  return { ...req, ...(system ? { system } : {}), messages };
}
