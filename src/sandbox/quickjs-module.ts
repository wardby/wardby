/**
 * Lazy singleton for the compiled QuickJS WASM module. Compiling/loading the
 * WASM binary is the expensive one-time cost; a fresh `QuickJSRuntime` +
 * `QuickJSContext` per tool invocation (cheap) is what actually gives each
 * call its isolation — see run-in-sandbox.ts.
 *
 * Deliberately the plain sync variant, not asyncify: host async calls are
 * bridged via the documented deferred-promise + `executePendingJobs` pump
 * pattern (bridge.ts), which works with the smaller, faster sync build and
 * doesn't depend on Asyncify's WASM-stack-suspension behavior.
 */

import { newQuickJSWASMModule, type QuickJSWASMModule } from "quickjs-emscripten";

let modulePromise: Promise<QuickJSWASMModule> | undefined;

export function getQuickJsModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModule();
  }
  return modulePromise;
}
