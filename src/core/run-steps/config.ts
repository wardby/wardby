import { loadRetentionDays } from "../retention-days.js";

/**
 * Run steps settings, read at start-up by every process that records or serves steps (the server,
 * `wardby scheduler`, the native gateway). An invalid value stops start-up, naming the variable.
 */
export type RunStepsLevel = "off" | "summary" | "detail";

const LEVELS: readonly string[] = ["off", "summary", "detail"];

/** WARDBY_RUN_STEPS: the instance's ceiling. Default summary. */
export function loadRunStepsLevel(env: NodeJS.ProcessEnv = process.env): RunStepsLevel {
  const raw = env.WARDBY_RUN_STEPS?.trim();
  if (!raw) return "summary";
  if (!LEVELS.includes(raw)) throw new Error("WARDBY_RUN_STEPS must be off, summary or detail.");
  return raw as RunStepsLevel;
}

/**
 * What this release records under a ceiling. `detail` is accepted so an operator can set it now,
 * but steps are recorded (and reported) at `summary` until the detail level ships.
 */
export function effectiveRunStepsLevel(level: RunStepsLevel): "off" | "summary" {
  return level === "off" ? "off" : "summary";
}

export const DEFAULT_RUN_STEP_RETENTION_DAYS = 30;

/** RUN_STEP_RETENTION_DAYS: days a step is kept after it is written. Applies to steps written after a change. */
export function loadRunStepRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return loadRetentionDays(env, "RUN_STEP_RETENTION_DAYS", DEFAULT_RUN_STEP_RETENTION_DAYS);
}
