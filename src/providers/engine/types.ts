/**
 * Engine seam — the control flow *inside* a run: turns, tool calls,
 * branching. A future LangGraph adapter is a swap at this seam, not a
 * rewrite of the runner. Distinct from the `Executor` seam (Phase 2),
 * which is *around* a run (how it survives a crash and resumes) — see the
 * Phase 3 design doc's layer-boundaries section.
 *
 * The engine owns the entire turn loop AND the budget lifecycle
 * (pre-flight refuse, cumulative pre-turn gate, mid-stream cutoff,
 * graceful wind-down) — never split with the caller. Every model call
 * must go through `ctx.providers.llm` so the guardrail holds regardless of
 * which engine is driving: an engine that calls a provider SDK directly
 * blinds the pre-flight refuse and mid-stream cutoff, and is not allowed.
 */

import type { ProviderRegistry } from "../index.js";
import type { LlmEffort } from "../llm/types.js";

/** The subset of Agent fields the engine needs — not the Prisma type, to keep this seam Prisma-agnostic. */
export interface EngineAgent {
  systemPrompt: string;
  model: string;
  budgetUsd: number;
  maxTurns: number;
  /** Reasoning effort sent on every model call; absent = provider default. */
  effort?: LlmEffort;
}

export interface LoadedTool {
  name: string;
  description: string;
  /** Derived from the tool's Zod schema via zod-to-json-schema at load time. */
  jsonSchema: Record<string, unknown>;
}

/**
 * Durable step boundary. A checkpointing executor (DbosExecutor) supplies
 * one that records each step's result, so a run resumed after a crash
 * replays completed steps from the record instead of re-executing them
 * (and re-spending). When absent, `fn` runs directly.
 *
 * Contract for engines: `fn`'s return value must be plain JSON data, and
 * `name` must be deterministic for a given position in the run — the
 * replay matches steps by order, so control flow between steps must depend
 * only on earlier step results and on `agent` fields fixed at run start.
 */
export type StepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** The no-checkpoint default: run the step body directly. */
export const runStepInline: StepRunner = (_name, fn) => fn();

export interface EngineRunContext {
  agent: EngineAgent;
  tools: LoadedTool[];
  providers: Pick<ProviderRegistry, "llm">;
  /** Host bridge: validates params (Zod-in-sandbox) then runs the tool body in the WASM sandbox. Never throws — a tool/validation failure is a JSON error result string, fed back to the model as the tool's result. */
  runSandboxTool(name: string, argsJson: string): Promise<string>;
  onText?: (delta: string) => void;
  /** See StepRunner. Optional; the in-process executor leaves it unset. */
  step?: StepRunner;
}

export type EngineStatus = "succeeded" | "budget_exhausted" | "refused" | "failed";

export interface EngineResult {
  status: EngineStatus;
  finalText: string;
  turns: number;
  usage: { tokensIn: number; tokensOut: number; costUsd: number };
  error?: string;
}

export interface Engine {
  run(ctx: EngineRunContext): Promise<EngineResult>;
}
