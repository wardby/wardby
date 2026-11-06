/**
 * The coding proxy's /mcp route (remote MCP servers, phase 2): the worker's MCP server URL. It
 * checks the run's MCP token (`rmt_…`, WARDBY_MCP_TOKEN in the worker) against the proxy session,
 * then forwards the JSON-RPC body unchanged, with the same Authorization, to the native gateway's
 * /coding-mcp route (WARDBY_MCP_GATEWAY_URL), which checks the token again and runs the call. The
 * proxy never sees an MCP server URL or secret; the gateway redacts results before they get here.
 *
 * Secrets: the token is only hashed and forwarded, never logged or echoed. The route's log line
 * carries the session id, a sanitized JSON-RPC method, the status and a fixed reason code only:
 * never the body, the token or an error's text. Every body this route writes is fixed text or the
 * gateway's answer, unchanged.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isMcpToken, mcpTokenHash, MCP_TOKEN_REQUIRED_MESSAGE } from "../../coding/mcp-token.js";
import { logger } from "../../core/logger.js";
import { HTTP_LIMITS, HttpBoundaryError, readBodyBytes } from "../../mcp/transport/http-limits.js";
import type { ProxyLedger } from "./types.js";

export const MCP_ROUTE_PATH = "/mcp";
/** The gateway's route this one forwards to. */
const GATEWAY_PATH = "/coding-mcp";
/** The longest a forwarded call may take, when the session's deadline is later. */
export const MCP_FORWARD_MAX_MS = 5 * 60_000;
/** The largest gateway answer relayed (a tool result is text the model reads; same as a model request). */
const MAX_GATEWAY_RESPONSE_BYTES = 8 * 1024 * 1024;

export const MCP_UNAVAILABLE_MESSAGE = "MCP tools aren't available on this server.";
const MCP_UNREACHABLE_MESSAGE = "MCP tools can't be reached right now.";

const LOG_METHOD = /^[A-Za-z/_]+$/;

/**
 * A JSON-RPC method as the log may carry it: its first 64 characters when they are letters, `/`
 * and `_` only, else "other". Anything that starts like an MCP token is "other" too.
 */
export function mcpLogMethod(value: unknown): string {
  if (typeof value !== "string") return "other";
  const method = value.slice(0, 64);
  return LOG_METHOD.test(method) && !method.includes("rmt_") ? method : "other";
}

function methodOf(body: Buffer): string {
  try {
    const message: unknown = JSON.parse(body.toString("utf8"));
    return mcpLogMethod((message as { method?: unknown } | null)?.method);
  } catch {
    return "other";
  }
}

export interface McpRouteOptions {
  ledger: Pick<ProxyLedger, "findSessionByMcpTokenHash">;
  /** The native gateway's base URL; without one, /mcp answers 503 mcp_unavailable. */
  gatewayUrl: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: { info(fields: Record<string, unknown>, message: string): void };
}

type Reason = "gateway_timeout" | "gateway_unreachable" | "gateway_response_too_large" | "client_disconnected";

class GatewayError extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

const rpcError = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });

async function readGatewayBody(response: Response): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_GATEWAY_RESPONSE_BYTES) {
      void response.body.cancel().catch(() => undefined);
      throw new GatewayError("gateway_response_too_large");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

export function createMcpRoute(options: McpRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? logger.child({ module: "coding-proxy" });
  const gatewayUrl = options.gatewayUrl?.replace(/\/+$/, "");

  return async (req, res) => {
    const startedAt = performance.now();
    const seen: { sessionId?: string; method?: string; reason?: Reason } = {};
    /** Refused before the body was read: close the connection rather than read what is still coming. */
    const closeIfBodyUnread = () => {
      if (!req.complete && !res.headersSent) res.setHeader("connection", "close");
    };
    const send = (status: number, body: string | Buffer, headers: Record<string, string> = JSON_HEADERS) => {
      res.writeHead(status, headers).end(body);
    };
    try {
      if (req.method !== "POST") {
        closeIfBodyUnread();
        res.setHeader("allow", "POST");
        if (req.method === "HEAD") res.writeHead(405, JSON_HEADERS).end();
        else send(405, rpcError(-32600, "Use POST."));
        return;
      }
      if (!gatewayUrl) {
        closeIfBodyUnread();
        send(503, JSON.stringify({ error: "mcp_unavailable", message: MCP_UNAVAILABLE_MESSAGE }));
        return;
      }
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      const session = isMcpToken(token)
        ? await options.ledger.findSessionByMcpTokenHash(mcpTokenHash(token))
        : undefined;
      const at = now().getTime();
      if (!session || session.status !== "active" || at >= session.deadlineAt.getTime()) {
        // No WWW-Authenticate: a client must not start OAuth discovery against this route.
        closeIfBodyUnread();
        send(401, rpcError(-32001, MCP_TOKEN_REQUIRED_MESSAGE));
        return;
      }
      seen.sessionId = session.id;
      if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        closeIfBodyUnread();
        send(415, rpcError(-32600, "Send one JSON-RPC message as application/json."));
        return;
      }
      let body: Buffer;
      try {
        body = await readBodyBytes(req, HTTP_LIMITS.json, AbortSignal.timeout(HTTP_LIMITS.requestMs));
      } catch (error) {
        closeIfBodyUnread();
        send(
          error instanceof HttpBoundaryError ? error.status : 400,
          rpcError(-32600, "The request body could not be read."),
        );
        return;
      }
      seen.method = methodOf(body);

      // The call may take as long as it needs, up to the run's deadline or MCP_FORWARD_MAX_MS. The
      // server's requestTimeout covers receiving the request only, which is over by now.
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new GatewayError("gateway_timeout")),
        Math.min(MCP_FORWARD_MAX_MS, session.deadlineAt.getTime() - at),
      );
      const clientGone = () => {
        if (!res.writableFinished) controller.abort(new GatewayError("client_disconnected"));
      };
      res.once("close", clientGone);
      try {
        const upstream = await fetchImpl(`${gatewayUrl}${GATEWAY_PATH}`, {
          method: "POST",
          headers: { authorization: req.headers.authorization!, "content-type": "application/json" },
          body: new Uint8Array(body),
          redirect: "error",
          signal: controller.signal,
        });
        const answer = await readGatewayBody(upstream);
        send(upstream.status, answer, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        });
      } catch (error) {
        const reason = controller.signal.reason instanceof GatewayError ? controller.signal.reason.reason : undefined;
        throw error instanceof GatewayError ? error : new GatewayError(reason ?? "gateway_unreachable");
      } finally {
        clearTimeout(timer);
        res.off("close", clientGone);
      }
    } catch (error) {
      // Nothing of the error's text leaves or is logged: only a fixed reason code.
      seen.reason = error instanceof GatewayError ? error.reason : "gateway_unreachable";
      if (!res.headersSent) send(502, JSON.stringify({ error: "mcp_unavailable", message: MCP_UNREACHABLE_MESSAGE }));
      else res.destroy();
    } finally {
      log.info(
        {
          event: "mcp.request",
          ...(seen.sessionId ? { sessionId: seen.sessionId } : {}),
          ...(seen.method ? { method: seen.method } : {}),
          status: res.statusCode,
          ...(seen.reason ? { reason: seen.reason } : {}),
          durationMs: Math.round(performance.now() - startedAt),
        },
        "coding proxy mcp request",
      );
    }
  };
}
