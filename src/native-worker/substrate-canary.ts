/**
 * The startup isolation canary of a Substrate native worker template (NATIVE_SANDBOX_LAUNCHER=
 * substrate), run inside a canary actor (`wr-<20 hex>-canary`) resumed from the same template as
 * every run, under an egress policy like a run's with the canary's own capability in place of the
 * run's. Worker-safe: Node built-ins and protocol.ts only.
 *
 * The probes are the Kubernetes in-pod probe's (kubernetes-isolation.ts nativeEnforcementProbe), in
 * the same order: the gateway's /healthz must answer 200 {"ok":true}; then its deny port (the
 * template's NATIVE_GATEWAY_DENY_PORT, default 8791) and every outside target (the internet and the
 * cloud metadata endpoints) must be denied. The verdict is the first that failed, or pass. It is
 * posted to the gateway's canary route with the public placeholder as its bearer: the egress
 * gateway replaces it on the wire with the canary's own one-use capability, which the actor never
 * holds (protocol.ts NATIVE_GATEWAY_CANARY_PATH).
 *
 * What counts as denied fails closed. A probe connects, sends one plain HTTP request (`GET /`,
 * `Connection: close`) and reads at most EGRESS_DENIAL_MAX_BYTES of the answer. The target is denied
 * only when its TCP connection never opens (refused, unreachable, a name that does not resolve, or
 * not open within 3 s), or when the whole answer is exactly the egress gateway's own denial
 * (EGRESS_DENIAL): status 403, a single `server: envoy` header, and a body of exactly
 * `egress denied`. Anything else on an opened connection is reachable: any other status, header or
 * body, a longer answer, silence, a close or a reset. So an egress path that answers some other
 * page fails every canary, which is visible (native_sandbox_network_unenforced), never a pass with
 * an unscoped policy. The gateway's deny port never answers at all (it accepts and closes), so a
 * policy that lets the probe reach it is reachable.
 */

import { connect as netConnect } from "node:net";
import {
  NATIVE_CANARY_DENY_PORT,
  NATIVE_GATEWAY_CANARY_PATH,
  NATIVE_PLACEHOLDER_CAPABILITY,
  NATIVE_PROBE_OUTSIDE_TARGETS,
  nativeGatewayRouteUrl,
  type NativeCanaryResult,
} from "./protocol.js";

/** How long a probe waits for a connection to open, and then for its answer. */
export const CANARY_PROBE_TIMEOUT_MS = 3_000;
const GATEWAY_TIMEOUT_MS = 10_000;
const REPORT_ATTEMPTS = 3;
const REPORT_RETRY_MS = 1_000;

export interface NativeCanaryOptions {
  fetch?: typeof globalThis.fetch;
  /** Whether host:port is reachable (true) or denied (false). Default: egressReachable. */
  connect?: (host: string, port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** The gateway's deny port (the template's NATIVE_GATEWAY_DENY_PORT). Default 8791. */
  denyPort?: number;
}

/**
 * The egress gateway's denial: the only answer on an opened connection that counts as denied. Matched
 * literally, in full: status, the one `server` header's value, and the whole body.
 */
export const EGRESS_DENIAL = Object.freeze({ status: 403, server: "envoy", body: "egress denied" });
/** The most of an answer a probe reads; a longer one is not the denial (reachable). */
export const EGRESS_DENIAL_MAX_BYTES = 2_048;

/**
 * Whether `raw` (the whole answer read, `ended` when the peer closed after it) is exactly
 * EGRESS_DENIAL. Pure, and strict: no head/body split, a status other than 403, no or several
 * `server` headers or a value other than `envoy`, a transfer-encoding, a content-length other than
 * the body's, or a body other than `egress denied` (byte for byte) is not the denial. A body with no
 * content-length counts only once the peer has closed (`ended`), so a cut-off answer never matches.
 */
export function isEgressDenial(raw: Buffer, ended: boolean): boolean {
  if (raw.length > EGRESS_DENIAL_MAX_BYTES) return false;
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) return false;
  const [statusLine, ...headerLines] = raw.subarray(0, split).toString("latin1").split("\r\n");
  if (!new RegExp(`^HTTP/1\\.[01] ${EGRESS_DENIAL.status}(?: |$)`).test(statusLine)) return false;
  const headers = new Map<string, string[]>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) return false;
    const name = line.slice(0, colon).trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  const server = headers.get("server");
  if (server?.length !== 1 || server[0] !== EGRESS_DENIAL.server) return false;
  if (headers.has("transfer-encoding")) return false;
  const body = raw.subarray(split + 4);
  const length = headers.get("content-length");
  if (length !== undefined) {
    if (length.length !== 1 || !/^[0-9]{1,5}$/.test(length[0]) || Number(length[0]) !== body.length) return false;
  } else if (!ended) {
    return false;
  }
  return body.equals(Buffer.from(EGRESS_DENIAL.body, "latin1"));
}

/**
 * The default probe: whether host:port is reachable (see the module comment). It connects within
 * `timeoutMs`, sends one `GET /` with `Connection: close`, and reads the answer for up to `timeoutMs`
 * more, at most EGRESS_DENIAL_MAX_BYTES. Denied (false) only when the connection never opens or the
 * whole answer is EGRESS_DENIAL; anything else is reachable (true). Nothing read is kept or logged.
 */
export function egressReachable(host: string, port: number, timeoutMs = CANARY_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let opened = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const socket = netConnect({ host, port });
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const answer = () => Buffer.concat(chunks, size);
    let timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      opened = true;
      clearTimeout(timer);
      // Opened: from here on the target is reachable unless its whole answer is the denial.
      timer = setTimeout(() => finish(!isEgressDenial(answer(), false)), timeoutMs);
      const target = host.includes(":") ? `[${host}]` : host;
      socket.write(`GET / HTTP/1.1\r\nHost: ${target}:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > EGRESS_DENIAL_MAX_BYTES) return finish(true);
      chunks.push(chunk);
      // A complete denial (by its content-length) settles at once; anything else waits for the close.
      if (isEgressDenial(answer(), false)) finish(false);
    });
    socket.once("end", () => finish(!isEgressDenial(answer(), true)));
    socket.once("error", () => finish(opened ? !isEgressDenial(answer(), true) : false));
    socket.once("close", () => finish(opened ? !isEgressDenial(answer(), true) : false));
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
  const connect = options.connect ?? ((host: string, port: number) => egressReachable(host, port));
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

/**
 * Posts the verdict with the placeholder bearer (the egress gateway puts the canary's capability in
 * its place); throws native_substrate_canary_unreported when it cannot.
 */
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
        headers: { "content-type": "application/json", authorization: `Bearer ${NATIVE_PLACEHOLDER_CAPABILITY}` },
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
 * posts the verdict to the gateway's canary route, with the placeholder bearer, and returns it.
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
