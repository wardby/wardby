// In-process fake OAuth authorization server plus a protected MCP endpoint, for tests of the
// OAuth client. It mimics a hosted MCP server whose protected-resource metadata lives only at
// the root well-known path. Tokens are deterministic (`fake-access-<n>`, `fake-refresh-<n>`),
// and a spent or revoked refresh token is deliberately echoed in `error_description` so tests
// can prove it is redacted. Test-only: excluded from the production build.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOAuthServer {
  /** Origin, e.g. http://127.0.0.1:PORT. */
  url: string;
  /** The plain-http origin it listens on, http://127.0.0.1:PORT (the same as `url` without `publicHost`). */
  listenUrl: string;
  /** `${url}/mcp`, protected. */
  mcpUrl: string;
  accessTtlSeconds: number;
  rotateRefresh: boolean;
  revoked: Set<string>;
  /** Refresh-token grant calls counted. */
  tokenRequests: number;
  /** Approves an authorize URL as the fake user; returns the callback URL wardby would receive. */
  approve(authorizeUrl: string): Promise<string>;
  close(): Promise<void>;
}

interface CodeGrant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource?: string;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeOAuthServer(
  opts: {
    revocation?: boolean;
    dcr?: boolean;
    s256?: boolean;
    /**
     * A hostname the metadata advertises instead of 127.0.0.1 (e.g. `oauth.fake.test`), so a
     * client must reach the server through its own resolver. `approve` still connects to the
     * listen address.
     */
    publicHost?: string;
    /**
     * The scheme the metadata advertises with `publicHost` (default http). With "https" the origin is
     * `https://<publicHost>` on the default port, and a client reaches the server through a fetch
     * that maps it onto `listenUrl`, as a TLS front would; the paths that refuse plain http (or a
     * non-default https port) then run unchanged.
     */
    publicScheme?: "http" | "https";
    /**
     * Opt-in: a refresh must name a client the server registered, by `client_id` in the form or
     * HTTP Basic credentials; any other answers 401 `invalid_client`.
     */
    checkClient?: boolean;
  } = {},
): Promise<FakeOAuthServer> {
  const revocation = opts.revocation ?? true;
  const dcr = opts.dcr ?? true;
  const withS256 = opts.s256 ?? true;

  const clients = new Set<string>();
  const codes = new Map<string, CodeGrant>();
  const activeRefresh = new Set<string>();
  const accessExpiry = new Map<string, number>();
  const accessByRefresh = new Map<string, string[]>();
  let counter = 0;
  let origin = "";
  let listenOrigin = "";

  function issue(existingRefresh?: string): { access: string; refresh: string } {
    counter += 1;
    const access = `fake-access-${counter}`;
    const refresh = existingRefresh ?? `fake-refresh-${counter}`;
    accessExpiry.set(access, Date.now() + server.accessTtlSeconds * 1000);
    activeRefresh.add(refresh);
    accessByRefresh.set(refresh, [...(accessByRefresh.get(refresh) ?? []), access]);
    return { access, refresh };
  }

  function tokenResponse(access: string, refresh: string): Record<string, unknown> {
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: server.accessTtlSeconds,
      refresh_token: refresh,
      scope: "read",
    };
  }

  function bearerOf(req: IncomingMessage): string | undefined {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "");
    return m?.[1];
  }

  /** The client id of HTTP Basic client credentials (RFC 6749 section 2.3.1), when sent. */
  function basicClientId(req: IncomingMessage): string | undefined {
    const m = /^Basic (.+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return undefined;
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const id = decoded.slice(0, Math.max(0, decoded.indexOf(":")));
    return new URLSearchParams(`v=${id}`).get("v") ?? undefined;
  }

  function bearerValid(token: string | undefined): token is string {
    if (!token || server.revoked.has(token)) return false;
    const exp = accessExpiry.get(token);
    return exp !== undefined && Date.now() < exp;
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(req));
    const grant = form.get("grant_type");
    const clientId = form.get("client_id") ?? "";
    const resource = form.get("resource");
    if (resource !== null && resource !== server.mcpUrl) {
      sendJson(res, 400, { error: "invalid_target", error_description: "unknown resource" });
      return;
    }
    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const g = codes.get(code);
      codes.delete(code);
      const verifier = form.get("code_verifier") ?? "";
      if (
        !g ||
        g.clientId !== clientId ||
        g.redirectUri !== (form.get("redirect_uri") ?? "") ||
        (withS256 && s256(verifier) !== g.challenge) ||
        (g.resource !== undefined && resource !== g.resource)
      ) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "bad code or verifier" });
        return;
      }
      const t = issue();
      sendJson(res, 200, tokenResponse(t.access, t.refresh));
      return;
    }
    if (grant === "refresh_token") {
      server.tokenRequests += 1;
      if (opts.checkClient && !clients.has(basicClientId(req) ?? clientId)) {
        sendJson(res, 401, { error: "invalid_client", error_description: "unknown client" });
        return;
      }
      const refresh = form.get("refresh_token") ?? "";
      if (!activeRefresh.has(refresh) || server.revoked.has(refresh)) {
        sendJson(res, 400, { error: "invalid_grant", error_description: refresh });
        return;
      }
      if (server.rotateRefresh) {
        activeRefresh.delete(refresh);
        const t = issue();
        sendJson(res, 200, tokenResponse(t.access, t.refresh));
      } else {
        const t = issue(refresh);
        sendJson(res, 200, tokenResponse(t.access, t.refresh));
      }
      return;
    }
    sendJson(res, 400, { error: "unsupported_grant_type" });
  }

  async function handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = new URLSearchParams(await readBody(req)).get("token") ?? "";
    if (token) {
      server.revoked.add(token);
      activeRefresh.delete(token);
      for (const a of accessByRefresh.get(token) ?? []) server.revoked.add(a);
    }
    res.writeHead(200).end();
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = bearerOf(req);
    if (!bearerValid(token)) {
      await readBody(req);
      sendJson(
        res,
        401,
        { error: "unauthorized" },
        {
          "www-authenticate": `Bearer realm="${server.mcpUrl}", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        },
      );
      return;
    }
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(await readBody(req)) as typeof msg;
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result: unknown): void => sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") {
      reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-oauth-mcp", version: "1.0.0" },
      });
    } else if (msg.method === "tools/list") {
      reply({
        tools: [
          {
            name: "echo",
            description: "Echo the arguments and the bearer token seen.",
            inputSchema: { type: "object", additionalProperties: true },
          },
        ],
      });
    } else if (msg.method === "tools/call" && msg.params?.name === "echo") {
      reply({
        content: [{ type: "text", text: JSON.stringify({ args: msg.params.arguments ?? {}, bearer: token }) }],
      });
    } else {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "method not found" },
      });
    }
  }

  const http = createServer((req, res) => {
    const u = new URL(req.url ?? "/", origin || "http://127.0.0.1");
    const route = `${req.method} ${u.pathname}`;
    const run = async (): Promise<void> => {
      switch (route) {
        case "GET /.well-known/oauth-protected-resource":
          sendJson(res, 200, {
            resource: server.mcpUrl,
            authorization_servers: [origin],
            scopes_supported: ["read", "write", "admin"],
            bearer_methods_supported: ["header"],
          });
          return;
        case "GET /.well-known/oauth-authorization-server":
          sendJson(res, 200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            ...(dcr ? { registration_endpoint: `${origin}/register` } : {}),
            ...(revocation ? { revocation_endpoint: `${origin}/revoke` } : {}),
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            ...(withS256 ? { code_challenge_methods_supported: ["S256"] } : {}),
            token_endpoint_auth_methods_supported: ["none"],
          });
          return;
        case "POST /register": {
          if (!dcr) break;
          const clientId = `fake-client-${randomUUID()}`;
          clients.add(clientId);
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          } catch {
            /* empty registration */
          }
          sendJson(res, 201, { ...body, client_id: clientId, token_endpoint_auth_method: "none" });
          return;
        }
        case "GET /authorize": {
          const q = u.searchParams;
          const clientId = q.get("client_id") ?? "";
          const redirectUri = q.get("redirect_uri") ?? "";
          const challenge = q.get("code_challenge") ?? "";
          if (
            q.get("response_type") !== "code" ||
            !redirectUri ||
            (dcr && !clients.has(clientId)) ||
            (withS256 && (!challenge || q.get("code_challenge_method") !== "S256"))
          ) {
            sendJson(res, 400, { error: "invalid_request" });
            return;
          }
          const code = `fake-code-${randomUUID()}`;
          const resource = q.get("resource") ?? undefined;
          codes.set(code, { clientId, redirectUri, challenge, ...(resource ? { resource } : {}) });
          const loc = new URL(redirectUri);
          loc.searchParams.set("code", code);
          const state = q.get("state");
          if (state !== null) loc.searchParams.set("state", state);
          res.writeHead(302, { location: loc.toString() }).end();
          return;
        }
        case "POST /token":
          await handleToken(req, res);
          return;
        case "POST /revoke":
          if (!revocation) break;
          await handleRevoke(req, res);
          return;
        case "POST /mcp":
          await handleMcp(req, res);
          return;
      }
      sendJson(res, 404, { error: "not_found" });
    };
    run().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
      else res.end();
    });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  listenOrigin = `http://127.0.0.1:${port}`;
  origin = !opts.publicHost
    ? listenOrigin
    : opts.publicScheme === "https"
      ? `https://${opts.publicHost}`
      : `http://${opts.publicHost}:${port}`;

  const server: FakeOAuthServer = {
    url: origin,
    listenUrl: listenOrigin,
    mcpUrl: `${origin}/mcp`,
    accessTtlSeconds: 3600,
    rotateRefresh: true,
    revoked: new Set<string>(),
    tokenRequests: 0,
    async approve(authorizeUrl: string): Promise<string> {
      const target = new URL(authorizeUrl);
      const listen = new URL(listenOrigin);
      if (target.origin === origin) {
        target.protocol = listen.protocol;
        target.host = listen.host;
      }
      const r = await fetch(target, { redirect: "manual" });
      const loc = r.headers.get("location");
      if (r.status !== 302 || !loc) {
        throw new Error(`authorize not approved: HTTP ${r.status}`);
      }
      return loc;
    },
    close(): Promise<void> {
      http.closeAllConnections();
      return new Promise((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
    },
  };
  return server;
}
