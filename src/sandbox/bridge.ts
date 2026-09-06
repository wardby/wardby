/**
 * The one generic mechanism for exposing a host-side async capability to
 * sandboxed code. Every host function (fetch, datastore, parsers, sleep,
 * console) is registered through this — centralizing the QuickJS handle
 * lifecycle (a real leak/crash risk if scattered across many call sites; a
 * spike confirmed both proper disposal and rejection propagation with
 * this exact shape) in one place instead of repeating it per capability.
 *
 * Values cross the boundary JSON-serialized: the registered function takes
 * one JSON-string argument and the sandbox-side prelude (prelude.ts)
 * JSON-parses the JSON-string result. A thrown/rejected `impl` becomes a
 * real catchable exception inside the sandbox (QuickJS promise rejection).
 */

import type { QuickJSContext, QuickJSRuntime } from "quickjs-emscripten";
import { boundedJson } from "./bounded-json.js";
import { BRIDGE_INPUT_BYTES, BRIDGE_RESULT_BYTES, MAX_HOST_CALLS, MAX_PENDING_HOST_CALLS } from "./limits.js";

const budgets = new WeakMap<QuickJSRuntime, { calls: number; pending: number }>();

export function registerJsonAsyncFunction(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  name: string,
  impl: (argsJson: string) => Promise<unknown>,
  signal?: AbortSignal,
): void {
  const fnHandle = context.newFunction(name, (argHandle) => {
    const budget = budgets.get(runtime) ?? { calls: 0, pending: 0 };
    budgets.set(runtime, budget);
    if (signal?.aborted || ++budget.calls > MAX_HOST_CALLS || budget.pending >= MAX_PENDING_HOST_CALLS) return { error: context.newError("bridge_call_limit") };
    if (!argHandle || context.typeof(argHandle) !== "string") return { error: context.newError("bridge_input_invalid") };
    const lengthHandle = context.getProp(argHandle, "length");
    const length = context.getNumber(lengthHandle); lengthHandle.dispose();
    if (length > BRIDGE_INPUT_BYTES) return { error: context.newError("bridge_input_limit") };
    const argsJson = context.getString(argHandle);
    if (Buffer.byteLength(argsJson) > BRIDGE_INPUT_BYTES) return { error: context.newError("bridge_input_limit") };
    const deferred = context.newPromise();
    budget.pending++;
    const abort = () => { if (deferred.alive) deferred.dispose(); };
    signal?.addEventListener("abort", abort, { once: true });

    Promise.resolve().then(() => { signal?.throwIfAborted(); return impl(argsJson); }).then(
      (value) => {
        if (!deferred.alive) return;
        const resultHandle = context.newString(boundedJson(value, BRIDGE_RESULT_BYTES));
        deferred.resolve(resultHandle);
        resultHandle.dispose();
      },
    ).catch((err: unknown) => {
        if (!deferred.alive) return;
        const message = err instanceof Error ? err.message.slice(0, 1024) : "Host function failed.";
        const errorHandle = context.newError(message);
        deferred.reject(errorHandle);
        errorHandle.dispose();
      }).finally(() => { budget.pending--; signal?.removeEventListener("abort", abort); });

    deferred.settled
      .then(() => {
        if (runtime.alive && !signal?.aborted) runtime.executePendingJobs();
      })
      .finally(() => {
        if (deferred.alive) deferred.dispose();
      }).catch(() => {});

    return deferred.handle;
  });
  context.setProp(context.global, name, fnHandle);
  fnHandle.dispose();
}
