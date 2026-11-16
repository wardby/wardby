/**
 * The startup isolation canary of a Substrate native worker template (NATIVE_SANDBOX_LAUNCHER=
 * substrate), run inside a canary actor (`wr-<20 hex>-canary`) resumed from the same template as
 * every run, under an egress policy like a run's but with no credential. Worker-safe: Node built-ins
 * and protocol.ts only.
 *
 * The probes are the Kubernetes in-pod probe's (kubernetes-isolation.ts nativeEnforcementProbe), in
 * the same order: the gateway's /healthz must answer 200 {"ok":true}; then its deny port (the
 * template's NATIVE_GATEWAY_DENY_PORT, default 8791) and every outside target (the internet and the
 * cloud metadata endpoints) must be denied. The verdict is the first that failed, or pass. It is
 * posted to the gateway's canary route with no credential: the actor holds none, and the route
 * needs none (protocol.ts NATIVE_GATEWAY_CANARY_PATH says why).
 *
 * What counts as denied fails closed: a target is denied only when its TCP connection never opens
 * (refused, unreachable, or not open within 3 s). Any connection that opens is reachable, whatever
 * follows: an HTTP answer of any status, silence, a close or a reset. So an egress path that
 * accepts the connection and answers its own denial page fails every canary, which is visible
 * (native_sandbox_network_unenforced), never a pass with an unscoped policy.
 *
 * Follow-up: once the kind spike shows the form of Substrate's egress denial, that exact form may be
 * matched literally (a pinned constant, not a comparison) and counted as denied.
 */

import { connect as netConnect } from "node:net";
import {
  NATIVE_CANARY_DENY_PORT,
  NATIVE_GATEWAY_CANARY_PATH,
  NATIVE_PROBE_OUTSIDE_TARGETS,
  nativeGatewayRouteUrl,
  type NativeCanaryResult,
} from "./protocol.js";

/** How long a probe waits for a connection to open. */
export const CANARY_PROBE_TIMEOUT_MS = 3_000;
const GATEWAY_TIMEOUT_MS = 10_000;
const REPORT_ATTEMPTS = 3;
const REPORT_RETRY_MS = 1_000;

export interface NativeCanaryOptions {
  fetch?: typeof globalThis.fetch;
  /** Whether host:port is reachable (true) or denied (false). Default: connectionOpens. */
  connect?: (host: string, port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** The gateway's deny port (the template's NATIVE_GATEWAY_DENY_PORT). Default 8791. */
  denyPort?: number;
}

/**
 * The default probe: whether a TCP connection to host:port opens within `timeoutMs`. Nothing is
 * sent; the socket is closed as soon as it opens. An error or the timeout before it opens is false.
 */
export function connectionOpens(host: string, port: number, timeoutMs = CANARY_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = netConnect({ host, port });
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(opened);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function gatewayHealthy(gatewayUrl: string, fetchFn: typeof globalThis.fetch): Promise<boolean> {
  try {
    // The listener answers /healthz at its root, whatever path prefix the call route has.
    const response = await fetchFn(new URL("/healthz", gatewayUrl).href, {
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (response.status !== 200) return false;
    const body = await response.json();
    return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** The probes, in the Kubernetes probe's order: gateway, then deny port, then outside. */
async function probe(gatewayUrl: string, options: NativeCanaryOptions): Promise<NativeCanaryResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!(await gatewayHealthy(gatewayUrl, fetchFn))) return "gateway_unreachable";
  const connect = options.connect ?? ((host: string, port: number) => connectionOpens(host, port));
  const host = new URL(gatewayUrl).hostname.replace(/^\[|\]$/g, "");
  // Concurrent, as each dropped connect waits the full timeout; read in a fixed order, so the
  // verdict is the same whichever answers first.
  const deny = connect(host, options.denyPort ?? NATIVE_CANARY_DENY_PORT).catch(() => true);
  const outside = Promise.all(NATIVE_PROBE_OUTSIDE_TARGETS.map((t) => connect(t.host, t.port).catch(() => true)));
  const [denyReachable, outsideReachable] = await Promise.all([deny, outside]);
  // A refused deny port looks the same as a gateway that dropped after the first check, so look
  // again: a gateway that is gone proves nothing about the policy, and the verdict is retryable.
  if (!(await gatewayHealthy(gatewayUrl, fetchFn))) return "gateway_unreachable";
  if (denyReachable) return "deny_port_reachable";
  if (outsideReachable.some(Boolean)) return "outside_reachable";
  return "pass";
}

/** Posts the verdict, with no credential; throws native_substrate_canary_unreported when it cannot. */
async function report(
  gatewayUrl: string,
  actor: string,
  result: NativeCanaryResult,
  options: NativeCanaryOptions,
): Promise<void> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = nativeGatewayRouteUrl(gatewayUrl, NATIVE_GATEWAY_CANARY_PATH);
  for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor, result }),
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      if (response.status === 204) return;
    } catch {
      // Retried below; the error's text is never kept.
    }
    if (attempt < REPORT_ATTEMPTS) await sleep(REPORT_RETRY_MS);
  }
  throw new Error("native_substrate_canary_unreported");
}

/**
 * Probes from inside the actor: the gateway's /healthz must answer 200 {"ok":true}; its deny port
 * and every outside target must be denied (see the module comment for what counts). Then
 * posts the verdict to the gateway's canary route, with no credential, and returns it.
 */
export async function runNativeCanary(
  gatewayUrl: string,
  actor: string,
  options: NativeCanaryOptions = {},
): Promise<NativeCanaryResult> {
  const result = await probe(gatewayUrl, options);
  await report(gatewayUrl, actor, result, options);
  return result;
}
