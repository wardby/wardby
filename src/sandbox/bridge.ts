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

export function registerJsonAsyncFunction(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  name: string,
  impl: (argsJson: string) => Promise<unknown>,
): void {
  const fnHandle = context.newFunction(name, (argHandle) => {
    const argsJson = typeof argHandle === "undefined" ? "null" : context.dump(argHandle);
    const deferred = context.newPromise();

    impl(argsJson).then(
      (value) => {
        if (!deferred.alive) return;
        const resultHandle = context.newString(JSON.stringify(value ?? null));
        deferred.resolve(resultHandle);
        resultHandle.dispose();
      },
      (err: unknown) => {
        if (!deferred.alive) return;
        const message = err instanceof Error ? err.message : String(err);
        const errorHandle = context.newError(message);
        deferred.reject(errorHandle);
        errorHandle.dispose();
      },
    );

    deferred.settled
      .then(() => {
        runtime.executePendingJobs();
      })
      .finally(() => {
        deferred.dispose();
      });

    return deferred.handle;
  });
  context.setProp(context.global, name, fnHandle);
  fnHandle.dispose();
}
