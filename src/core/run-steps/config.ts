import { loadRetentionDays } from "../retention-days.js";

/**
 * Run steps settings, read at start-up by every process that records or serves steps (the server,
 * `wardby scheduler`, the native gateway). An invalid value stops start-up, naming the variable.
 */
export type RunStepsLevel = "off" | "summary" | "detail";

export const RUN_STEPS_LEVELS: readonly RunStepsLevel[] = ["off", "summary", "detail"];
const RANK: Record<RunStepsLevel, number> = { off: 0, summary: 1, detail: 2 };

/** WARDBY_RUN_STEPS: the instance's ceiling. Default summary. */
export function loadRunStepsLevel(env: NodeJS.ProcessEnv = process.env): RunStepsLevel {
  const raw = env.WARDBY_RUN_STEPS?.trim();
  if (!raw) return "summary";
  if (!(RUN_STEPS_LEVELS as readonly string[]).includes(raw))
    throw new Error("WARDBY_RUN_STEPS must be off, summary or detail.");
  return raw as RunStepsLevel;
}

/** A run's level: min(the instance's ceiling, the agent's setting); an unset agent is at summary. */
export function runStepsLevelFor(
  ceiling: RunStepsLevel,
  agentSetting: RunStepsLevel | null | undefined,
): RunStepsLevel {
  const asked = agentSetting ?? "summary";
  return RANK[asked] <= RANK[ceiling] ? asked : ceiling;
}

/**
 * The level a run records: the one fixed at dispatch, never above this process's current ceiling
 * (lowering the ceiling stops detail for in-flight runs too). A run from before the field is at
 * most summary.
 */
export function recordedRunStepsLevel(
  runLevel: RunStepsLevel | null | undefined,
  ceiling: RunStepsLevel,
): RunStepsLevel {
  return runStepsLevelFor(ceiling, runLevel);
}

/** The level to fix on a run being created for `agent` (dispatch, createRun, delegation). */
export function dispatchRunStepsLevel(
  agent: { runSteps: RunStepsLevel | null },
  env: NodeJS.ProcessEnv = process.env,
): RunStepsLevel {
  return runStepsLevelFor(loadRunStepsLevel(env), agent.runSteps);
}

/** update_agent / get_agent: the agent asks for more than the instance records (not a refusal). */
export function runStepsAboveCeilingWarning(
  agentSetting: RunStepsLevel | null | undefined,
  ceiling: RunStepsLevel,
): string | undefined {
  if (!agentSetting || RANK[agentSetting] <= RANK[ceiling]) return undefined;
  return `runSteps is ${agentSetting} but this instance allows up to ${ceiling} (WARDBY_RUN_STEPS), so its runs record ${ceiling}. See the run-steps help article.`;
}

export const DEFAULT_RUN_STEP_RETENTION_DAYS = 30;

/** RUN_STEP_RETENTION_DAYS: days a step is kept after it is written. Applies to steps written after a change. */
export function loadRunStepRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return loadRetentionDays(env, "RUN_STEP_RETENTION_DAYS", DEFAULT_RUN_STEP_RETENTION_DAYS);
}
