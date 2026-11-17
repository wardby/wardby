/**
 * The native sandbox gateway's internal HTTP listener (NATIVE_GATEWAY_LISTEN).
 * Deliberately separate from the public MCP/webhook server: only sandbox
 * workers reach it (deployment network policy allows worker → this port and
 * nothing else), and every request carries a one-run bearer capability.
 *
 *   POST /native-gateway/v1/call   body: GatewayRequest
 *   → application/json            { ok: true, result } | { ok: false, error: { code, message } }
 *   → application/x-ndjson        (llm.stream) { event } … then { end: true } or { error: { code, message, causeCode? } }
 *
 *   POST /native-gateway/v1/input  no body (more than MAX_INPUT_REQUEST_BYTES is cut off); the same bearer auth as a call → { ok: true, result: { input } }:
 *                                  the session's snapshot input (no gateway, no secrets) for a worker that
 *                                  starts without it (Substrate)
 *
 *   POST /native-gateway/v1/canary body { actor, result } (at most MAX_CANARY_REQUEST_BYTES), no auth → 204, or 400 { ok: false }:
 *                                  a Substrate startup canary's verdict (substrate-canary.ts). 404 when the
 *                                  listener was started without a canary store.
 *
 *   POST /coding-mcp               a coding run's MCP calls, forwarded by the coding proxy's /mcp route
 *                                  (src/core/coding-mcp.ts); its own auth: the run's MCP token, not a
 *                                  gateway capability. 404 when the listener was started without it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CODING_MCP_PATH, handleCodingMcpRequest, type CodingMcpDeps } from "../core/coding-mcp.js";
import { parseListenAddress, type ListenAddress } from "../core/listen-address.js";
import { logger } from "../core/logger.js";
import { HTTP_LIMITS, HttpBoundaryError, readBody as readLimitedBody } from "../mcp/transport/http-limits.js";
import { logUnexpectedError } from "./gateway.js";
import { serveGatewayInput, serveGatewayRequest, type GatewayServerDeps } from "./gateway-server.js";
import {
  GATEWAY_INTERNAL_MESSAGE,
  GatewayError,
  MAX_MESSAGE_BYTES,
  NATIVE_GATEWAY_CALL_PATH,
  NATIVE_GATEWAY_CANARY_PATH,
  NATIVE_GATEWAY_INPUT_PATH,
  NativeCanaryReportSchema,
  toGatewayError,
} from "./protocol.js";
import type { NativeCanaryStore } from "./substrate-canary-store.js";

/** The HTTP listener's own log. Exported so tests can watch it. */
export const httpLog = logger.child({ module: "native-gateway-http" });

export const NATIVE_GATEWAY_PATH = NATIVE_GATEWAY_CALL_PATH;

export type NativeGatewayListen = ListenAddress;

/** Parses NATIVE_GATEWAY_LISTEN ("host:port" or ":port"); undefined when unset. */
export function parseGatewayListen(value: string | undefined): NativeGatewayListen | undefined {
  return parseListenAddress("NATIVE_GATEWAY_LISTEN", value);
}

/** The input route reads no body; a client that sends more than this is cut off. */
export const MAX_INPUT_REQUEST_BYTES = 1024;

/** Discards a request body it does not need, destroying the request once it passes `limit` bytes. */
function drainBounded(req: IncomingMessage, limit: number): { readonly cutOff: boolean } {
  const state = { cutOff: false, size: 0 };
  req.on("data", (chunk: Buffer) => {
    state.size += chunk.length;
    if (state.size > limit && !state.cutOff) {
      state.cutOff = true;
      req.destroy();
    }
  });
  return state;
}

/** The canary route's body is one actor name and one enum value; anything longer is refused. */
export const MAX_CANARY_REQUEST_BYTES = 1024;

/** The body, or undefined once it passes `limit` bytes (the rest is not kept) or the request fails. */
function readSmallBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) settle(undefined);
      else chunks.push(chunk);
    });
    req.on("end", () => settle(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => settle(undefined));
  });
}

/**
 * POST /native-gateway/v1/canary: a Substrate startup canary's verdict. Unauthenticated, because the
 * canary actor holds no credential; what limits it is the store (a report counts only for a random
 * actor name that already has a row, once, within its report window) and the schema (that
 * name's shape and a fixed enum). Every valid body gets 204 whether or not a row took it, so the
 * route tells a caller nothing (no oracle). The body is never logged and no header is read. A
 * recorded verdict logs its result enum (each row takes one, so these are bounded by the canaries
 * launched); reports no row took are counted and logged as one summary line a minute at most, so a
 * caller repeating the route cannot flood the log.
 */
