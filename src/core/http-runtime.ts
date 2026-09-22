/**
 * Process-wide HTTP runtime: wardby's `fetch` stack is userland undici's, not
 * Node's built-in one. Imported for its side effect, first, by every runtime
 * entry point.
 *
 * WHY. `@kubernetes/client-node` 2 depends on userland `undici` 8. Merely
 * importing it (which `providers/executor/composition.ts` does unconditionally,
 * for every deployment, including `JOB_LAUNCHER=docker`) runs undici 8's
 * `lib/global.js`, which claims BOTH global-dispatcher symbols:
 * `Symbol.for("undici.globalDispatcher.2")` gets its `Agent`, and the legacy
 * `Symbol.for("undici.globalDispatcher.1")` gets a `Dispatcher1Wrapper` around
 * it. Node's built-in `fetch` (undici 7.x, `process.versions.undici`) reads that
 * legacy symbol and gets the wrapper — so every built-in `fetch` in the process
 * is then dispatched by undici 8.
 *
 * That bridge is silently lossy over HTTP/2. undici 8 negotiates h2 via ALPN by
 * default while Node's built-in client offers http/1.1 only, so the connection
 * is upgraded underneath a fetch implementation that never asked for it, and
 * the wrapper's h2 response path never reaches the built-in handler's header and
 * content-encoding handling: the `Response` comes back with ZERO headers and an
 * undecompressed body. `response.json()` on any gzip response then throws
 * `Unexpected token '\x1f' ... is not valid JSON`. Plain HTTP/1.1 is unaffected,
 * which is why only real APIs break — every one wardby calls speaks h2: the
 * GitHub App client (`/repos/{owner}/{repo}/installation`, which refused every
 * coding run before launch), the Anthropic and OpenAI SDKs, the OIDC/JWKS
 * fetches, and anything else on global `fetch`.
 *
 * FIX. Own the stack instead of straddling it: use undici 8's own `fetch` (and
 * the classes it brand-checks against), which reads the `.2` symbol it also
 * sets, so dispatcher and client are the same implementation. Undoing the
 * poisoning is not an option — undici 8 defines the legacy symbol
 * non-configurable, so restoring Node's dispatcher afterwards throws
 * `TypeError: Cannot redefine property`.
 *
 * This is `undici.install()` minus the globals wardby does not want replaced:
 * `install()` also swaps `WebSocket`/`CloseEvent`/`ErrorEvent`/`MessageEvent`/
 * `EventSource`, and nothing here uses those globals (the Kubernetes exec path
 * goes through `isomorphic-ws` → the `ws` package, the MCP SSE client through
 * the `eventsource` package), so replacing them would be blast radius without
 * benefit. The five installed below are one unit deliberately: `fetch` returns
 * undici's `Response`, so `Headers`/`Response`/`Request`/`FormData` have to be
 * undici's too or `instanceof` and brand checks straddle two implementations.
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
import {
  fetch as undiciFetch,
  FormData as UndiciFormData,
  Headers as UndiciHeaders,
  Request as UndiciRequest,
  Response as UndiciResponse,
} from "undici";

const INSTALLED = Symbol.for("wardby.httpRuntime.installed");

/**
 * Installs undici's fetch stack over the built-in globals. Idempotent: safe to
 * import or call repeatedly (module graphs are per-entry-point under tsx and
 * per-file under Vitest, so it is imported many times in one process).
 */
export function installHttpRuntime(): void {
  const marker = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (marker[INSTALLED] === true) return;
  globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
  globalThis.Headers = UndiciHeaders as unknown as typeof globalThis.Headers;
  globalThis.Response = UndiciResponse as unknown as typeof globalThis.Response;
  globalThis.Request = UndiciRequest as unknown as typeof globalThis.Request;
  globalThis.FormData = UndiciFormData as unknown as typeof globalThis.FormData;
  marker[INSTALLED] = true;
}

installHttpRuntime();
