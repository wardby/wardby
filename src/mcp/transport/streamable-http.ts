/**
 * Streamable HTTP transport: single `/mcp` endpoint on node:http, backed by
 * the real SDK's `createMcpHandler` + `@modelcontextprotocol/node`'s
 * `toNodeHandler` (correct era negotiation, SSE upgrade, and backpressure
 * handling — no reason to hand-roll any of that). This file's own job is
 * everything AROUND the MCP exchange: Origin validation, our own
 * resource-server auth gate (Task 5), the always-on PRM well-known route,
 * and (self-hosted only) the AS's well-known + /authorize + /token +
 * /register routes.
 *
 * Auth threading into tool handlers: `req.auth` (read by toNodeHandler,
 * forwarded as `AuthInfo`) carries the resolved Principal in `extra` — see
 * server.ts's resolveCtx, which reads exactly this shape back out.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler, type PerRequestResponseMode } from "@modelcontextprotocol/server";
import { toNodeHandler, localhostOriginValidation } from "@modelcontextprotocol/node";
import type { PrismaClient } from "@prisma/client";
import type { AuthProvider } from "../../providers/auth/types.js";
import type { SelfHostedAuthProvider } from "../../providers/auth/self-hosted.js";
import type { ReevoMcpServer } from "../server.js";
import type { McpProviders } from "../context.js";
import { authenticate, protectedResourceMetadata, protectedResourceMetadataUrl } from "../auth/resource-server.js";
import { McpError } from "../errors.js";
import { handleWebhookIngress } from "../webhooks/ingress.js";

export interface HttpServerConfig {
  canonicalUri: string;
  httpBind: { host: string; port: number };
  authProviderKind: "delegating" | "self-hosted";
  responseMode?: PerRequestResponseMode;
}

export interface StartHttpServerOptions {
  mcp: ReevoMcpServer;
  config: HttpServerConfig;
  auth: { authProvider: AuthProvider; db: PrismaClient; providers: McpProviders };
  /** Required when config.authProviderKind === "self-hosted" — the same instance as auth.authProvider, narrowed. */
  selfHosted?: SelfHostedAuthProvider;
}

