/**
 * WARDBY_TOOL_MAX_TIMEOUT_MS: the longest time limit a sandboxed tool may ask for with its own
 * `timeoutMs`. Default 300000 (five minutes); at least the default tool limit (10000), so a tool
 * that sets no `timeoutMs` always keeps its 10 seconds.
 */
import { DEFAULT_TOOL_MAX_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS } from "../sandbox/tool-timeout.js";

/** Above this a setTimeout no longer waits (it fires at once). */
const MAX_TIMER_MS = 2_147_483_647;

export function loadToolMaxTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WARDBY_TOOL_MAX_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_TOOL_MAX_TIMEOUT_MS;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < DEFAULT_TOOL_TIMEOUT_MS || value > MAX_TIMER_MS) {
    throw new Error(
      `WARDBY_TOOL_MAX_TIMEOUT_MS must be a whole number of milliseconds from ${DEFAULT_TOOL_TIMEOUT_MS} to ${MAX_TIMER_MS}.`,
    );
  }
  return value;
}
