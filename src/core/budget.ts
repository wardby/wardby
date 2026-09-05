/**
 * Budget guardrail — reevo-run's differentiator. Pure functions only: no
 * network, no DB, so the math is unit-testable in isolation. The runner
 * composes these with a live `LlmProvider` for the pre-flight refuse and the
 * mid-stream cutoff.
 */

import type { LlmMessage, LlmProvider, LlmToolDef } from "../providers/index.js";

export interface BudgetAgent {
  model: string;
  budgetUsd: number;
}

export interface InputEstimate {
  tokens: number;
  costUsd: number;
}

/**
 * Input-only cost estimate: `countTokens` -> `priceUsd` with zero output
 * tokens. `tools` must be passed whenever the turn being estimated will
 * actually send them — a provider bills the serialized tool schemas as
 * input tokens, so omitting them here when the real call includes them
 * under-counts (this was a real bug: a turn-1 refuse with tools attached
 * could admit a run whose real input cost already exceeded budget).
 */
export async function estimateInputCost(
  agent: BudgetAgent,
  messages: LlmMessage[],
  llm: LlmProvider,
  tools?: LlmToolDef[],
): Promise<InputEstimate> {
  const tokens = await llm.countTokens(agent.model, messages, tools);
  const costUsd = llm.priceUsd(agent.model, {
    inputTokens: tokens,
    outputTokens: 0,
  });
  return { tokens, costUsd };
}

/**
 * Shared refuse/cutoff threshold: a projected cost that has reached the
 * budget is treated as over budget, not just exceeded past it — the run
 * must stop at the edge, not one token past it.
 */
export function isOverBudget(costUsd: number, budgetUsd: number): boolean {
  return costUsd >= budgetUsd;
}

/**
 * The pre-flight estimate is a local, un-verified tokenizer count — it must
 * never let an over-budget run start because it happened to undercount.
 * Rather than trust that the estimate is always biased high (measured once
 * against a real call: 40 estimated vs. 38 actual for gpt-5.6-luna — high,
 * but only one data point across one model/message shape), pad the refuse
 * decision by a fixed margin. `checkTokenCalibration` below is how drift
 * beyond this margin gets surfaced, so the margin can be tightened with
 * evidence instead of guesswork.
 */
export const PREFLIGHT_SAFETY_MARGIN_RATIO = 0.1;

export function applyPreflightSafetyMargin(costUsd: number): number {
  return costUsd * (1 + PREFLIGHT_SAFETY_MARGIN_RATIO);
}

export interface TokenCalibration {
  estimatedTokens: number;
  actualTokens: number;
  /** (estimated - actual) / actual. Positive = overestimated (safe). Negative = underestimated (dangerous). */
  deltaRatio: number;
  diverged: boolean;
}

const CALIBRATION_DIVERGENCE_THRESHOLD = 0.1;

/**
 * Compares the local pre-flight token estimate against the provider's
 * authoritative post-call usage. This is calibration, not a runtime gate:
 * the estimate is inherently approximate (fixed per-message overhead
 * constants, possible encoding mismatch), so divergence should be logged
 * for a human to investigate, never used to fail or block a run that
 * already has real, authoritative usage numbers.
 */
export function checkTokenCalibration(
  estimatedTokens: number,
  actualTokens: number,
  thresholdRatio: number = CALIBRATION_DIVERGENCE_THRESHOLD,
): TokenCalibration {
  const deltaRatio = actualTokens === 0 ? 0 : (estimatedTokens - actualTokens) / actualTokens;
  return {
    estimatedTokens,
    actualTokens,
    deltaRatio,
    diverged: Math.abs(deltaRatio) > thresholdRatio,
  };
}
