/**
 * The native worker on Substrate (WARDBY_NATIVE_SUBSTRATE=1): the worker starts before any run
 * exists, with no input on stdin or in a file.
 *
 * Substrate boots the native template once as a golden actor and snapshots it; every run actor
 * resumes from that snapshot. So the golden actor must hold nothing of any run: until its actor's
 * name appears (`<dir>/name` = `wr-<20 hex>-native`), this module only answers /readyz and makes no
 * request at all. Once named, it fetches the run's input from the gateway's input route and runs it
 * over the HTTP transport.
 *
 * The worker never holds the run's capability. It sends the public placeholder
 * (NATIVE_PLACEHOLDER_CAPABILITY) as its bearer, and the egress gateway replaces it with the real
 * capability on the wire. The input is never logged; every failure here is a fixed code.
 */

import type { Server } from "node:http";
import { startReadyServer, stderrLogger, waitForRunActor, type Logger } from "../substrate-bridge/common.js";
import { CANARY_SUFFIX, DEFAULT_METADATA_DIR, DEFAULT_READY_PORT } from "../substrate-bridge/constants.js";
import { createHttpTransport, fetchSandboxInput } from "./http-transport.js";
import {
  GatewayError,
  GatewayInputResponseSchema,
  NATIVE_CANARY_DENY_PORT,
  NATIVE_DENY_PORT_ENV,
  NATIVE_GATEWAY_INPUT_PATH,
  NATIVE_PLACEHOLDER_CAPABILITY,
  nativeGatewayRouteUrl,
  WorkerInputSchema,
  type GatewayErrorCode,
  type WorkerInput,
} from "./protocol.js";
import { rememberSecretValue } from "./stderr-redaction.js";
import { runNativeCanary } from "./substrate-canary.js";
import { runNativeWorker, type GatewayTransport } from "./worker.js";

export { NATIVE_SUBSTRATE_ENV } from "./protocol.js";

export interface SubstrateModeOptions {
  env: NodeJS.ProcessEnv;
  /** Default DEFAULT_METADATA_DIR (/run/ate/actor). */
  metadataDir?: string;
  /** Default DEFAULT_READY_PORT (8080); 0 in tests. */
  readyPort?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Default stderrLogger. */
  log?: Logger;
  pollMs?: number;
  /** Tests: replaces runNativeWorker. */
  run?: (input: WorkerInput, transport: GatewayTransport) => Promise<void>;
  /** Tests: replaces the canary. Default: runNativeCanary with this actor's name (and `fetch`, `sleep`, `connect`). */
  canary?: (gatewayUrl: string) => Promise<void>;
  /** Tests: replaces the default canary's egress probe. */
  connect?: (host: string, port: number) => Promise<boolean>;
}

/** The gateway error codes a worker knows; any other code from an answer is reported as `internal`. */
const KNOWN_CODES: ReadonlySet<string> = new Set<GatewayErrorCode>([
  "run_not_drivable",
  "duplicate_call",
  "not_allowed",
  "invalid_request",
  "bridge_error",
  "budget_exhausted",
  "not_ready",
  "internal",
  "unauthorized",
]);

function requireGatewayUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.NATIVE_GATEWAY_URL;
  try {
    if (raw && new URL(raw).protocol === "http:") return raw;
  } catch {
    // Not a URL: the fixed code below.
  }
  throw new Error("native_substrate_env_missing");
}

/** The deny port the template names (NATIVE_GATEWAY_DENY_PORT); unset is the default 8791. */
function denyPortFrom(env: NodeJS.ProcessEnv): number {
  const raw = env[NATIVE_DENY_PORT_ENV];
  if (raw === undefined) return NATIVE_CANARY_DENY_PORT;
  const port = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (port >= 1 && port <= 65_535) return port;
  throw new Error("native_substrate_env_missing");
}

/** The input route's URL from NATIVE_GATEWAY_URL (the call route's URL), keeping any path prefix. */
export function gatewayInputUrl(gatewayUrl: string): string {
  return nativeGatewayRouteUrl(gatewayUrl, NATIVE_GATEWAY_INPUT_PATH);
}

/**
 * The input route's answer, or a GatewayError with a fixed message: the gateway's own message and
 * cause code are not kept, so nothing the answer carried reaches the worker's failure line.
 */
async function fetchInput(gatewayUrl: string, options: SubstrateModeOptions): Promise<unknown> {
  try {
    return await fetchSandboxInput({
      url: gatewayInputUrl(gatewayUrl),
      capability: NATIVE_PLACEHOLDER_CAPABILITY,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
  } catch (err) {
    const code = err instanceof GatewayError && KNOWN_CODES.has(err.code) ? err.code : "internal";
    throw new GatewayError(code, `native_substrate_input_unavailable: ${code}`);
  }
}

/** Waits for the actor's name, then runs the canary or the run. */
async function runNamed(gatewayUrl: string, log: Logger, options: SubstrateModeOptions): Promise<void> {
  const { token, role } = await waitForRunActor(options.metadataDir ?? DEFAULT_METADATA_DIR, ["native", "canary"], {
    log,
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  });
  if (role === "canary") {
    // The canary probes, posts its verdict and then idles like a finished run, pass or fail: the
    // launcher reads the verdict from the gateway and deletes the actor. A verdict it could not post
    // throws (exit 1).
    if (options.canary) await options.canary(gatewayUrl);
    else
      await runNativeCanary(gatewayUrl, `${token}${CANARY_SUFFIX}`, {
        denyPort: denyPortFrom(options.env),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.connect ? { connect: options.connect } : {}),
      });
    return;
  }
  const raw = await fetchInput(gatewayUrl, options);
  const parsed = GatewayInputResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("native_substrate_input_invalid");
  const full = WorkerInputSchema.safeParse({
    ...parsed.data.input,
    gateway: { url: gatewayUrl, capability: NATIVE_PLACEHOLDER_CAPABILITY },
  });
  if (!full.success) throw new Error("native_substrate_input_invalid");
  rememberSecretValue(NATIVE_PLACEHOLDER_CAPABILITY);
  await (options.run ?? runNativeWorker)(
    full.data,
    createHttpTransport({ url: gatewayUrl, capability: NATIVE_PLACEHOLDER_CAPABILITY }),
  );
}

/**
 * Serves /readyz, waits for the actor's name, fetches the run's input, runs it over the HTTP
 * transport with the placeholder, then resolves `{ server }` and the caller idles. Throws a fixed
 * code on any failure.
 */
export async function runSubstrateMode(options: SubstrateModeOptions): Promise<{ server: Server }> {
  const gatewayUrl = requireGatewayUrl(options.env);
  const log = options.log ?? stderrLogger;
  const { server } = await startReadyServer(options.readyPort ?? DEFAULT_READY_PORT);
  try {
    await runNamed(gatewayUrl, log, options);
  } catch (err) {
    // The process exits on a failure; closing first leaves nothing listening when it does not.
    server.close();
    throw err;
  }
  return { server };
}