async function serveCanary(
  req: IncomingMessage,
  res: ServerResponse,
  canaries: NativeCanaryStore,
  unrecorded: UnrecordedCanaryLog,
): Promise<void> {
  const text = await readSmallBody(req, MAX_CANARY_REQUEST_BYTES);
  let parsed: ReturnType<typeof NativeCanaryReportSchema.safeParse> | undefined;
  if (text !== undefined) {
    try {
      parsed = NativeCanaryReportSchema.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed?.success) {
    res.setHeader("content-type", "application/json");
    if (text === undefined) {
      // Cut off: answer, then drop the connection rather than read the rest.
      res.setHeader("connection", "close");
      res.on("finish", () => req.destroy());
    }
    res.writeHead(400);
    res.end(JSON.stringify({ ok: false }));
    return;
  }
  const { actor, result } = parsed.data;
  const recorded = await canaries.report(actor, result, new Date()).catch(() => false);
  if (recorded) httpLog.info({ result, recorded }, "native substrate canary reported");
  else unrecorded.add();
  res.writeHead(204);
  res.end();
}

/** How often, at most, the canary route logs the reports no row took. */
const UNRECORDED_CANARY_LOG_MS = 60_000;

/** Counts canary reports no row took; logs the count at most once per UNRECORDED_CANARY_LOG_MS. */
class UnrecordedCanaryLog {
  private count = 0;
  private loggedAt = -Infinity;
  add(): void {
    this.count += 1;
    const now = Date.now();
    if (now - this.loggedAt < UNRECORDED_CANARY_LOG_MS) return;
    httpLog.warn({ unrecorded: this.count }, "native substrate canary reports not recorded");
    this.count = 0;
    this.loggedAt = now;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MESSAGE_BYTES) {
        reject(new GatewayError("invalid_request", "message_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createGatewayServer(deps: GatewayServerDeps): Server {
  const unrecordedCanaries = new UnrecordedCanaryLog();
  return createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void (async () => {
      const send = (status: number, body: unknown) => {
        res.setHeader("content-type", "application/json");
        res.writeHead(status);
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/healthz") {
        // Ready when the database answers: every call needs it.
        const healthy = await deps.db.$queryRaw`SELECT 1`.then(
          () => true,
          () => false,
        );
        send(healthy ? 200 : 503, { ok: healthy });
        return;
      }
      if (new URL(req.url ?? "/", "http://gateway").pathname === CODING_MCP_PATH && deps.codingMcp) {
        await serveCodingMcp(req, res, deps.codingMcp);
        return;
      }
      if (req.method === "POST" && req.url === NATIVE_GATEWAY_INPUT_PATH) {
        const drain = drainBounded(req, MAX_INPUT_REQUEST_BYTES);
        const response = await serveGatewayInput(deps, req.headers.authorization);
        if (drain.cutOff) return;
        if (response.kind === "json") send(response.status, response.body);
        // The route only ever answers JSON; anything else is a fault, answered rather than left hanging.
        else send(500, { ok: false, error: { code: "internal", message: GATEWAY_INTERNAL_MESSAGE } });
        return;
      }
      if (req.method === "POST" && req.url === NATIVE_GATEWAY_CANARY_PATH && deps.canaries) {
        await serveCanary(req, res, deps.canaries, unrecordedCanaries);
        return;
      }
      if (req.method !== "POST" || req.url !== NATIVE_GATEWAY_PATH) {
        send(404, { ok: false, error: { code: "not_found", message: "not found" } });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        send(400, {
          ok: false,
          error: { code: "invalid_request", message: err instanceof GatewayError ? err.message : "body is not JSON" },
        });
        return;
      }
      const response = await serveGatewayRequest(deps, req.headers.authorization, body);
      if (response.kind === "json") {
        send(response.status, response.body);
        return;
      }
      res.setHeader("content-type", "application/x-ndjson");
      res.writeHead(200);
      try {
        for await (const event of response.events) res.write(`${JSON.stringify({ event })}\n`);
        res.end(`${JSON.stringify({ end: true })}\n`);
      } catch (err) {
        // The gateway's stream fails only with a checked GatewayError (checkedEvents); anything else
        // still crosses as the generic message, never its own text.
        const { code, message, causeCode } = toGatewayError(err);
        const error = { code, message, ...(causeCode ? { causeCode } : {}) };
        res.end(`${JSON.stringify({ error })}\n`);
      }
    })().catch((err: unknown) => {
      // No run's secret values are known here, so only the name and declared code are logged.
      logUnexpectedError(httpLog, err, undefined, "native gateway HTTP handler failed");
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

/** /coding-mcp: one JSON-RPC message per POST, answered as one JSON body (or 202 with none). */
async function serveCodingMcp(req: IncomingMessage, res: ServerResponse, deps: CodingMcpDeps): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    res.setHeader("content-type", "application/json");
    res.writeHead(405);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Use POST." } }));
    return;
  }
  let body: string;
  try {
    body = await readLimitedBody(req, HTTP_LIMITS.json, AbortSignal.timeout(HTTP_LIMITS.requestMs));
  } catch (err) {
    const status = err instanceof HttpBoundaryError ? err.status : 400;
    res.setHeader("content-type", "application/json");
    res.writeHead(status);
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "The request body could not be read." },
      }),
    );
    // A body left unread would otherwise keep the socket busy.
    if (status === 413) req.resume();
    return;
  }
  // The proxy gives up on a call at its forward limit (or its worker goes away): the closed response
  // aborts the call in flight rather than leave it running against the MCP server.
  const closed = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) closed.abort();
  });
  const response = await handleCodingMcpRequest(req.headers.authorization, body, deps, closed.signal);
  if (closed.signal.aborted) return;
  res.setHeader("content-type", response.contentType);
  res.writeHead(response.status);
  res.end(response.body);
}

/** Starts the listener; resolves once it is accepting connections. */
export async function startGatewayServer(listen: NativeGatewayListen, deps: GatewayServerDeps): Promise<Server> {
  const server = createGatewayServer(deps);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port, listen.host, () => resolve());
  });
  httpLog.info({ host: listen.host, port: listen.port }, "native sandbox gateway listening");
  return server;
}
