/**
 * The native multi-turn engine — the default (and, in Phase 3, only)
 * `Engine` implementation. Owns the whole turn loop and the whole budget
 * lifecycle: pre-flight refuse, cumulative pre-turn gate, mid-stream
 * cutoff, graceful wind-down. See providers/engine/types.ts for why this
 * lives behind a seam (a future LangGraph engine swaps in here) and why
 * the budget guardrail must stay above whichever engine is running.
 */

import type { Engine, EngineResult, EngineRunContext, EngineStatus } from "../providers/engine/types.js";
import type { LlmMessage, LlmToolDef, LlmUsage } from "../providers/index.js";
import { applyPreflightSafetyMargin, checkTokenCalibration, estimateInputCost, isOverBudget } from "./budget.js";

interface Usage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

interface TurnResult {
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number };
  text: string;
  toolCalls: { id: string; name: string; argsJson: string }[];
  budgetExceededMidStream: boolean;
  error?: string;
}

function zeroUsage(): Usage {
  return { tokensIn: 0, tokensOut: 0, costUsd: 0 };
}

function addUsage(a: Usage, b: { inputTokens: number; outputTokens: number; costUsd: number }): Usage {
  return { tokensIn: a.tokensIn + b.inputTokens, tokensOut: a.tokensOut + b.outputTokens, costUsd: a.costUsd + b.costUsd };
}

