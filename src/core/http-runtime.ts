/**
 * Process-wide HTTP runtime. One call, at bootstrap: it hands Node's built-in
 * `fetch` a global dispatcher it can actually drive. Imported for its side
 * effect, first, by every runtime entry point.
 *
 * WHY. `@kubernetes/client-node` 2 depends on userland `undici` 8. Merely
 * importing it (which `providers/executor/composition.ts` does unconditionally,
 * for every deployment, including `JOB_LAUNCHER=docker`) runs undici 8's
 * `lib/global.js`, which claims BOTH global-dispatcher symbols:
 * `Symbol.for("undici.globalDispatcher.2")` gets its `Agent`, and the legacy
 * `Symbol.for("undici.globalDispatcher.1")` gets a `Dispatcher1Wrapper` around
 * it. Node's built-in `fetch` (undici 7.x, `process.versions.undici`) reads that
 * legacy symbol, so from then on every built-in `fetch` in the process is
 * dispatched by undici 8 through that compatibility wrapper.
 *
 * The wrapper is lossless over HTTP/1.1 and broken over HTTP/2, for one exact
 * reason: `undici/lib/core/request.js:339` sets `controller.rawHeaders` to the
 * flat raw header ARRAY on the h1 path but to the http2 headers OBJECT on the
 * h2 path (`lib/dispatcher/client-h2.js:1449`), and
 * `lib/dispatcher/dispatcher1-wrapper.js:25-31` forwards that value straight
 * into the v1 `onHeaders(statusCode, rawHeaders, …)` contract. The built-in
 * handler walks it by index; an object has no `length`; so it observes ZERO
 * headers. Not just `content-encoding` (hence gzip bodies reaching
 * `response.json()` as `Unexpected token '\x1f'`) — also `location`, so
 * redirect following silently stops, plus `set-cookie`, `retry-after` and every
 * rate-limit header. undici 8 offers h2 in ALPN by default and the built-in
 * client never did, so the connection is upgraded underneath a fetch
 * implementation that never asked for it. That is why only real APIs broke: the
 * GitHub App client (refusing every coding run before launch), the
 * OpenAI/Anthropic/Bedrock SDKs, and remote-JWKS verification in delegating auth
 * mode. Plain h1 — every local test server — is unaffected.
 *
 * FIX. Keep the built-in `fetch` and give it a dispatcher that stays on the
 * protocol it was written for: undici 8's own `Agent` with `allowH2: false`.
 * The incompatibility is h2-only, and none of these calls ever negotiated h2
 * before this branch, so disabling it costs nothing and restores the exact wire
 * protocol the control plane had.
 *
 * WHY NOT replace the globals. Installing undici's `fetch`/`Headers`/`Response`/
 * `Request`/`FormData` process-wide also works, but it swaps the classes under
 * the MCP SDK, the OpenAI/Anthropic/Bedrock SDKs (all of which brand-check
 * `Headers`/`Response`), `FormData`/`Blob` uploads, `AbortSignal` semantics and
 * every cross-realm `instanceof` — real risk, for no gain over one dispatcher
 * option. It would also move all control-plane egress to h2.
 *
 * ORDERING. undici's `lib/global.js` installs its own default `Agent` only when
 * `getGlobalDispatcher() === undefined`, so this call has to land FIRST: after
 * it, the Kubernetes client's later import finds a dispatcher already set and
 * leaves it alone. (`http-runtime.test.ts` asserts exactly that — the dispatcher
 * object is identical before and after importing `@kubernetes/client-node`.)
 * Note this module's own `import { Agent } from "undici"` is what first loads
 * undici 8, so undici sets its h2-enabled default Agent a moment before
 * `setGlobalDispatcher` replaces it; nothing issues a request in between.
 *
 * KNOWN LIMITATION (ledgered, no runtime guard): landing first only settles the
 * module-load race. A dependency that calls `setGlobalDispatcher` ACTIVELY,
 * later in the process, would replace this Agent with an h2-enabled one and
 * silently restore the corruption — the price of fixing this with a dispatcher
 * instead of owning the fetch stack. Nothing in the runtime image does that
 * today: the only other `setGlobalDispatcher` calls in the tree are undici
 * copies bundled inside `@prisma/client/runtime/binary.*` (guarded by the same
 * `=== undefined` check, and the binary engine is not the default) and
 * `node-fetch-native` under the `prisma` CLI, which `deploy/Dockerfile:25`
 * asserts is absent from the runtime image.
 *
 * Restoring Node's OWN dispatcher instead is not possible, though not for the
 * reason one might guess: undici defines the legacy symbol `configurable: false`
 * but `writable: true`, so a plain assignment would be allowed and only
 * `Object.defineProperty` (what `setGlobalDispatcher` uses) throws
 * `TypeError: Cannot redefine property`. The real blocker is that Node's
 * internal dispatcher instance is not reachable from userland once it has been
 * overwritten.
 *
 * WHERE. Imported from `env.ts` rather than from each entry point: `env.ts` is
 * already the documented single runtime load point, is already the first import
 * of `cli.ts` and `coding-proxy/main.ts`, and carries the same "runs before
 * anything else does anything" contract (nothing may read `process.env` before
 * it; nothing may issue a request before this). One line there covers every
 * present and future entry point that loads configuration — which is all of
 * them in this package. The coding workers (`claude-coding-worker/main.ts`,
 * `coding-worker/main.ts`) are deliberately NOT covered: they ship in their own
 * images with their own dependency trees (`src/claude-coding-worker/
 * package.json`), never load the Kubernetes client, and have no `undici` to
 * import.
 */
import { Agent, setGlobalDispatcher } from "undici";

const INSTALLED = Symbol.for("wardby.httpRuntime.installed");

/**
 * Pins the process's global HTTP dispatcher to an h1-only undici 8 Agent.
 * Idempotent: safe to import or call repeatedly (module graphs are per-entry-
 * point under tsx and per-file under Vitest, so it is imported many times in
 * one process), and it never replaces a dispatcher it already installed.
 */
export function installHttpRuntime(): void {
  const marker = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (marker[INSTALLED] === true) return;
  setGlobalDispatcher(new Agent({ allowH2: false }));
  marker[INSTALLED] = true;
}

installHttpRuntime();
