/**
 * The reusable core: create a fresh runtime + context with resource limits,
 * eval a script that resolves to a JSON string, marshal the result,
 * dispose. Shared by `run-in-sandbox.ts` (installs the full host API for a
 * tool invocation) and `zod-params.ts` (installs nothing — schema
 * compilation/validation is pure computation, no host I/O at all).
 */

import type { QuickJSContext, QuickJSRuntime, QuickJSHandle } from "quickjs-emscripten";
import { getQuickJsModule } from "./quickjs-module.js";
import { MAX_INTERRUPT_CHECKS, MAX_STACK_SIZE_BYTES, MEMORY_LIMIT_BYTES, WALL_TIME_LIMIT_MS } from "./limits.js";
import { BRIDGE_RESULT_BYTES } from "./limits.js";

export type SandboxErrorKind = "thrown" | "timeout" | "memory" | "cpu" | "non_serializable";

export type SandboxResult =
  | { ok: true; value: unknown }
  | { ok: false; errorKind: SandboxErrorKind; errorMessage: string };

export interface SandboxLimits {
  memoryLimitBytes: number;
  maxInterruptChecks: number;
  wallTimeLimitMs: number;
  maxStackSizeBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryLimitBytes: MEMORY_LIMIT_BYTES,
  maxInterruptChecks: MAX_INTERRUPT_CHECKS,
  wallTimeLimitMs: WALL_TIME_LIMIT_MS,
  maxStackSizeBytes: MAX_STACK_SIZE_BYTES,
};

/**
 * The script must evaluate to a JSON-string-yielding value (a Promise of a
 * string, per the calling convention both `run-in-sandbox.ts` and
 * `zod-params.ts` use: wrap the real payload in a final `JSON.stringify`
 * inside the sandbox so a serialization failure is itself a catchable
 * sandbox exception, not a host-side surprise).
 */
export const NON_SERIALIZABLE_MARKER = "__reevo_non_serializable__:";

function boundedError(context: QuickJSContext, handle: QuickJSHandle) {
  const result: { name?: string; message?: string } = {};
  for (const key of ["name", "message"] as const) {
    const value = context.getProp(handle, key);
    if (context.typeof(value) === "string") {
      const size = context.getProp(value, "length");
      const length = context.getNumber(size); size.dispose();
      result[key] = length <= 4096 ? context.getString(value) : "Sandbox error text exceeded limit.";
    }
    value.dispose();
  }
  return result;
}

export function classifyEvalError(dumped: { name?: string; message?: string }): SandboxResult {
  if (dumped.name === "InternalError" && dumped.message === "interrupted") {
    return { ok: false, errorKind: "cpu", errorMessage: "Exceeded the CPU/instruction budget." };
  }
  if (dumped.name === "InternalError" && dumped.message === "out of memory") {
    return { ok: false, errorKind: "memory", errorMessage: "Exceeded the sandbox memory limit." };
  }
  if (dumped.message?.startsWith(NON_SERIALIZABLE_MARKER)) {
    return {
      ok: false,
      errorKind: "non_serializable",
      errorMessage: `Returned a value that could not be JSON-serialized: ${dumped.message.slice(NON_SERIALIZABLE_MARKER.length)}`,
    };
  }
  return {
    ok: false,
    errorKind: "thrown",
    errorMessage: dumped.message ? `${dumped.name ?? "Error"}: ${dumped.message}` : JSON.stringify(dumped),
  };
}

export async function evalToJson(
  code: string,
  limitsOverride: Partial<SandboxLimits> | undefined,
  installExtras: (context: QuickJSContext, runtime: QuickJSRuntime, signal: AbortSignal) => void,
): Promise<SandboxResult> {
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...limitsOverride };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + limits.wallTimeLimitMs;

  const qjsModule = await getQuickJsModule();
  const runtime = qjsModule.newRuntime();
  runtime.setMemoryLimit(limits.memoryLimitBytes);
  runtime.setMaxStackSize(limits.maxStackSizeBytes);

  let steps = 0;
  runtime.setInterruptHandler(() => {
    steps += 1;
    return steps > limits.maxInterruptChecks || Date.now() >= deadline;
  });

  const context = runtime.newContext();
  let disposed = false;
  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    // Best-effort: if the wall-time race below abandons a still-running
    // evaluation, teardown may not be pristine. Never let it crash the host.
    try {
      context.dispose();
    } catch {
      /* best-effort */
    }
    try {
      runtime.dispose();
    } catch {
      /* best-effort */
    }
  };

  try {
    installExtras(context, runtime, controller.signal);

    const runPromise: Promise<SandboxResult> = (async () => {
      const evalResult = context.evalCode(code);
      if (evalResult.error) {
        const dumped = boundedError(context, evalResult.error);
        evalResult.error.dispose();
        return classifyEvalError(dumped);
      }

      const settledPromise = context.resolvePromise(evalResult.value);
      evalResult.value.dispose();
      runtime.executePendingJobs();
      const settled = await settledPromise;

      if (settled.error) {
        const dumped = boundedError(context, settled.error);
        settled.error.dispose();
        return classifyEvalError(dumped);
      }

      if (context.typeof(settled.value) !== "string") { settled.value.dispose(); throw new Error("bridge_result_invalid"); }
      const lengthHandle = context.getProp(settled.value, "length");
      const length = context.getNumber(lengthHandle); lengthHandle.dispose();
      if (length > BRIDGE_RESULT_BYTES) { settled.value.dispose(); throw new Error("bridge_result_limit"); }
      const raw = context.getString(settled.value);
      settled.value.dispose();
      if (Buffer.byteLength(raw) > BRIDGE_RESULT_BYTES) throw new Error("bridge_result_limit");
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch {
        return {
          ok: false,
          errorKind: "non_serializable",
          errorMessage: "Returned a value that could not be JSON-serialized.",
        };
      }
    })();

    const timeoutPromise = new Promise<SandboxResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            errorKind: "timeout",
            errorMessage: `Exceeded the ${limits.wallTimeLimitMs}ms wall-time limit.`,
          }),
        limits.wallTimeLimitMs,
      );
    });

    return await Promise.race([runPromise, timeoutPromise]);
  } catch (err) {
    return {
      ok: false,
      errorKind: "thrown",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    disposeAll();
  }
}