export class NativeEngine implements Engine {
  async run(ctx: EngineRunContext): Promise<EngineResult> {
    const messages: LlmMessage[] = [
      { role: "system", content: ctx.agent.systemPrompt },
      { role: "user", content: "Begin." },
    ];
    const toolDefs: LlmToolDef[] = ctx.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema,
    }));

    let cumulative = zeroUsage();
    let lastText = "";
    let turns = 0;
    let lastCacheRatio = 0;

    while (true) {
      turns += 1;
      if (turns > ctx.agent.maxTurns) {
        // Safety net, not an error: the loop stopped cleanly, not for lack
        // of money — the last turn's text (possibly empty, if it was all
        // tool calls) is the answer.
        return this.finish("succeeded", lastText, turns - 1, cumulative);
      }

      // toolDefs is passed here because this turn's real call will include
      // it (tools stay enabled until wind-down) — the estimate must count
      // whatever the actual request sends, or the turn-1 refuse gate
      // (cumulative is still zero, nothing else to catch an under-count)
      // can admit a run whose real input cost already exceeds budget.
      const { costUsd: inputEstimateCost, tokens: inputTokens } = await estimateInputCost(
        { model: ctx.agent.model, budgetUsd: ctx.agent.budgetUsd },
        messages,
        ctx.providers.llm,
        toolDefs,
        lastCacheRatio,
      );
      const guardedEstimate = applyPreflightSafetyMargin(inputEstimateCost);
      const projected = cumulative.costUsd + guardedEstimate;

      if (isOverBudget(projected, ctx.agent.budgetUsd)) {
        if (cumulative.costUsd === 0) {
          // Turn-1 gate trip, zero spend so far: refuse, no LLM call — the
          // same guarantee Phase 1 made, now living inside the engine.
          return {
            status: "refused",
            finalText: "",
            turns,
            usage: cumulative,
            error:
              `Estimated input cost $${inputEstimateCost.toFixed(6)} (with safety margin: ` +
              `$${guardedEstimate.toFixed(6)}) meets or exceeds budget $${ctx.agent.budgetUsd.toFixed(4)} ` +
              `before any LLM call.`,
          };
        }
        return this.windDown(ctx, messages, cumulative, turns, lastText);
      }

      const turn = await this.runOneTurn(ctx, messages, inputTokens, cumulative.costUsd, toolDefs, lastCacheRatio);

      if (turn.error) {
        return this.finish("failed", lastText, turns, addUsage(cumulative, turn.usage), turn.error);
      }

      cumulative = addUsage(cumulative, turn.usage);
      lastCacheRatio = turn.usage.inputTokens > 0 ? turn.usage.cachedInputTokens / turn.usage.inputTokens : 0;

      if (turn.budgetExceededMidStream) {
        return this.windDown(ctx, messages, cumulative, turns, turn.text || lastText);
      }

      const assistantMessage: LlmMessage = { role: "assistant", content: turn.text };
      if (turn.toolCalls.length > 0) assistantMessage.toolCalls = turn.toolCalls;
      messages.push(assistantMessage);

      if (turn.toolCalls.length > 0) {
        for (const toolCall of turn.toolCalls) {
          const resultJson = await ctx.runSandboxTool(toolCall.name, toolCall.argsJson);
          messages.push({ role: "tool", toolCallId: toolCall.id, name: toolCall.name, content: resultJson });
        }
        continue;
      }

      lastText = turn.text;
      return this.finish("succeeded", lastText, turns, cumulative);
    }
  }

  /**
   * One final turn with tools disabled, checked against *remaining*
   * budget and mid-stream-capped so it cannot overshoot. If remaining
   * budget can't even afford this turn's estimated input, hard-stop
   * without it — either way the terminal status is `budget_exhausted`.
   */
  private async windDown(
    ctx: EngineRunContext,
    messages: LlmMessage[],
    cumulative: Usage,
    turns: number,
    lastText: string,
  ): Promise<EngineResult> {
    const windDownMessages: LlmMessage[] = [
      ...messages,
      { role: "user", content: "You are out of budget; summarize what you have and stop." },
    ];

    // No toolDefs here — the wind-down call itself passes `tools: []`
    // below (disabled), so the real request won't carry tool schemas and
    // the estimate must match what's actually sent.
    const { costUsd: inputEstimateCost, tokens: inputTokens } = await estimateInputCost(
      { model: ctx.agent.model, budgetUsd: ctx.agent.budgetUsd },
      windDownMessages,
      ctx.providers.llm,
    );
    const guardedEstimate = applyPreflightSafetyMargin(inputEstimateCost);

    if (isOverBudget(cumulative.costUsd + guardedEstimate, ctx.agent.budgetUsd)) {
      return this.finish(
        "budget_exhausted",
        lastText,
        turns,
        cumulative,
        "Budget exhausted; remaining budget could not even afford a wind-down summary turn.",
      );
    }

    const turn = await this.runOneTurn(ctx, windDownMessages, inputTokens, cumulative.costUsd, [], 0);
    const finalUsage = addUsage(cumulative, turn.usage);

    if (turn.error) {
      return this.finish("failed", lastText, turns + 1, finalUsage, turn.error);
    }

    return this.finish("budget_exhausted", turn.text || lastText, turns + 1, finalUsage);
  }

  private finish(status: EngineStatus, finalText: string, turns: number, usage: Usage, error?: string): EngineResult {
    return { status, finalText, turns, usage, ...(error ? { error } : {}) };
  }

  /**
   * Streams one model turn, applying the mid-stream cutoff against the
   * *cumulative* running total (this extends Phase 1's single-turn
   * AbortController logic across the whole loop). Per-delta output-token
   * counting mirrors runner.ts's O(delta)-per-event approach — see its
   * comment for why summing per-delta counts beats re-tokenizing the
   * whole accumulated output on every event.
   */
  private async runOneTurn(
    ctx: EngineRunContext,
    messages: LlmMessage[],
    inputTokens: number,
    cumulativeCostSoFar: number,
    tools: LlmToolDef[],
    cacheRatio = 0,
  ): Promise<TurnResult> {
    const assistantFrameTokens = await ctx.providers.llm.countTokens(ctx.agent.model, [
      { role: "assistant", content: "" },
    ]);
    const estimatedCachedInput = Math.round(inputTokens * Math.min(Math.max(cacheRatio, 0), 1));

    const controller = new AbortController();
    let text = "";
    const toolCalls: { id: string; name: string; argsJson: string }[] = [];
    let usage: LlmUsage | undefined;
    let outputTokensSoFar = 0;
    let budgetExceededMidStream = false;

    try {
      for await (const event of ctx.providers.llm.stream(
        { model: ctx.agent.model, messages, tools: tools.length > 0 ? tools : undefined },
        controller.signal,
      )) {
        if (event.type === "text") {
          text += event.delta;
          ctx.onText?.(event.delta);

          const deltaTokens = await ctx.providers.llm.countTokens(ctx.agent.model, [
            { role: "assistant", content: event.delta },
          ]);
          outputTokensSoFar += Math.max(deltaTokens - assistantFrameTokens, 0);
          const projected =
            cumulativeCostSoFar +
            ctx.providers.llm.priceUsd(ctx.agent.model, {
              inputTokens,
              outputTokens: outputTokensSoFar,
              cachedInputTokens: estimatedCachedInput,
            });
          if (isOverBudget(projected, ctx.agent.budgetUsd)) {
            budgetExceededMidStream = true;
            controller.abort();
            break;
          }
        } else if (event.type === "tool_call") {
          // Known gap: a turn that streams only tool-call deltas (no text)
          // never runs the mid-stream budget check above, so it can only
          // be caught once `usage` arrives on `done`. Bounded to one
          // turn's tool-call cost and self-corrects at the next pre-turn
          // gate (cumulative folds in the real `usage` below) — not fixed
          // here since tool-call argument tokens are typically small
          // relative to a text completion, but worth knowing if a tool
          // call ever carries a very large argument payload.
          toolCalls.push({ id: event.id, name: event.name, argsJson: event.argsJson });
        } else if (event.type === "done") {
          usage = event.usage;
        }
      }
    } catch (err) {
      return {
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        text,
        toolCalls,
        budgetExceededMidStream: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (budgetExceededMidStream) {
      const costUsd = ctx.providers.llm.priceUsd(ctx.agent.model, {
        inputTokens,
        outputTokens: outputTokensSoFar,
        cachedInputTokens: estimatedCachedInput,
      });
      return {
        usage: { inputTokens, outputTokens: outputTokensSoFar, cachedInputTokens: estimatedCachedInput, costUsd },
        text,
        toolCalls,
        budgetExceededMidStream: true,
      };
    }

    if (!usage) {
      return {
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        text,
        toolCalls,
        budgetExceededMidStream: false,
        error: "LLM stream ended without a usage summary.",
      };
    }

    const calibration = checkTokenCalibration(inputTokens, usage.inputTokens);
    if (calibration.diverged) {
      const direction =
        calibration.deltaRatio < 0
          ? "UNDERestimated (dangerous — the pre-flight refuse/gate could admit an over-budget run)"
          : "overestimated (safe direction)";
      console.warn(
        `[reevo-run] token calibration drift for model "${ctx.agent.model}": local pre-turn ` +
          `estimate was ${calibration.estimatedTokens} tokens vs. actual ${calibration.actualTokens} ` +
          `(${(calibration.deltaRatio * 100).toFixed(1)}%, ${direction}). Check the tokenizer ` +
          `encoding and per-message overhead constants for this model in src/providers/llm/openai.ts.`,
      );
    }

    return {
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        costUsd: usage.costUsd,
      },
      text,
      toolCalls,
      budgetExceededMidStream: false,
    };
  }
}
