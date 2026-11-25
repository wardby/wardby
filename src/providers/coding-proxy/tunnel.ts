/**
 * The coding proxy's CONNECT tunnel: a blind TCP tunnel to a short list of hostnames on port 443, for
 * clients (a build's package manager, a container engine) that honour HTTPS_PROXY. TLS passes through
 * end to end, so nothing here ever sees or alters the payload.
 *
 * A host is allowed when it is on the server list (CODING_TUNNEL_ALLOWED_HOSTS, every run) or matches one
 * of the patterns the run was given at dispatch (its agent's codingProfile.tunnelHosts, src/coding/tunnel-hosts.ts),
 * within this proxy's own ceiling (CODING_TUNNEL_AGENT_HOSTS). Every other check applies the same either way.
 *
 * An allowed host with an intercept rule is the one exception (tunnel-intercept.ts): the proxy terminates the
 * run's TLS for it and attaches a credential. Every other host stays blind.
 *
 * It listens on its own port and shares no state with the request handler in server.ts. A request
 * is checked in this order, and the first failure answers with a fixed code:
 * authentication, target syntax, host (no IP literals, allowlist only), port 443, per-run limits,
 * destination address (public only, and the connection is pinned to the address that was checked).
 *
 * Secrets: the token, the `Proxy-Authorization` value and every other header value stay out of every
 * response, log line, audit record and metric. A requested host reaches an audit record only when its
 * whole name was written by the operator or the agent's owner: on the server list, or equal to one of the
 * run's exact patterns. A host allowed by `*.domain` or `*` is partly or wholly the run's own text (it could
 * carry anything the run holds), so its record names only the pattern (`matchedBy`); a refused host is
 * attacker-controlled text and is never echoed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import type { CodingTunnelConfig } from "../../config/coding-proxy-tunnel.js";
import { logger } from "../../core/logger.js";
import { HTTP_LIMITS } from "../../mcp/transport/http-limits.js";
import { FetchPolicyError, normalizeHost, resolveDestination, type Resolver } from "../../sandbox/fetch-policy.js";
import { connectPinned } from "../../sandbox/safe-fetch.js";
import { matchTunnelHost, tunnelHostKind, tunnelHostsWithinCeiling } from "../../coding/tunnel-hosts.js";
import type { TunnelAuthenticator, TunnelIdentity } from "./tunnel-auth.js";
import type { InterceptHandle, Interceptor } from "./tunnel-intercept.js";

const tunnelLog = logger.child({ module: "coding-proxy-tunnel" });

const TUNNEL_PORT = 443;
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RECHECK_MS = 10_000;
const MAX_TARGET_LENGTH = 300;
const MAX_CREDENTIAL_LENGTH = 4096;

/** The fixed codes a refused CONNECT is answered with (as the JSON error type and in the audit record). */
export const TUNNEL_REFUSALS = {
  tunnel_auth_required: 407,
  tunnel_session_ended: 403,
  tunnel_bad_target: 400,
  tunnel_host_not_allowed: 403,
  tunnel_port_not_allowed: 403,
  tunnel_limit: 429,
  tunnel_destination_blocked: 403,
  tunnel_upstream_failed: 502,
  tunnel_unavailable: 503,
  tunnel_connect_only: 405,
} as const;
export type TunnelRefusal = keyof typeof TUNNEL_REFUSALS;

/** How an established tunnel ended. */
export type TunnelOutcome =
  | "closed"
  | "idle_timeout"
  | "max_duration"
  | "session_ended"
  | "byte_cap"
  | "client_error"
  | "upstream_error"
  | "shutdown";

/**
 * One record per tunnel that reached an authenticated run: ids, an allowlisted host, byte counts,
 * times and a fixed outcome code. Never payload, token or header values.
 */
export interface TunnelAuditEvent {
  runId: string;
  /** Present only when the whole host was written by the operator or the agent's owner (see the header). */
  host?: string;
  /** What allowed the host: `server` (CODING_TUNNEL_ALLOWED_HOSTS), or the run's pattern that matched. */
  matchedBy?: string;
  status: number;
  outcome: TunnelOutcome | TunnelRefusal;
  /** Bytes from the upstream host to the client, and from the client to the upstream host. */
  bytesIn: number;
  bytesOut: number;
  /** Present when the proxy terminated the run's TLS for this tunnel: the HTTP requests it relayed. */
  intercepted?: { requests: number };
  startedAt: Date;
  durationMs: number;
}

