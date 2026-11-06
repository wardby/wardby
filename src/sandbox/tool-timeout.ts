/**
 * A sandboxed tool's time limit. A tool may ask for its own `timeoutMs`; the operator's
 * WARDBY_TOOL_MAX_TIMEOUT_MS (config/tool-timeout.ts) caps it. Without one a tool keeps the
 * default wall-time cap (limits.ts). Pure and worker-safe: no configuration is read here.
 */

import { WALL_TIME_LIMIT_MS } from "./limits.js";

/** A tool that sets no `timeoutMs`. */
export const DEFAULT_TOOL_TIMEOUT_MS = WALL_TIME_LIMIT_MS;
/** The shortest `timeoutMs` a tool may ask for. */
export const MIN_TOOL_TIMEOUT_MS = 1_000;
/** WARDBY_TOOL_MAX_TIMEOUT_MS when unset: five minutes. */
export const DEFAULT_TOOL_MAX_TIMEOUT_MS = 300_000;

/**
 * How far past the tool's limit each fetch's own timeout lies. The wall time ends the call (and
 * aborts its fetches) first, so a slow request fails with the wall-time error that names the
 * limit, not a fetch error.
 */
export const FETCH_TIMEOUT_MARGIN_MS = 1_000;

/** The fetch timeout for a tool limit of `wallTimeLimitMs`. */
export function fetchTimeoutFor(wallTimeLimitMs: number): number {
  return wallTimeLimitMs + FETCH_TIMEOUT_MARGIN_MS;
}

/**
 * The limit a run uses for a tool: its own `timeoutMs` (or the default when it has none), never
 * above the current ceiling, so lowering the ceiling also covers tools that already exist.
 */
export function effectiveToolTimeoutMs(timeoutMs: number | null | undefined, ceilingMs: number): number {
  if (timeoutMs === null || timeoutMs === undefined) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.min(timeoutMs, ceilingMs);
}

/** Why `timeoutMs` can't be stored on a tool under `ceilingMs`, or undefined when it can. */
export function toolTimeoutProblem(timeoutMs: unknown, ceilingMs: number): string | undefined {
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs)) {
    return "timeoutMs must be a whole number of milliseconds.";
  }
  if (timeoutMs < MIN_TOOL_TIMEOUT_MS) return `timeoutMs must be at least ${MIN_TOOL_TIMEOUT_MS} ms.`;
  if (timeoutMs > ceilingMs) {
    return `timeoutMs ${timeoutMs} is above this server's ceiling of ${ceilingMs} ms (WARDBY_TOOL_MAX_TIMEOUT_MS).`;
  }
  return undefined;
}

/** The model-facing text for a tool that ran out of time. */
export function toolTimeoutMessage(limitMs: number): string {
  return (
    `Exceeded the ${limitMs}ms wall-time limit. A tool that needs longer can set timeoutMs ` +
    "(create_tool or update_tool), up to the server's WARDBY_TOOL_MAX_TIMEOUT_MS."
  );
}

/** The model-facing text for a tool call cut off at its run's deadline. */
export const TOOL_RUN_DEADLINE_MESSAGE = "Stopped at the run's deadline while this tool call was still running.";
/** The model-facing text for a tool call aborted because its run was stopped. */
export const TOOL_RUN_STOPPED_MESSAGE = "The run was stopped while this tool call was running.";
