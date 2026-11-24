/**
 * TLS interception for the tunnel's few credentialed hosts. For an allowed host that has an intercept
 * rule, the CONNECT is answered `200` as usual and the proxy then terminates the run's TLS itself, with a
 * leaf the deployment's CA signs for that host only. Each request on it goes to the real host over a new
 * TLS connection (pinned to the address that was vetted, certificate verified normally), with the
 * client's own `Authorization` dropped and the rule's credential attached.
 *
 * The credential reaches a request only through three checks that all hold by construction: the host
 * came from the CONNECT that passed the allowlist, the client's TLS server name must equal it, and the
 * upstream connection is made to that host alone. A redirect is relayed, never followed, so the credential
 * never travels to a redirect target; the client's follow-up goes through its own tunnel, which is blind
 * unless that host has a rule of its own.
 *
 * Secrets: the credential, every header value, the path and the body stay out of every log line, audit
 * record, metric and error. A failure answers with a fixed code. Only the number of requests and
 * byte counts leave this module.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import {
  connect as tlsConnect,
  createSecureContext,
  TLSSocket,
  type ConnectionOptions,
  type SecureContext,
} from "node:tls";
import { readFile } from "node:fs/promises";
import type { CodingTunnelConfig, CodingTunnelInterceptRule } from "../../config/coding-proxy-tunnel.js";
import { logger } from "../../core/logger.js";
import { HTTP_LIMITS } from "../../mcp/transport/http-limits.js";
import { FetchPolicyError, normalizeHost, resolveDestination, type Resolver } from "../../sandbox/fetch-policy.js";
import { connectPinned } from "../../sandbox/safe-fetch.js";
import { loadInterceptCa, reloadingInterceptCa, type InterceptCa, type InterceptLeaf } from "./tunnel-ca.js";

const interceptLog = logger.child({ module: "coding-proxy-tunnel-intercept" });

const CONNECT_TIMEOUT_MS = 15_000;

/** The fixed codes an intercepted request that cannot be served is answered with (inside the run's TLS). */
export const INTERCEPT_REFUSALS = {
  intercept_bad_request: 400,
  intercept_destination_blocked: 403,
  intercept_upstream_failed: 502,
} as const;
export type InterceptRefusal = keyof typeof INTERCEPT_REFUSALS;

const STATUS_TEXT: Record<number, string> = { 400: "Bad Request", 403: "Forbidden", 502: "Bad Gateway" };

/** Request headers never forwarded: the client's credentials, hop-by-hop fields, and proxy forwarding hints. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "host",
  "forwarded",
  "via",
  "x-real-ip",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** One credentialed host: the `Authorization` value is built once at start-up and never leaves this module. */
export interface InterceptRule {
  host: string;
  authorization: string;
}

export interface InterceptorOptions {
  ca: InterceptCa;
  rules: readonly InterceptRule[];
  /** The tunnel's allowlist, for the destination check on every upstream connection. */
  allowedHosts: readonly string[];
  /** Overridable for tests: DNS, the TCP connection to the vetted address, and what the upstream certificate is checked against. */
  resolve?: Resolver;
  connect?: typeof connectPinned;
  upstreamTls?: Pick<ConnectionOptions, "ca">;
}

/** What the CONNECT handler gives an interception: the raw client socket after `200`, and its accounting. */
export interface InterceptSession {
  client: Socket;
  /** Bytes the client sent after the CONNECT head, before the tunnel was up. */
  head: Buffer;
  host: string;
  /** Counts body bytes against the run's cap; the tunnel ends itself when the cap is passed. */
  account(direction: "in" | "out", length: number): void;
}

export interface InterceptHandle {
  /** HTTP requests relayed on this tunnel. */
  requests(): number;
  /** Closes the run's TLS and every open upstream connection. */
  dispose(): void;
}

export interface Interceptor {
  hosts: ReadonlySet<string>;
  attach(session: InterceptSession): InterceptHandle;
}

function refusalBody(code: InterceptRefusal): string {
  return JSON.stringify({ error: { type: code, message: code } });
}

/** An HTTP field name (RFC 9110 token). Node's parser only yields these; this states it where the name is used. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Header names come from the peer, so they go into a flat `[name, value, name, value, ...]` list (which
 * `http.request` and `writeHead` both accept), never in as property keys of an object. Only a well-formed
 * name is kept, and `__proto__` never is.
 */
function pushHeader(out: string[], name: string, value: string | readonly string[]): void {
  if (!HEADER_NAME.test(name) || name === "__proto__") return;
  for (const each of typeof value === "string" ? [value] : value) out.push(name, each);
}

export function forwardedHeaders(headers: IncomingHttpHeaders, host: string, authorization: string): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || name.startsWith("x-forwarded-")) continue;
    pushHeader(out, name, value);
  }
  out.push("host", host, "authorization", authorization);
  return out;
}

export function relayedHeaders(headers: IncomingHttpHeaders): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue;
    pushHeader(out, name, value);
  }
  return out;
}