export type TunnelAuditSink = (event: TunnelAuditEvent) => void;

export function logTunnelAudit(event: TunnelAuditEvent, sink: Pick<typeof tunnelLog, "info"> = tunnelLog): void {
  sink.info({ ...event, event: "audit.tunnel" }, "coding proxy tunnel audit");
}

export interface TunnelListenerOptions {
  host: string;
  config: CodingTunnelConfig;
  authenticator: TunnelAuthenticator;
  /** Hosts with an intercept rule are decrypted and given a credential; absent, every tunnel is blind. */
  interceptor?: Interceptor;
  audit?: TunnelAuditSink;
  /** The metrics hook shared with the request handler: protocol "tunnel", the status answered, and the time taken. */
  onRequest?: (event: { protocol: "tunnel"; status: number; durationMs: number }) => void;
  /** Overridable for tests: DNS, and the TCP connection to the checked address. */
  resolve?: Resolver;
  connect?: typeof connectPinned;
  /** How often open tunnels check that their session is still active. */
  recheckMs?: number;
}

export interface TunnelListenerHandle {
  port: number;
  close(): Promise<void>;
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  407: "Proxy Authentication Required",
  429: "Too Many Requests",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

function refusalBody(code: TunnelRefusal): string {
  return JSON.stringify({ error: { type: code, message: code } });
}

function refusalResponse(code: TunnelRefusal): string {
  const status = TUNNEL_REFUSALS[code];
  const body = refusalBody(code);
  return (
    `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n` +
    "content-type: application/json\r\n" +
    "cache-control: no-store\r\n" +
    "connection: close\r\n" +
    (status === 407 ? 'proxy-authenticate: Basic realm="wardby-tunnel"\r\n' : "") +
    `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

/** The tunnel token: the password half of `Proxy-Authorization: Basic ...`. Empty when absent or malformed. */
function tunnelToken(header: string | string[] | undefined): string {
  if (typeof header !== "string" || header.length > MAX_CREDENTIAL_LENGTH) return "";
  const basic = header.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/);
  if (!basic) return "";
  const decoded = Buffer.from(basic[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon >= 0 ? decoded.slice(colon + 1) : "";
}

export type Target = { kind: "bad" } | { kind: "ok"; host: string; port: number };

/** `host:port` as a CONNECT request line carries it. */
export function parseTarget(raw: string | undefined): Target {
  if (!raw || raw.length > MAX_TARGET_LENGTH) return { kind: "bad" };
  const colon = raw.lastIndexOf(":");
  if (colon <= 0) return { kind: "bad" };
  const rawPort = raw.slice(colon + 1);
  if (!/^\d{1,5}$/.test(rawPort)) return { kind: "bad" };
  try {
    return { kind: "ok", host: normalizeHost(raw.slice(0, colon)), port: Number(rawPort) };
  } catch {
    return { kind: "bad" };
  }
}

interface RunState {
  active: number;
  bytes: number;
}

interface ActiveTunnel {
  runId: string;
  stop(outcome: TunnelOutcome): void;
}

export async function startTunnelListener(options: TunnelListenerOptions): Promise<TunnelListenerHandle> {
  const { config, authenticator } = options;
  const allowedHosts = new Set(config.allowedHosts.map(normalizeHost));
  const connect = options.connect ?? connectPinned;
  const runs = new Map<string, RunState>();
  const tunnels = new Set<ActiveTunnel>();

  const observe = (status: number, durationMs: number) => {
    try {
      options.onRequest?.({ protocol: "tunnel", status, durationMs });
    } catch (error) {
      tunnelLog.warn({ event: "metrics.observe_failed", errName: errorName(error) }, "tunnel metrics observer failed");
    }
  };
  const record = (event: TunnelAuditEvent) => {
    try {
      (options.audit ?? logTunnelAudit)(event);
    } catch (error) {
      tunnelLog.warn({ event: "audit.sink_failed", errName: errorName(error) }, "tunnel audit sink failed");
    }
  };
  const runState = (runId: string): RunState => {
    let state = runs.get(runId);
    if (!state) {
      state = { active: 0, bytes: 0 };
      runs.set(runId, state);
    }
    return state;
  };

  const handleConnect = async (request: IncomingMessage, client: Socket, head: Buffer): Promise<void> => {
    const startedAt = new Date();
    const t0 = performance.now();
    // Until the tunnel is up a failing client socket is not an event; once it is, finish() owns it.
    client.on("error", () => undefined);
    // Filled in as the checks pass, so a refusal records only what it has earned.
    const known: { identity?: TunnelIdentity; host?: string; matchedBy?: string } = {};

    const refuse = (code: TunnelRefusal): void => {
      const durationMs = performance.now() - t0;
      client.end(refusalResponse(code));
      tunnelLog.info(
        { event: "tunnel.refused", code, ...(known.identity ? { runId: known.identity.runId } : {}) },
        "tunnel refused",
      );
      if (known.identity) {
        record({
          runId: known.identity.runId,
          ...(known.host ? { host: known.host } : {}),
          ...(known.matchedBy ? { matchedBy: known.matchedBy } : {}),
          status: TUNNEL_REFUSALS[code],
          outcome: code,
          bytesIn: 0,
          bytesOut: 0,
          startedAt,
          durationMs,
        });
      }
      observe(TUNNEL_REFUSALS[code], durationMs);
    };

    const token = tunnelToken(request.headers["proxy-authorization"]);
    if (!token) return refuse("tunnel_auth_required");
    let auth: Awaited<ReturnType<TunnelAuthenticator["authenticate"]>>;
    try {
      auth = await authenticator.authenticate(token);
    } catch (error) {
      tunnelLog.error({ event: "tunnel.auth_failed", errName: errorName(error) }, "tunnel authenticator failed");
      return refuse("tunnel_unavailable");
    }
    if (!auth.ok) return refuse(auth.reason === "invalid" ? "tunnel_auth_required" : "tunnel_session_ended");
    const identity = auth.identity;
    known.identity = identity;

    const target = parseTarget(request.url);
    if (target.kind === "bad") return refuse("tunnel_bad_target");
    if (isIP(target.host) !== 0) return refuse("tunnel_host_not_allowed");
    const tunnelHost = target.host;
    // The server list first, then the run's own patterns as this proxy's ceiling allows them now.
    const matchedBy = allowedHosts.has(tunnelHost)
      ? "server"
      : matchTunnelHost(tunnelHost, tunnelHostsWithinCeiling(identity.tunnelHosts ?? [], config.agentHosts));
    if (matchedBy === undefined) return refuse("tunnel_host_not_allowed");
    const recordedHost = matchedBy === "server" || tunnelHostKind(matchedBy) === "exact" ? tunnelHost : undefined;
    known.host = recordedHost;
    known.matchedBy = matchedBy;
    if (target.port !== TUNNEL_PORT) return refuse("tunnel_port_not_allowed");

    const state = runState(identity.runId);
    if (state.active >= config.maxConnections || state.bytes >= config.maxBytes) return refuse("tunnel_limit");
    // Taken before the first await below, so concurrent CONNECTs cannot all pass the cap check.
    state.active++;
    const release = () => {
      state.active--;
      if (state.active === 0 && identity.deadlineAt.getTime() <= Date.now()) runs.delete(identity.runId);
    };

    const aborted = new AbortController();
    client.once("close", () => aborted.abort());
    // An intercepted host connects upstream per request, inside the interceptor, so no tunnel-wide upstream.
    // Interception rules are exact server-list hosts: a host allowed only by a run's pattern is never intercepted.
    const intercepting = matchedBy === "server" && options.interceptor?.hosts.has(tunnelHost) === true;
    let upstream: Socket | undefined;
    if (!intercepting) {
      try {
        const destination = await resolveDestination(`https://${tunnelHost}/`, {
          allowedHosts: [tunnelHost],
          restrictToAllowedHosts: true,
          resolve: options.resolve,
        });
        upstream = await connect(
          destination,
          AbortSignal.any([aborted.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
        );
      } catch (error) {
        release();
        return refuse(error instanceof FetchPolicyError ? "tunnel_destination_blocked" : "tunnel_upstream_failed");
      }
    }
    if (client.destroyed) {
      upstream?.destroy();
      release();
      return;
    }

