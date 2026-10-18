/**
 * The native sandbox gateway's internal HTTP listener (NATIVE_GATEWAY_LISTEN).
 * Deliberately separate from the public MCP/webhook server: only sandbox
 * workers reach it (deployment network policy allows worker → this port and
 * nothing else), and every request carries a one-run bearer capability.
 *
 *   POST /native-gateway/v1/call   body: GatewayRequest
 *   → application/json            { ok: true, result } | { ok: false, error: { code, message } }
 *   → application/x-ndjson        (llm.stream) { event } … then { end: true } or { error: { code, message, causeCode? } }
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { logger } from "../core/logger.js";
import { logUnexpectedError } from "./gateway.js";
import { serveGatewayRequest, type GatewayServerDeps } from "./gateway-server.js";
import { GatewayError, MAX_MESSAGE_BYTES, toGatewayError } from "./protocol.js";

/** The HTTP listener's own log. Exported so tests can watch it. */
export const httpLog = logger.child({ module: "native-gateway-http" });

export const NATIVE_GATEWAY_PATH = "/native-gateway/v1/call";

export interface NativeGatewayListen {
  host: string;
  port: number;
}

/** Parses NATIVE_GATEWAY_LISTEN ("host:port" or ":port"); undefined when unset. */
export function parseGatewayListen(value: string | undefined): NativeGatewayListen | undefined {
  if (!value) return undefined;
  const match = /^(.*):(\d{1,5})$/.exec(value.trim());
  const port = match ? Number(match[2]) : NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`NATIVE_GATEWAY_LISTEN must be host:port or :port (got "${value}").`);
  }
  return { host: match[1] || "0.0.0.0", port };
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
