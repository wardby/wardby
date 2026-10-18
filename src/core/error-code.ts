/**
 * The code a wardby error message leads with (`some_code` or `some_code: detail`), or undefined.
 * Worker-safe: the native sandbox worker image ships this module.
 */
export function errorCodeOf(message: string | null | undefined): string | undefined {
  return message ? /^([a-z][a-z0-9_]*)(:|$)/.exec(message)?.[1] : undefined;
}

/** The longest cause code carried; a longer leading word is not a code. */
const MAX_CAUSE_CODE_LENGTH = 64;

/** The code an unexpected error's message leads with, if it is code-shaped (has an underscore) and short enough. */
export function causeCodeOf(err: unknown): string | undefined {
  const code = errorCodeOf(err instanceof Error ? err.message : typeof err === "string" ? err : undefined);
  // Only the code form leaves a boundary: snake_case with an underscore, so a bare word
  // (which could be a token) never crosses.
  return code && code.includes("_") && code.length <= MAX_CAUSE_CODE_LENGTH ? code : undefined;
}

/**
 * The only codes that may be shown from an arbitrary error's text (to a worker, or to the model in a
 * tool result): wardby's own codes that an unexpected error on those paths can lead with. Anything
 * else, however code-shaped, could be a value from an error's text, so it never crosses.
 * - coding_execution_not_configured, coding_profile_missing: a coding delegation reaching a process
 *   that cannot start coding runs (core/deferred-coding.ts, providers/executor/routing.ts).
 * - message_too_large, message_not_json, message_invalid, unsupported_protocol_version: the native
 *   worker protocol's own ProtocolError codes (native-worker/protocol.ts).
 * - invalid_merge_order: dispatchRun's refusal of a bad mergeOrder (core/dispatch.ts).
 * - coding_worker_image_invalid: a coding worker image that is not pinned by digest
 *   (providers/executor/container.ts).
 * - native_sandbox_unavailable: createRun/the router refusing a sandbox-mode agent with no sandbox executor
 *   (core/runner.ts).
 * - run_tree_exhausted: dispatchRun refusing a run whose tree budget is spent (core/dispatch.ts).
 */
export const GATEWAY_CAUSE_CODES: ReadonlySet<string> = new Set([
  "coding_execution_not_configured",
  "coding_profile_missing",
  "message_too_large",
  "message_not_json",
  "message_invalid",
  "unsupported_protocol_version",
  "invalid_merge_order",
  "coding_worker_image_invalid",
  "native_sandbox_unavailable",
  "run_tree_exhausted",
]);

/** The leading code of an arbitrary error or message, only when it is declared in GATEWAY_CAUSE_CODES. */
export function declaredCodeOf(err: unknown): string | undefined {
  const code = causeCodeOf(err);
  return code && GATEWAY_CAUSE_CODES.has(code) ? code : undefined;
}