    // Established. From here finish() is the only way out, and it runs once.
    const run = identity;
    const limitMs = Math.min(config.maxDurationMs, Math.max(run.deadlineAt.getTime() - Date.now(), 1));
    const deadlineLimited = run.deadlineAt.getTime() - Date.now() < config.maxDurationMs;
    let bytesIn = 0;
    let bytesOut = 0;
    let done = false;
    let intercepted: InterceptHandle | undefined;
    const entry: ActiveTunnel = { runId: run.runId, stop: (outcome) => finish(outcome) };
    const timer = setTimeout(() => finish(deadlineLimited ? "session_ended" : "max_duration"), limitMs);
    function finish(outcome: TunnelOutcome): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      tunnels.delete(entry);
      client.destroy();
      upstream?.destroy();
      intercepted?.dispose();
      release();
      const durationMs = performance.now() - t0;
      record({
        runId: run.runId,
        ...(recordedHost ? { host: recordedHost } : {}),
        matchedBy,
        status: 200,
        outcome,
        bytesIn,
        bytesOut,
        ...(intercepted ? { intercepted: { requests: intercepted.requests() } } : {}),
        startedAt,
        durationMs,
      });
      observe(200, durationMs);
    }
    const account = (direction: "in" | "out", length: number) => {
      if (direction === "in") bytesIn += length;
      else bytesOut += length;
      state.bytes += length;
      if (state.bytes > config.maxBytes) finish("byte_cap");
    };
    tunnels.add(entry);

    client.setTimeout(config.idleMs, () => finish("idle_timeout"));
    client.on("error", () => finish("client_error"));
    // A graceful end propagates through pipe(); the tunnel is over when the client's side closes.
    client.once("close", () => finish("closed"));

    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (intercepting && options.interceptor) {
      // The interceptor counts the decrypted bodies; the raw socket belongs to its TLS from here.
      intercepted = options.interceptor.attach({ client, head, host: tunnelHost, account });
      return;
    }
    if (!upstream) return;
    upstream.setTimeout(config.idleMs, () => finish("idle_timeout"));
    upstream.on("error", () => finish("upstream_error"));
    client.on("data", (chunk: Buffer) => account("out", chunk.length));
    upstream.on("data", (chunk: Buffer) => account("in", chunk.length));
    if (head.length > 0) {
      upstream.write(head);
      account("out", head.length);
    }
    client.pipe(upstream);
    upstream.pipe(client);
  };

  const server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: false });
  server.headersTimeout = HTTP_LIMITS.headersMs;
  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    handleConnect(request, client, head).catch((error: unknown) => {
      tunnelLog.error({ event: "tunnel.failed", errName: errorName(error) }, "tunnel failed");
      client.destroy();
    });
  });
  // Anything but CONNECT, plain http:// forward requests included, is refused: a credential is never
  // attached to a plaintext request, and nothing here serves content.
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    response
      .writeHead(TUNNEL_REFUSALS.tunnel_connect_only, {
        "content-type": "application/json",
        "cache-control": "no-store",
        allow: "CONNECT",
        connection: "close",
      })
      .end(refusalBody("tunnel_connect_only"));
    observe(TUNNEL_REFUSALS.tunnel_connect_only, 0);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, options.host, resolve);
  });
  server.on("error", (error) => {
    tunnelLog.error({ event: "tunnel.listener_error", errName: errorName(error) }, "tunnel listener error");
  });

  // Open tunnels end when their session does: cancelled or finished runs do not wait for the deadline.
  const recheck = setInterval(() => {
    const runIds = new Set([...tunnels].map((tunnel) => tunnel.runId));
    for (const runId of runIds) {
      authenticator
        .isActive(runId)
        .then((active) => {
          if (active) return;
          for (const tunnel of [...tunnels]) if (tunnel.runId === runId) tunnel.stop("session_ended");
        })
        .catch(() => undefined);
    }
  }, options.recheckMs ?? DEFAULT_RECHECK_MS);
  recheck.unref();

  const address = server.address();
  let closing: Promise<void> | undefined;
  return {
    port: typeof address === "object" && address ? address.port : config.port,
    // Idempotent: a second call waits for the first rather than failing on a stopped server.
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        clearInterval(recheck);
        server.close((error) => (error ? reject(error) : resolve()));
        for (const tunnel of [...tunnels]) tunnel.stop("shutdown");
        server.closeAllConnections();
      })),
  };
}

/** An error's class name only: its message can carry a value that must not reach a log. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
