/**
 * The startup isolation canary of a Substrate native worker template (NATIVE_SANDBOX_LAUNCHER=
 * substrate), run inside a canary actor (`wr-<20 hex>-canary`) resumed from the same template as
 * every run, under an egress policy like a run's but with no credential. Worker-safe: Node built-ins
 * and protocol.ts only.
 *
 * The probes are the Kubernetes in-pod probe's (kubernetes-isolation.ts nativeEnforcementProbe), in
 * the same order: the gateway's /healthz must answer 200 {"ok":true}; then its deny port (8791) and
 * every outside target (the internet and the cloud metadata endpoints) must be denied. The verdict is
 * the first that failed, or pass. It is posted to the gateway's canary route with no credential: the
 * actor holds none, and the route needs none (protocol.ts NATIVE_GATEWAY_CANARY_PATH says why).
 *
 * What counts as denied fails closed. A target is denied when its TCP connection never opens
 * (refused, reset before it opens, unreachable, or no answer within 3 s). A connection that opens is
 * reachable, whatever follows (an answer, silence, a close or a reset), with one exception: an HTTP
 * answer that is the egress path's own denial, not the target's. The probe tells them apart by
 * asking the same question of 192.0.2.1 on the same port first (TEST-NET-1, RFC 5737: reserved for
 * documentation and routed nowhere, so no real host can answer there; any HTTP answer from it is the
 * egress path's). A target's answer counts as denied only when its status code and body equal that
 * reference answer's, after the probed `host:port` and host are replaced by placeholders in each.
 * Any other answer, or no reference answer at all, is reachable.
 */

import { request } from "node:http";
import {
  NATIVE_CANARY_DENY_PORT,
  NATIVE_GATEWAY_CANARY_PATH,
  NATIVE_PROBE_OUTSIDE_TARGETS,
  nativeGatewayRouteUrl,
  type NativeCanaryResult,
} from "./protocol.js";

/** How long a probe waits for a connection to open, and then for an answer. */
export const CANARY_PROBE_TIMEOUT_MS = 3_000;
/** Where the reference denial is asked for: TEST-NET-1 (RFC 5737), which no real host answers. */
export const CANARY_REFERENCE_HOST = "192.0.2.1";
/** The most of an HTTP answer a probe reads. */
const MAX_ANSWER_BYTES = 4096;
const GATEWAY_TIMEOUT_MS = 10_000;
const REPORT_ATTEMPTS = 3;
const REPORT_RETRY_MS = 1_000;

export interface NativeCanaryOptions {
  fetch?: typeof globalThis.fetch;
  /** Whether host:port is reachable (true) or denied (false). Default: createEgressProbe(). */
  connect?: (host: string, port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

/** What one connection attempt saw. */
export type EgressObservation = { kind: "denied" } | { kind: "open" } | { kind: "http"; status: number; body: string };

/**
 * One GET / to host:port. `denied` when the connection never opened; `open` when it opened but gave
 * no complete HTTP answer (silence, a close, a reset); `http` with the status and up to 4 KiB of body.
 */
export function observeEgress(
  host: string,
  port: number,
  timeoutMs = CANARY_PROBE_TIMEOUT_MS,
): Promise<EgressObservation> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const failed = (): EgressObservation => (connected ? { kind: "open" } : { kind: "denied" });
    const req = request({ host, port, method: "GET", path: "/", agent: false, headers: { connection: "close" } });
    const finish = (observation: EgressObservation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(observation);
    };
    // One deadline to open and one to answer, as the Kubernetes probe's connect timeout.
    timer = setTimeout(() => finish(failed()), timeoutMs);
    req.on("socket", (socket) => {
      socket.once("connect", () => {
        connected = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(failed()), timeoutMs);
      });
    });
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;
      const answered = () => finish({ kind: "http", status, body: Buffer.concat(chunks).toString("utf8") });
      res.on("data", (chunk: Buffer) => {
        const room = MAX_ANSWER_BYTES - size;
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size += chunk.length;
        if (size >= MAX_ANSWER_BYTES) answered();
      });
      res.on("end", answered);
      // A body cut short is not a complete answer.
      res.on("error", () => finish({ kind: "open" }));
      res.on("aborted", () => finish({ kind: "open" }));
    });
    req.on("error", () => finish(failed()));
    req.end();
  });
}

/** The answer with the probed target named by placeholders, so two targets' denials compare equal. */
function normalized(answer: { status: number; body: string }, host: string, port: number): string {
  const bracketed = host.includes(":") ? `[${host}]` : host;
  const body = answer.body
    .split(`${bracketed}:${port}`)
    .join("<target>")
    .split(`${host}:${port}`)
    .join("<target>")
    .split(host)
    .join("<host>");
  return `${answer.status}\n${body}`;
}

/**
 * The default `connect`: observeEgress, and for an HTTP answer, a comparison with the reference
 * denial from 192.0.2.1 on the same port (asked once per port, and only when needed).
 */
export function createEgressProbe(
  options: {
    observe?: (host: string, port: number) => Promise<EgressObservation>;
    referenceHost?: string;
  } = {},
): (host: string, port: number) => Promise<boolean> {
  const observe = options.observe ?? ((host: string, port: number) => observeEgress(host, port));
  const referenceHost = options.referenceHost ?? CANARY_REFERENCE_HOST;
  const references = new Map<number, Promise<EgressObservation>>();
  return async (host, port) => {
    const seen = await observe(host, port);
    if (seen.kind === "denied") return false;
    if (seen.kind === "open") return true;
    let reference = references.get(port);
    if (!reference) {
      reference = observe(referenceHost, port);
      references.set(port, reference);
    }
    const denial = await reference;
    if (denial.kind !== "http") return true;
    return normalized(seen, host, port) !== normalized(denial, referenceHost, port);
  };
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
  const connect = options.connect ?? createEgressProbe();
  const host = new URL(gatewayUrl).hostname.replace(/^\[|\]$/g, "");
  // Concurrent, as each dropped connect waits the full timeout; read in a fixed order, so the
  // verdict is the same whichever answers first.
  const deny = connect(host, NATIVE_CANARY_DENY_PORT).catch(() => true);
  const outside = Promise.all(NATIVE_PROBE_OUTSIDE_TARGETS.map((t) => connect(t.host, t.port).catch(() => true)));
  const [denyReachable, outsideReachable] = await Promise.all([deny, outside]);
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
 * (8791) and every outside target must be denied (see the module comment for what counts). Then
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