/** The `Host` header names the intercepted host, with or without the port. */
function hostHeaderMatches(header: string | undefined, host: string): boolean {
  if (header === undefined) return false;
  try {
    return normalizeHost(header.replace(/:443$/, "")) === host;
  } catch {
    return false;
  }
}

export function createInterceptor(options: InterceptorOptions): Interceptor {
  const rules = new Map(options.rules.map((rule) => [normalizeHost(rule.host), rule.authorization]));
  const connect = options.connect ?? connectPinned;
  const contexts = new Map<string, { leaf: InterceptLeaf; context: SecureContext }>();

  /** The SecureContext for a leaf, built once per leaf the CA hands out. */
  const contextFor = async (host: string): Promise<SecureContext> => {
    const leaf = await options.ca.leafFor(host);
    const known = contexts.get(host);
    if (known?.leaf === leaf) return known.context;
    const context = createSecureContext({ cert: leaf.certificatePem, key: leaf.privateKeyPem });
    contexts.set(host, { leaf, context });
    return context;
  };

  return {
    hosts: new Set(rules.keys()),
    attach(session) {
      const { client, host } = session;
      const authorization = rules.get(host);
      if (authorization === undefined) throw new Error("intercept_host_without_rule");
      const upstreams = new Set<Socket>();
      let requests = 0;

      // The run's TLS. With no default context, a ClientHello without a server name has nothing to answer
      // with and fails; one with the wrong name is refused in the callback. Either way no byte of the
      // request is read, and no credential is attached.
      if (session.head.length > 0) client.unshift(session.head);
      const secure = new TLSSocket(client, {
        isServer: true,
        ALPNProtocols: ["http/1.1"],
        minVersion: "TLSv1.2",
        SNICallback: (servername, done) => {
          let requested: string | undefined;
          try {
            requested = normalizeHost(servername);
          } catch {
            requested = undefined;
          }
          if (requested !== host) return done(new Error("intercept_sni_mismatch"));
          contextFor(host).then(
            (context) => done(null, context),
            () => done(new Error("intercept_certificate_unavailable")),
          );
        },
      });
      secure.on("error", () => undefined);

      const refuse = (response: ServerResponse, code: InterceptRefusal): void => {
        const status = INTERCEPT_REFUSALS[code];
        const body = refusalBody(code);
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
          connection: "close",
        });
        response.end(body);
        interceptLog.info({ event: "intercept.refused", code }, `intercept refused: ${STATUS_TEXT[status]}`);
      };

      const handle = async (incoming: IncomingMessage, response: ServerResponse): Promise<void> => {
        requests++;
        const path = incoming.url;
        if (
          incoming.headers.upgrade !== undefined ||
          incoming.method === "CONNECT" ||
          typeof path !== "string" ||
          !path.startsWith("/") ||
          !hostHeaderMatches(incoming.headers.host, host)
        ) {
          incoming.resume();
          return refuse(response, "intercept_bad_request");
        }

        const aborted = new AbortController();
        response.once("close", () => aborted.abort());
        let upstream: TLSSocket;
        try {
          const destination = await resolveDestination(`https://${host}/`, {
            allowedHosts: [...options.allowedHosts],
            restrictToAllowedHosts: true,
            resolve: options.resolve,
          });
          const raw = await connect(
            destination,
            AbortSignal.any([aborted.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
          );
          upstream = tlsConnect({
            socket: raw,
            servername: host,
            ALPNProtocols: ["http/1.1"],
            minVersion: "TLSv1.2",
            ...options.upstreamTls,
          });
        } catch (error) {
          incoming.resume();
          return refuse(
            response,
            error instanceof FetchPolicyError ? "intercept_destination_blocked" : "intercept_upstream_failed",
          );
        }
        upstreams.add(upstream);
        upstream.once("close", () => upstreams.delete(upstream));
        upstream.on("error", () => undefined);

        const outgoing = httpRequest({
          // No agent: with one, Node ignores createConnection and would dial the host itself, unpinned.
          createConnection: () => upstream,
          method: incoming.method,
          path,
          headers: forwardedHeaders(incoming.headers, host, authorization),
        });
        outgoing.on("error", () => {
          incoming.unpipe(outgoing);
          incoming.resume();
          refuse(response, "intercept_upstream_failed");
          upstream.destroy();
        });
        outgoing.on("response", (reply) => {
          response.writeHead(reply.statusCode ?? 502, relayedHeaders(reply.headers));
          reply.on("data", (chunk: Buffer) => session.account("in", chunk.length));
          reply.on("error", () => response.destroy());
          reply.pipe(response);
        });
        response.once("close", () => {
          if (!response.writableFinished) outgoing.destroy();
        });
        incoming.on("data", (chunk: Buffer) => session.account("out", chunk.length));
        incoming.pipe(outgoing);
      };

      const server = createServer({ maxHeaderSize: 16 * 1024 });
      server.headersTimeout = HTTP_LIMITS.headersMs;
      // Blob transfers outlast the request timeout of the main handler: the tunnel's idle and maximum
      // durations bound them instead.
      server.requestTimeout = 0;
      server.on("request", (incoming: IncomingMessage, response: ServerResponse) => {
        handle(incoming, response).catch(() => {
          if (!response.headersSent) refuse(response, "intercept_upstream_failed");
          else response.destroy();
        });
      });
      server.on("clientError", (_error, socket) => socket.destroy());
      server.emit("connection", secure);

      return {
        requests: () => requests,
        dispose: () => {
          secure.destroy();
          for (const upstream of [...upstreams]) upstream.destroy();
          server.closeAllConnections();
        },
      };
    },
  };
}

