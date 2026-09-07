import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createMcpHandler, type PerRequestResponseMode } from "@modelcontextprotocol/server";
import { toNodeHandler, hostHeaderValidation } from "@modelcontextprotocol/node";
import type { PrismaClient } from "@prisma/client";
import type { AuthProvider } from "../../providers/auth/types.js";
import type { SelfHostedAuthProvider } from "../../providers/auth/self-hosted.js";
import type { ReevoMcpServer } from "../server.js";
import type { McpProviders } from "../context.js";
import { authenticate, protectedResourceMetadata } from "../auth/resource-server.js";
import { McpError } from "../errors.js";
import { handleWebhookIngress } from "../webhooks/ingress.js";
import { canonicalUrl, HTTP_LIMITS, HttpBoundaryError, parseBody, readBody } from "./http-limits.js";
import { browserHandler } from "../auth/self-hosted/browser.js";
import { handleSecretElicitationForm, SECRET_ELICITATION_PATH } from "../tools/secret-elicitation-form.js";
import { logger } from "../../core/logger.js";

const httpLog = logger.child({ module: "streamable-http" });

export interface HttpServerConfig {
  canonicalUri: string;
  httpBind: { host: string; port: number };
  authProviderKind: "delegating" | "self-hosted";
  authorizationServer?: string;
  allowedOrigins?: string[];
  responseMode?: PerRequestResponseMode;
}
export interface StartHttpServerOptions {
  mcp: ReevoMcpServer;
  config: HttpServerConfig;
  auth: { authProvider: AuthProvider; db: PrismaClient; providers: McpProviders };
  selfHosted?: SelfHostedAuthProvider;
}
export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res
    .writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers })
    .end(JSON.stringify(body));
}

export async function startHttpServer(opts: StartHttpServerOptions): Promise<HttpServerHandle> {
  const canonical = canonicalUrl(opts.config.canonicalUri);
  if (opts.config.authProviderKind === "self-hosted" && !opts.selfHosted)
    throw new Error("Missing self-hosted provider.");
  const oauth = opts.config.authProviderKind === "self-hosted" ? browserHandler(opts.selfHosted!) : undefined;
  const origins = new Set([
    canonical.origin,
    ...(opts.config.allowedOrigins ?? []).map((value) => {
      const url = canonicalUrl(value);
      if (url.origin !== value) throw new Error("Allowed origins must be exact origins without paths.");
      return value;
    }),
  ]);
  const validateHost = hostHeaderValidation([canonical.hostname]);
  const nodeHandler = toNodeHandler(createMcpHandler(opts.mcp.factory, { responseMode: opts.config.responseMode }));
  const server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: false }, (req, res) => {
    void route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof McpError) {
        sendJson(
          res,
          err.httpStatus,
          { error: "invalid_token" },
          err.wwwAuthenticate ? { "www-authenticate": err.wwwAuthenticate } : {},
        );
      } else if (err instanceof HttpBoundaryError) {
        res.shouldKeepAlive = false;
        // Drain without buffering while the error response flushes, then bound socket cleanup.
        req.resume();
        const timer = setTimeout(() => req.destroy(), 1000);
        timer.unref();
        req.socket.once("close", () => clearTimeout(timer));
        sendJson(res, err.status, { error: err.message }, { connection: "close" });
      } else {
        const id = randomUUID();
        httpLog.error({ err, requestId: id }, "HTTP request failed");
        sendJson(res, 500, { error: "internal_error", id });
      }
    });
  });
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hostCount = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "host").length;
    if (hostCount !== 1 || req.headers.host?.toLowerCase() !== canonical.host || !validateHost(req, res)) {
      if (!res.headersSent) sendJson(res, 403, { error: "invalid_host" }, { connection: "close" });
      return;
    }
    if (req.headers.origin && !origins.has(req.headers.origin)) {
      sendJson(res, 403, { error: "invalid_origin" }, { connection: "close" });
      return;
    }
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw new HttpBoundaryError(400, "invalid_target");
    const url = new URL(req.url, canonical.origin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_LIMITS.requestMs);
    let body: unknown;
    try {
      const hasBody =
        req.method === "POST" ||
        req.method === "PUT" ||
        req.method === "PATCH" ||
        req.headers["content-length"] ||
        req.headers["transfer-encoding"];
      if (hasBody) {
        const limit =
          url.pathname === "/mcp" || url.pathname.startsWith("/webhooks/") ? HTTP_LIMITS.json : HTTP_LIMITS.auth;
        const raw = await readBody(req, limit, controller.signal);
        body = parseBody(raw, req.headers["content-type"]);
      }
    } finally {
      clearTimeout(timer);
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname ===
          "/.well-known/oauth-protected-resource" + (canonical.pathname === "/" ? "" : canonical.pathname))
    ) {
      const authorizationServers =
        opts.config.authProviderKind === "self-hosted"
          ? [canonical.href]
          : [opts.config.authorizationServer].filter((s): s is string => !!s);
      sendJson(res, 200, protectedResourceMetadata({ canonicalUri: canonical.href, authorizationServers }));
      return;
    }
    if (url.pathname === SECRET_ELICITATION_PATH && (req.method === "GET" || req.method === "POST")) {
      await handleSecretElicitationForm(
        req.method,
        url.searchParams.get("t"),
        () => Promise.resolve(body instanceof URLSearchParams ? body : new URLSearchParams()),
        res,
        {
          verify: (token) => opts.mcp.verifyRequestState(token),
          secrets: opts.auth.providers.secrets,
          db: opts.auth.db,
        },
      );
      return;
    }
    if (oauth && (await oauth(req, res, url, body))) return;
    const webhook = /^\/webhooks\/([^/]+)$/.exec(url.pathname);
    if (webhook && req.method === "POST") {
      if (!body || Array.isArray(body) || body instanceof URLSearchParams)
        throw new HttpBoundaryError(415, "expected_json_object");
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
      const result = await handleWebhookIngress(
        webhook[1],
        { headers, body: body as Record<string, unknown> },
        opts.auth.db,
        opts.auth.providers.executor,
      );
      sendJson(res, result.status, result.body);
      return;
    }
    if (url.pathname === "/mcp") {
      if (req.method === "POST" && (!body || body instanceof URLSearchParams))
        throw new HttpBoundaryError(415, "expected_json");
      const ctx = await authenticate(
        { authorization: req.headers.authorization },
        { ...opts.auth, canonicalUri: canonical.href },
      );
      (req as IncomingMessage & { auth?: unknown }).auth = {
        token: "",
        clientId: ctx.principal.subject,
        scopes: [...ctx.scopes],
        extra: { principal: ctx.principal },
      };
      await nodeHandler(req, res, body);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  }
  server.requestTimeout = HTTP_LIMITS.requestMs;
  server.headersTimeout = HTTP_LIMITS.headersMs;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  const cleanupTimer =
    opts.config.authProviderKind === "self-hosted"
      ? setInterval(() => {
          void opts.selfHosted!.cleanup().catch((err) => httpLog.error({ err }, "OAuth cleanup failed"));
        }, 15 * 60_000)
      : undefined;
  cleanupTimer?.unref();
  server.once("close", () => clearInterval(cleanupTimer));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.config.httpBind.port, opts.config.httpBind.host, resolve);
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : opts.config.httpBind.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
