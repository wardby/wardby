/**
 * Per-run settings a launcher hands a coding worker in its environment (no CodingTaskInput field, so
 * no protocol change; gemini-coding-worker phase 3 Decision 11). Imports nothing: every worker image
 * and every launcher reads the same names from here.
 */
export const SUB_AGENTS_ENV = "WARDBY_SUB_AGENTS";
export const WEB_TOOLS_ENV = "WARDBY_WEB_TOOLS";
export const COMMAND_TIMEOUT_ENV = "WARDBY_COMMAND_TIMEOUT_MS";
/** A run setting that is not a valid value (coding-worker/errors.ts SAFE_WORKER_ERROR_CODES). */
export const RUN_SETTINGS_INVALID = "worker_run_settings_invalid";

/** WARDBY_SUB_AGENTS: "true" | "false"; `unset` when absent (an older launcher). Anything else throws. */
export function readSubAgentsSetting(env: NodeJS.ProcessEnv, unset: boolean): boolean {
  const value = env[SUB_AGENTS_ENV];
  if (value === undefined) return unset;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(RUN_SETTINGS_INVALID);
}