export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function startHttpServer(opts: StartHttpServerOptions): Promise<HttpServerHandle> {
  if (opts.config.authProviderKind === "self-hosted" && !opts.selfHosted) {
    throw new Error("startHttpServer: config.authProviderKind is self-hosted but opts.selfHosted was not provided.");
  }

  const mcpHandler = createMcpHandler(opts.mcp.factory, { responseMode: opts.config.responseMode });
  const nodeHandler = toNodeHandler(mcpHandler);
  const validateOrigin = localhostOriginValidation();
  const resourceMetadataUrl = protectedResourceMetadataUrl(opts.config.canonicalUri);

  const server = createServer(async (req, res) => {
    if (!validateOrigin(req, res)) return;

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Always-on discovery route (RFC 9728) — no auth.
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
      const authorizationServers =
        opts.config.authProviderKind === "self-hosted" ? [opts.config.canonicalUri] : [];
      sendJson(res, 200, protectedResourceMetadata({ canonicalUri: opts.config.canonicalUri, authorizationServers }));
      return;
    }

    if (opts.config.authProviderKind === "self-hosted") {
      const selfHosted = opts.selfHosted!;
      if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
        sendJson(res, 200, selfHosted.asMetadata());
        return;
      }
      if (url.pathname === "/register" && req.method === "POST") {
        try {
          const body = JSON.parse(await readBody(req)) as {
            redirect_uris?: string[];
            client_name?: string;
            grant_types?: string[];
            token_endpoint_auth_method?: "none" | "client_secret_post";
          };
          const client = await selfHosted.registerClient({
            redirectUris: body.redirect_uris ?? [],
            clientName: body.client_name,
            grantTypes: body.grant_types,
            tokenEndpointAuthMethod: body.token_endpoint_auth_method,
          });
          sendJson(res, 201, { client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) });
        } catch (err) {
          sendJson(res, 400, { error: "invalid_client_metadata", error_description: message(err) });
        }
        return;
      }
      if (url.pathname === "/authorize" && req.method === "GET") {
        try {
          const result = await selfHosted.handleAuthorize({
            clientId: url.searchParams.get("client_id") ?? "",
            redirectUri: url.searchParams.get("redirect_uri") ?? "",
            codeChallenge: url.searchParams.get("code_challenge") ?? "",
            codeChallengeMethod: "S256",
            scope: url.searchParams.get("scope") ?? "",
            resource: url.searchParams.get("resource") ?? opts.config.canonicalUri,
            subject: url.searchParams.get("subject") ?? "",
            state: url.searchParams.get("state") ?? undefined,
          });
          const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
          redirect.searchParams.set("code", result.code);
          redirect.searchParams.set("iss", result.iss);
          if (result.state) redirect.searchParams.set("state", result.state);
          res.writeHead(302, { location: redirect.href }).end();
        } catch (err) {
          sendJson(res, 400, { error: "invalid_request", error_description: message(err) });
        }
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        try {
          const params = new URLSearchParams(await readBody(req));
          const grantType = params.get("grant_type");
          const clientId = params.get("client_id") ?? "";
          const result =
            grantType === "refresh_token"
              ? await selfHosted.handleToken({ grantType: "refresh_token", refreshToken: params.get("refresh_token") ?? "", clientId })
              : await selfHosted.handleToken({
                  grantType: "authorization_code",
                  code: params.get("code") ?? "",
                  codeVerifier: params.get("code_verifier") ?? "",
                  redirectUri: params.get("redirect_uri") ?? "",
                  clientId,
                });
          sendJson(res, 200, {
            access_token: result.accessToken,
            token_type: result.tokenType,
            expires_in: result.expiresIn,
            ...(result.refreshToken ? { refresh_token: result.refreshToken } : {}),
            scope: result.scope,
          });
        } catch (err) {
          sendJson(res, 400, { error: "invalid_grant", error_description: message(err) });
        }
        return;
      }
    }

    // Webhook ingress: authenticated by the per-webhook secret only, never
    // OAuth — a narrow, single-route exception to auth being required on
    // every non-discovery endpoint, matching the design's own carve-out.
    const webhookMatch = /^\/webhooks\/([^/]+)$/.exec(url.pathname);
    if (webhookMatch && req.method === "POST") {
      let body: Record<string, unknown> = {};
      try {
        const raw = await readBody(req);
        if (raw) body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Malformed body is fine — the secret may have arrived via header instead.
      }
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key] = Array.isArray(value) ? value[0] : value;
      }
      const result = await handleWebhookIngress(webhookMatch[1], { headers, body }, opts.auth.db);
      sendJson(res, result.status, result.body);
      return;
    }

    if (url.pathname === "/mcp") {
      let ctx;
      try {
        ctx = await authenticate(
          { authorization: req.headers.authorization },
          { authProvider: opts.auth.authProvider, db: opts.auth.db, providers: opts.auth.providers, canonicalUri: opts.config.canonicalUri },
        );
      } catch (err) {
        if (err instanceof McpError) {
          sendJson(res, err.httpStatus, { error: "invalid_token", error_description: err.message }, err.wwwAuthenticate ? { "www-authenticate": err.wwwAuthenticate } : {});
          return;
        }
        throw err;
      }
      (req as IncomingMessage & { auth?: unknown }).auth = {
        token: "",
        clientId: ctx.principal.subject,
        scopes: [...ctx.scopes],
        extra: { principal: ctx.principal },
      };
      await nodeHandler(req, res);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve) => server.listen(opts.config.httpBind.port, opts.config.httpBind.host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.config.httpBind.port;

  return {
    port,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
