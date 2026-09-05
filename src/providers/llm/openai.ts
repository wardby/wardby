/**
 * OpenAI adapter for the `LlmProvider` seam — Phase 1's only concrete LLM
 * adapter. The `openai` npm package is used only inside this file; core
 * never imports it.
 */

import OpenAI from "openai";
import { encode as encodeCl100kBase } from "gpt-tokenizer/encoding/cl100k_base";
import { encode as encodeO200kBase } from "gpt-tokenizer/encoding/o200k_base";
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  LlmToolDef,
  LlmUsage,
} from "./types.js";
import { getModelPricing, priceUsd as priceUsdFromTable } from "./pricing.js";

// Per-message token overhead from OpenAI's public chat-format guidance
// (role framing + a name field costs a few tokens beyond the raw content).
// This is a pre-flight *estimate* for the budget guardrail, not an exact
// match to server-side billing — the real count comes back in `usage` on
// the `done` event.
const TOKENS_PER_MESSAGE = 3;
const TOKENS_PER_NAME = 1;
const TOKENS_PRIMING_REPLY = 3;

// gpt-tokenizer's package default is cl100k_base, but every gpt-4o-and-later
// model (all of Phase 1's roster) actually uses o200k_base — using the
// wrong table skews the pre-flight token count, which is the budget
// guardrail's input. The encoding lives on the pricing table (pricing.ts)
// so a model can't be run without also declaring which tokenizer counts it.
function encodeForModel(model: string, text: string): number[] {
  const { encoding } = getModelPricing(model);
  return encoding === "o200k_base" ? encodeO200kBase(text) : encodeCl100kBase(text);
}

/** Same shape sent to the API in `stream()` — kept as one function so the estimate can never drift from what's actually serialized. */
function toOpenAiTools(tools: LlmToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// Fixed: this used to count message tokens only. When a request carries
// `tools`, OpenAI also tokenizes the serialized tool JSON schemas into the
// prompt — measured live at a 44-52% under-count for a small tool roster,
// which is what let a turn-1 pre-flight refuse (budget.ts, cumulative
// spend still zero) admit a run whose real input cost already exceeded
// budget. Counting `JSON.stringify` of the same payload `stream()` sends
// is still an *approximation* (not OpenAI's undocumented exact tool-schema
// tokenization), not a byte-for-byte match — calibration logging
// (budget.ts's checkTokenCalibration) is what surfaces any remaining drift.
export function estimateTokens(model: string, messages: LlmMessage[], tools?: LlmToolDef[]): number {
  let total = TOKENS_PRIMING_REPLY;
  for (const message of messages) {
    total += TOKENS_PER_MESSAGE;
    total += encodeForModel(model, message.content).length;
    total += encodeForModel(model, message.role).length;
    if (message.name) {
      total += encodeForModel(model, message.name).length + TOKENS_PER_NAME;
    }
  }
  if (tools && tools.length > 0) {
    total += encodeForModel(model, JSON.stringify(toOpenAiTools(tools))).length;
  }
  return total;
}

export class OpenAiLlmProvider implements LlmProvider {
  private readonly client: OpenAI;

  /** `client` is an injection point for tests — a real adapter never passes it. */
  constructor(apiKey: string = process.env.OPENAI_API_KEY ?? "", client?: OpenAI) {
    if (client) {
      this.client = client;
      return;
    }
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set — required by the OpenAI LlmProvider adapter.",
      );
    }
    this.client = new OpenAI({ apiKey });
  }

  async *stream(
    req: LlmRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: req.model,
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.name ? { name: m.name } : {}),
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function" as const,
                  function: { name: tc.name, arguments: tc.argsJson },
                })),
              }
            : {}),
        })) as OpenAI.Chat.ChatCompletionMessageParam[],
        tools: req.tools ? toOpenAiTools(req.tools) : undefined,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stop: req.stopSequences,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );

    let stopReason = "stop";
    // OpenAI streams tool-call arguments fragmented across chunks, keyed by
    // index — buffer per index until the turn's finish_reason confirms the
    // call is complete, then emit one `tool_call` event per call.
    const toolCallBuffers = new Map<number, { id: string; name: string; argsJson: string }>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta?.content) {
        yield { type: "text", delta: choice.delta.content };
      }
      if (choice?.delta?.tool_calls) {
        for (const fragment of choice.delta.tool_calls) {
          const buffered = toolCallBuffers.get(fragment.index) ?? { id: "", name: "", argsJson: "" };
          if (fragment.id) buffered.id = fragment.id;
          if (fragment.function?.name) buffered.name += fragment.function.name;
          if (fragment.function?.arguments) buffered.argsJson += fragment.function.arguments;
          toolCallBuffers.set(fragment.index, buffered);
        }
      }
      if (choice?.finish_reason) {
        stopReason = choice.finish_reason;
        if (stopReason === "tool_calls") {
          for (const toolCall of toolCallBuffers.values()) {
            yield { type: "tool_call", id: toolCall.id, name: toolCall.name, argsJson: toolCall.argsJson };
          }
          toolCallBuffers.clear();
        }
      }
      if (chunk.usage) {
        // OpenAI's prompt caching is automatic and read-only — no billed
        // "cache write" step, so cacheWriteTokens stays unset here. Other
        // future adapters (e.g. Bedrock/Claude) may report and bill one.
        const cachedInputTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        const usage: LlmUsage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cachedInputTokens,
          costUsd: this.priceUsd(req.model, {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cachedInputTokens,
          }),
        };
        yield { type: "done", stopReason, usage };
      }
    }
  }

  async countTokens(model: string, messages: LlmMessage[], tools?: LlmToolDef[]): Promise<number> {
    return estimateTokens(model, messages, tools);
  }

  priceUsd(
    model: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
    },
  ): number {
    return priceUsdFromTable(model, usage);
  }
}
