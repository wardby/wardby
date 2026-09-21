import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import type { SelfHostedAuthProvider } from "../../../providers/auth/self-hosted.js";
import { PostgresRateLimiter, RateLimitError } from "./rate-limit.js";
import { logger } from "../../../core/logger.js";

const authLog = logger.child({ module: "self-hosted-oauth" });

const paths = new Set([
  "/login",
  "/consent",
  "/logout",
  "/authorize",
  "/register",
  "/token",
  "/revoke",
  "/.well-known/oauth-authorization-server",
]);
function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
// CORS-mode same-origin fetch retains Origin under no-referrer, unlike native form POSTs.
const FORM_SCRIPT = `document.addEventListener('submit', async (event) => {
  const form = event.target;
  event.preventDefault();
  const body = new URLSearchParams(new FormData(form, event.submitter));
  try {
    const response = await fetch(form.action, { method: 'POST', mode: 'cors', credentials: 'same-origin', headers: { 'accept': 'application/json' }, body });
    const data = await response.json();
    if (response.ok && typeof data.redirect === 'string') { location.assign(data.redirect); return; }
  } catch {}
  document.getElementById('auth-error').textContent = 'Unable to complete the request. Reload this page and try again.';
});`;
function html(res: ServerResponse, content: string) {
  const nonce = randomBytes(18).toString("base64");
  res.setHeader(
    "content-security-policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  res
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>wardby authorization</title><body>' +
        content +
        '<p id="auth-error" role="alert"></p><noscript>JavaScript is required for secure form submission.</noscript><script nonce="' +
        nonce +
        '">' +
        FORM_SCRIPT +
        "</script></body></html>",
    );
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
function redirect(res: ServerResponse, location: string, req?: IncomingMessage) {
  if (req?.method === "POST" && req.headers.accept === "application/json") {
    json(res, 200, { redirect: location });
    return;
  }
  res.writeHead(303, { location }).end();
}
function hidden(name: string, value: string) {
  return `<input type="hidden" name="${name}" value="${escape(value)}">`;
}

export function browserHandler(provider: SelfHostedAuthProvider) {
  const canonical = new URL(provider.config.canonicalUri);
  const secure = canonical.protocol === "https:";
  const sessionName = secure ? "__Host-wardby-session" : "wardby-dev-session";
  const loginName = secure ? "__Host-wardby-login" : "wardby-dev-login";
  const limiter = new PostgresRateLimiter(provider.db, provider.credentials);
  const cookie = (name: string, value: string, sameSite: string, age: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${age}${secure ? "; Secure" : ""}`;
  return async (req: IncomingMessage, res: ServerResponse, url: URL, body: unknown): Promise<boolean> => {
    if (!paths.has(url.pathname)) return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    try {
      const cookies = new Map<string, string>();
      for (const part of (req.headers.cookie ?? "").split(";")) {
        const [key, ...value] = part.trim().split("=");
        if (cookies.has(key)) throw new Error("duplicate cookie");
        cookies.set(key, value.join("="));
      }
      for (const key of url.searchParams.keys())
        if (url.searchParams.getAll(key).length !== 1) throw new Error("duplicate query parameter");
      const ip = req.socket.remoteAddress ?? "unknown";
      await limiter.check("auth-ip", ip, 120);
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        json(res, 200, provider.asMetadata());
        return true;
      }
      if (req.method === "POST" && url.pathname === "/register") {
        await limiter.check("registration", ip, 10);
        if (!body || typeof body !== "object" || body instanceof URLSearchParams || Array.isArray(body))
          throw new Error("JSON object body required");
        const p = body as Record<string, unknown>;
        if (
          Object.keys(p).some(
            (k) =>
              ![
                "redirect_uris",
                "client_name",
                "grant_types",
                "token_endpoint_auth_method",
                "response_types",
                "scope",
                "application_type",
              ].includes(k),
          )
        )
          throw new Error("unsupported registration field");
        if (p.response_types && JSON.stringify(p.response_types) !== '["code"]')
          throw new Error("unsupported response_types");
        // Claude Code sends both of the following. Neither is stored.
        // RFC 7591 `scope`: scopes are requested and consented per
        // authorization at /authorize, never fixed at registration.
        if (p.scope !== undefined && (typeof p.scope !== "string" || p.scope.length > 512))
          throw new Error("invalid scope");
        // OIDC Dynamic Client Registration `application_type`: every client
        // here is already a public PKCE client with validated redirect URIs.
        if (p.application_type !== undefined && p.application_type !== "native" && p.application_type !== "web")
          throw new Error("unsupported application_type");
        const registered = await provider.registerClient({
          redirectUris: p.redirect_uris as string[],
          clientName: p.client_name as string | undefined,
          grantTypes: p.grant_types as string[] | undefined,
          tokenEndpointAuthMethod: p.token_endpoint_auth_method as string | undefined,
        });
        json(res, 201, {
          client_id: registered.clientId,
          token_endpoint_auth_method: "none",
          redirect_uris: p.redirect_uris,
        });
        return true;
      }
      if (req.method === "GET" && url.pathname === "/authorize") {
        const p = url.searchParams;
        if (p.has("subject") || p.get("response_type") !== "code") throw new Error("invalid authorize parameters");
        const result = await provider.handleAuthorize({
          clientId: p.get("client_id") ?? "",
          redirectUri: p.get("redirect_uri") ?? "",
          codeChallenge: p.get("code_challenge") ?? "",
          codeChallengeMethod: p.get("code_challenge_method") ?? "",
          resource: p.get("resource") ?? provider.config.canonicalUri,
          scope: p.get("scope") ?? "",
          state: p.get("state") ?? undefined,
        });
        let target = "/login";
        try {
          await provider.sessions.get(cookies.get(sessionName) ?? "");
          target = "/consent";
        } catch {
          /* No valid browser session. */
        }
        redirect(res, target + "?interaction=" + encodeURIComponent(result.interactionId));
        return true;
      }
      if (req.method === "GET" && url.pathname === "/login") {
        const interaction = url.searchParams.get("interaction") ?? "";
        const nonce = provider.credentials.create("rvb").token;
        const challenge = await provider.sessions.challenge("login", null, nonce + ":" + interaction);
        res.setHeader("set-cookie", cookie(loginName, nonce, "Strict", 600));
        html(
          res,
          '<h1>Sign in to wardby</h1><form method="post" action="/login">' +
            hidden("interaction", interaction) +
            hidden("csrf", challenge) +
            '<label>Login key <input type="password" name="login_key" required autocomplete="off"></label><button>Sign in</button></form>',
        );
        return true;
      }
      if (
        req.method === "POST" &&
        ["/login", "/consent", "/logout"].includes(url.pathname) &&
        req.headers.origin !== canonical.origin
      ) {
        json(res, 403, { error: "invalid_origin" });
        return true;
      }
      if (req.method === "POST" && !(body instanceof URLSearchParams)) throw new Error("form body required");
      const p = body instanceof URLSearchParams ? body : new URLSearchParams();
      if (req.method === "POST" && url.pathname === "/login") {
        if (p.has("subject")) throw new Error("subject parameter not allowed");
        const key = p.get("login_key") ?? "";
        await limiter.check("login-ip", ip, 10);
        await limiter.check("login-key", provider.credentials.id(key, "rvk") ?? "invalid", 5);
        const interaction = p.get("interaction") ?? "";
        const nonce = cookies.get(loginName);
        if (!nonce) throw new Error("missing login nonce");
        const session = await provider.sessions.login(
          key,
          p.get("csrf") ?? "",
          nonce + ":" + interaction,
          cookies.get(sessionName),
        );
        res.setHeader("set-cookie", [
          cookie(sessionName, session, "Lax", 30 * 86400),
          cookie(loginName, "", "Strict", 0),
        ]);
        redirect(res, interaction ? "/consent?interaction=" + encodeURIComponent(interaction) : "/logout", req);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/consent") {
        const id = url.searchParams.get("interaction") ?? "";
        const { interaction, challenge } = await provider.consentPage(cookies.get(sessionName) ?? "", id);
        const name = (interaction.client.metadata as { client_name: string }).client_name;
        html(
          res,
          "<h1>Authorize " +
            escape(name) +
            "</h1><p>Resource: " +
            escape(interaction.resource) +
            "</p><p>Scopes: " +
            escape(interaction.requestedScope) +
            '</p><form action="/consent" method="post">' +
            hidden("interaction", id) +
            hidden("csrf", challenge) +
            '<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>',
        );
        return true;
      }
      if (req.method === "POST" && url.pathname === "/consent") {
        if (!["approve", "deny"].includes(p.get("decision") ?? "")) throw new Error("invalid consent decision");
        redirect(
          res,
          await provider.consent(
            cookies.get(sessionName) ?? "",
            p.get("interaction") ?? "",
            p.get("csrf") ?? "",
            p.get("decision") === "approve",
          ),
          req,
        );
        return true;
      }
      if (req.method === "GET" && url.pathname === "/logout") {
        const session = await provider.sessions.get(cookies.get(sessionName) ?? "");
        const challenge = await provider.sessions.challenge("logout", session.sessionId, "logout");
        html(
          res,
          '<form action="/logout" method="post">' + hidden("csrf", challenge) + "<button>Sign out</button></form>",
        );
        return true;
      }
      if (req.method === "POST" && url.pathname === "/logout") {
        await provider.sessions.logout(cookies.get(sessionName) ?? "", p.get("csrf") ?? "");
        res.setHeader("set-cookie", cookie(sessionName, "", "Lax", 0));
        redirect(res, "/login", req);
        return true;
      }
      if (req.method === "POST" && ["/token", "/revoke"].includes(url.pathname)) {
        if (req.headers.authorization) throw new Error("Authorization header not allowed (public clients only)");
        if (p.has("client_secret") || p.has("client_assertion"))
          throw new Error("client credentials not allowed (public clients only)");
        const clientId = p.get("client_id") ?? "";
        if (url.pathname === "/revoke") {
          await provider.revoke(p.get("token") ?? "", clientId);
          json(res, 200, {});
          return true;
        }
        const grantType = p.get("grant_type");
        if (grantType !== "authorization_code" && grantType !== "refresh_token")
          throw new Error("unsupported grant_type");
        const common = { clientId, resource: p.get("resource") ?? undefined };
        const token = await provider.handleToken(
          grantType === "refresh_token"
            ? { ...common, grantType, refreshToken: p.get("refresh_token") ?? "" }
            : {
                ...common,
                grantType,
                code: p.get("code") ?? "",
                codeVerifier: p.get("code_verifier") ?? "",
                redirectUri: p.get("redirect_uri") ?? "",
              },
        );
        json(res, 200, {
          access_token: token.accessToken,
          token_type: token.tokenType,
          expires_in: token.expiresIn,
          refresh_token: token.refreshToken,
          scope: token.scope,
        });
        return true;
      }
      json(res, 405, { error: "method_not_allowed" });
    } catch (err) {
      if (err instanceof RateLimitError) {
        res.setHeader("retry-after", "60");
        json(res, 429, { error: "rate_limited" });
      } else {
        // The id is returned to the client and logged with the reason, so a
        // rejection reported by a client can be traced. Only the reason is
        // logged - never request values, which include codes and tokens.
        const id = randomUUID();
        authLog.warn(
          { id, path: url.pathname, reason: err instanceof Error ? err.message || "unspecified" : "unspecified" },
          "self-hosted OAuth request rejected",
        );
        json(res, 400, { error: url.pathname === "/token" ? "invalid_grant" : "invalid_request", id });
      }
    }
    return true;
  };
}
