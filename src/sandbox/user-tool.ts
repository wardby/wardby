/**
 * One user-tool call, end to end: parse the model's arguments, validate them
 * against the tool's Zod schema (in its own sandbox), run the body, and format
 * the result string fed back to the model. Never throws — every failure is a
 * JSON error result. Worker-safe: it touches no database or provider, only the
 * privileged host it is given, so the native sandbox worker runs it as is.
 */

import type { PrivilegedHost } from "./host-functions.js";
import { runToolCode, toolLimits } from "./run-in-sandbox.js";
import type { SandboxLimits } from "./eval-core.js";
import { validateParams } from "./zod-params.js";

export interface UserToolDefinition {
  code: string;
  paramsZod: string;
  /** The time limit this run gives the tool (effectiveToolTimeoutMs); absent = the default. */
  timeoutMs?: number;
}

export interface UserToolCallOptions {
  limits?: Partial<SandboxLimits>;
  /** Aborts the call when its run is stopped. */
  signal?: AbortSignal;
}

export async function runUserToolCall(
  tool: UserToolDefinition,
  argsJson: string,
  privileged: (signal: AbortSignal) => PrivilegedHost,
  options: UserToolCallOptions = {},
): Promise<string> {
  let parsedArgs: unknown;
  try {
    // Some providers stream no JSON delta at all for a zero-parameter
    // tool call, yielding an empty argsJson rather than "{}".
    parsedArgs = JSON.parse(argsJson || "{}");
  } catch (err) {
    return JSON.stringify({
      error: "invalid_arguments_json",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const validation = await validateParams(tool.paramsZod, parsedArgs);
  if (!validation.ok) {
    return JSON.stringify({ error: "validation_failed", message: validation.errorMessage });
  }

  const result = await runToolCode({
    code: tool.code,
    params: validation.value,
    limits: toolLimits(tool.timeoutMs, options.limits),
    signal: options.signal,
    privileged,
  });
  if (!result.ok) {
    return JSON.stringify({ error: result.errorKind, message: result.errorMessage });
  }
  return JSON.stringify(result.value);
}
