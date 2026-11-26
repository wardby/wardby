/**
 * Gemini generateContent wire format, shared by the Vertex AI and Google AI Studio
 * adapters (vertex-gemini.ts, google-ai-studio.ts): request mapping, SSE parsing, usage.
 * No SDK. Both backends take the same body; only host, path and auth differ.
 *
 * - Thought signatures: Gemini puts an opaque `thoughtSignature` on a functionCall part
 *   (the first of parallel calls) and rejects a later request without it (HTTP 400).
 *   It travels as the tool call's `providerData` and goes back on the same part.
 * - Thinking never streams as text and bills as output (`thoughtsTokenCount`), so the
 *   engine's mid-stream budget cap cannot see it; it is charged when the call ends.
 * - Usage: AI Studio sends cumulative usage on every chunk, Vertex only on the last;
 *   the latest one seen is used, never a sum. A stream with no usage at all is an error.
 * - temperature/top_p/top_k are ignored by Gemini 4 (and slated to 400): never sent.
 */
import { randomUUID } from "node:crypto";
import type { LlmRequest, LlmStreamEvent, LlmToolDef, LlmUsage } from "./types.js";
import type { CatalogEntry } from "./catalog-types.js";

export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const MAX_ERROR_MESSAGE_CHARS = 300;

type Part =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } };
interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface GeminiBody {
  contents: Content[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: {
    functionDeclarations: { name: string; description: string; parametersJsonSchema: Record<string, unknown> }[];
  }[];
  generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingLevel: string } };
}

export interface GeminiChunk {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  error?: { code?: number; status?: string; message?: string };
}

function argsOf(argsJson: string): Record<string, unknown> {
  if (argsJson.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(argsJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { _raw: argsJson };
  } catch {
    return { _raw: argsJson };
  }
}

/**
 * `parametersJsonSchema` takes full JSON Schema on both backends; the older `parameters` field
 * takes only Google's OpenAPI subset and rejects keywords such as `additionalProperties` (HTTP 400).
 */
function toolDeclarations(tools: LlmToolDef[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.parameters,
      })),
    },
  ];
}

export function toGeminiBody(req: LlmRequest, entry: CatalogEntry): GeminiBody {
  const system: string[] = [];
  const contents: Content[] = [];
  const callNames = new Map<string, string>();
  for (const m of req.messages) {
    if (m.role === "system") {
      system.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      const part: Part = {
        functionResponse: {
          ...(m.toolCallId ? { id: m.toolCallId } : {}),
          name: m.name ?? callNames.get(m.toolCallId ?? "") ?? "tool",
          response: { result: m.content },
        },
      };
      const last = contents.at(-1);
      if (last?.role === "user" && last.parts.every((p) => "functionResponse" in p)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      continue;
    }
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
      continue;
    }
    const parts: Part[] = m.content === "" ? [] : [{ text: m.content }];
    for (const call of m.toolCalls ?? []) {
      callNames.set(call.id, call.name);
      parts.push({
        functionCall: { id: call.id, name: call.name, args: argsOf(call.argsJson) },
        ...(call.providerData !== undefined ? { thoughtSignature: call.providerData } : {}),
      });
    }
    if (parts.length > 0) contents.push({ role: "model", parts });
  }
  const effort = req.effort;
  const sendEffort = effort !== undefined && entry.efforts.includes(effort);
  return {
    contents,
    ...(system.length > 0 ? { systemInstruction: { parts: system.map((text) => ({ text })) } } : {}),
    ...(req.tools && req.tools.length > 0 ? { tools: toolDeclarations(req.tools) } : {}),
    generationConfig: {
      maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(sendEffort ? { thinkingConfig: { thinkingLevel: effort } } : {}),
    },
  };
}

/** Server-sent events → parsed `data:` JSON objects. Tolerates \r\n and splits across reads. */
export async function* parseGeminiSse(body: AsyncIterable<Uint8Array>): AsyncIterable<GeminiChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = function* (block: string) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (data !== "") yield JSON.parse(data) as GeminiChunk;
  };
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let at: number;
    while ((at = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
      yield* flush(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") yield* flush(buffer);
}

export function geminiError(status: number, bodyText: string): Error {
  let googleStatus = "";
  let message = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { status?: string; message?: string } };
    googleStatus = parsed.error?.status ?? "";
    message = parsed.error?.message ?? "";
  } catch {
    // not JSON: keep the (bounded) text
  }
  const bounded = message.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_MESSAGE_CHARS);
  return new Error(`Gemini API error: HTTP ${status}${googleStatus ? ` ${googleStatus}` : ""}: ${bounded}`);
}

export async function* mapGeminiStream(
  chunks: AsyncIterable<GeminiChunk>,
  price: (usage: Omit<LlmUsage, "costUsd">) => number,
): AsyncIterable<LlmStreamEvent> {
  let usage: GeminiChunk["usageMetadata"];
  let finish: string | undefined;
  let sawToolCall = false;
  for await (const chunk of chunks) {
    if (chunk.error) throw geminiError(chunk.error.code ?? 500, JSON.stringify({ error: chunk.error }));
    if (chunk.usageMetadata?.promptTokenCount !== undefined) usage = chunk.usageMetadata;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finish = candidate.finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      if ("functionCall" in part) {
        sawToolCall = true;
        yield {
          type: "tool_call",
          id: part.functionCall.id ?? `gemini_call_${randomUUID()}`,
          name: part.functionCall.name,
          argsJson: JSON.stringify(part.functionCall.args ?? {}),
          ...(part.thoughtSignature !== undefined ? { providerData: part.thoughtSignature } : {}),
        };
      } else if ("text" in part && !part.thought && part.text !== "") {
        yield { type: "text", delta: part.text };
      }
    }
  }
  // A stream that stops before its usage summary (cut connection, proxy close) is a failure, as
  // for the other providers: a $0 "done" would let unbilled work pass as a success.
  if (usage === undefined) throw new Error("Gemini stream ended without a usage summary");
  const tokens = {
    inputTokens: (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0),
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cachedInputTokens: usage.cachedContentTokenCount ?? 0,
  };
  const stopReason = sawToolCall ? "tool_calls" : finish === "MAX_TOKENS" ? "length" : "stop";
  yield { type: "done", stopReason, usage: { ...tokens, costUsd: price(tokens) } };
}