/** The `Authorization` header value for a credential: `Bearer <value>`, or Basic with the rule's user name. */
export function buildAuthorization(scheme: "bearer" | "basic", username: string | undefined, value: string): string {
  return scheme === "bearer"
    ? `Bearer ${value}`
    : `Basic ${Buffer.from(`${username ?? ""}:${value}`).toString("base64")}`;
}

/**
 * One rule's host and its `Authorization` value, from the proxy's environment. Throws naming the variable,
 * never a value.
 */
export function resolveInterceptRule(rule: CodingTunnelInterceptRule, env: NodeJS.ProcessEnv): InterceptRule {
  const name = rule.credential.slice("env:".length);
  const value = env[name];
  if (!value) throw new Error(`CODING_TUNNEL_INTERCEPT_RULES refers to ${name}, which is not set.`);
  // A header value is one line of printable characters; anything else could add a header of its own.
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`${name} must be one line of printable characters.`);
  let username = rule.username;
  if (rule.usernameCredential !== undefined) {
    const userName = rule.usernameCredential.slice("env:".length);
    username = env[userName];
    if (!username) throw new Error(`CODING_TUNNEL_INTERCEPT_RULES refers to ${userName}, which is not set.`);
    // The same rule the config applies to a written-out user name.
    if (!/^[\x21-\x39\x3b-\x7e]{1,128}$/.test(username))
      throw new Error(`${userName} must be a user name of printable characters without a colon.`);
  }
  return { host: rule.host, authorization: buildAuthorization(rule.scheme, username, value) };
}

/**
 * The interceptor for the tunnel's settings, or undefined when no host is intercepted. Reads the CA files (or
 * takes the PEM text the environment gave) and resolves each rule's `env:NAME` credential once, before
 * anything listens. Throws naming the setting or variable, never a value. A CA that came from files is read
 * again while the proxy runs, so a rotated one (a cert-manager Secret mounted as a volume) is picked up
 * without a restart; PEM text from the environment cannot change, so it is not.
 */
export async function loadInterceptor(
  config: CodingTunnelConfig,
  env: NodeJS.ProcessEnv = process.env,
  overrides: Pick<InterceptorOptions, "resolve" | "connect" | "upstreamTls"> & {
    read?: typeof readFile;
    reloadMs?: number;
  } = {},
): Promise<Interceptor | undefined> {
  const intercept = config.intercept;
  if (!intercept) return undefined;
  const rules = intercept.rules.map((rule) => resolveInterceptRule(rule, env));
  const read = overrides.read ?? readFile;
  // Each of the two is the PEM text from the environment or a file the config named, never both.
  const readPair = async () => {
    const [certificatePem, privateKeyPem] = await Promise.all([
      intercept.caCertPem ?? read(intercept.caCertFile!, "utf8"),
      intercept.caKeyPem ?? read(intercept.caKeyFile!, "utf8"),
    ]);
    return { certificatePem, privateKeyPem };
  };
  let source: { certificatePem: string; privateKeyPem: string };
  try {
    source = await readPair();
  } catch {
    throw new Error("CODING_TUNNEL_INTERCEPT_CA_CERT_FILE and _KEY_FILE must be readable files.");
  }
  const initial = await loadInterceptCa({ ...source, hosts: rules.map((rule) => rule.host) });
  const warnUnconstrained = (): void =>
    interceptLog.warn(
      { event: "intercept.ca_unconstrained" },
      "intercept CA has no name constraint: a leaked key could sign for any host",
    );
  if (!initial.constrained) warnUnconstrained();
  const ca =
    intercept.caCertFile || intercept.caKeyFile
      ? reloadingInterceptCa({
          initial,
          source,
          read: readPair,
          ...(overrides.reloadMs !== undefined ? { intervalMs: overrides.reloadMs } : {}),
          onReload: () => {
            interceptLog.info({ event: "intercept.ca_reloaded" }, "intercept CA reloaded");
            if (!ca.constrained) warnUnconstrained();
          },
          onError: (message) =>
            interceptLog.warn({ event: "intercept.ca_reload_failed", reason: message }, "intercept CA reload failed"),
        })
      : initial;
  return createInterceptor({
    ca,
    rules,
    allowedHosts: config.allowedHosts,
    ...(overrides.resolve ? { resolve: overrides.resolve } : {}),
    ...(overrides.connect ? { connect: overrides.connect } : {}),
    ...(overrides.upstreamTls ? { upstreamTls: overrides.upstreamTls } : {}),
  });
}
