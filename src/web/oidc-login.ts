/**
 * Browser sign-in for the document pages in delegating mode: OpenID Connect
 * authorization code flow with PKCE (S256) against the operator's IdP
 * (AUTH_ISSUER), as the client WEB_OIDC_CLIENT_ID.
 *
 * Secret handling. The state, nonce and PKCE verifier live only in the
 * `__Host-wardby-web-login` cookie, sealed with AES-256-GCM under a key
 * derived from SECRET_APP_KEY (so it is neither readable nor forgeable) and
 * carrying its own 10-minute expiry. The client secret, the authorization
 * code, the tokens and the verifier are never logged, never returned, never
 * stored and never put into an error: every failure leaves this module as
 * one of three fixed codes. The ID token is discarded once verified; the
 * access token is never read.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { JWTVerifyGetKey } from "jose";
import type { PrismaClient } from "#prisma";
import { oauthFetch, isAllowedEndpoint } from "../core/oauth-client/http.js";
import type { safeFetch, SafeFetchOptions } from "../sandbox/safe-fetch.js";
import { remoteJwks, subjectFromClaims, verifyIdpJwt } from "../providers/auth/delegating.js";
import { resolvePrincipal } from "../mcp/auth/principal.js";
import { upsertProfile } from "../core/documents/profiles.js";
import { readCookie, secureCookies } from "../mcp/auth/self-hosted/cookies.js";

export const WEB_LOGIN_FAILED = "web_login_failed";
export const WEB_LOGIN_STATE_INVALID = "web_login_state_invalid";
export const WEB_LOGIN_NOT_CONFIGURED = "web_login_not_configured";

/** The browser has this long to come back from the IdP. */
export const WEB_LOGIN_STATE_MS = 10 * 60 * 1000;
/** Where the IdP sends the browser back, on the canonical URI's origin. Register this exact URI at the IdP. */
export const WEB_LOGIN_CALLBACK_PATH = "/web/callback";

const KEY_INFO = "wardby/web/oidc-login-state/v1";
const COOKIE_VERSION = "v1.";
const MAX_RETURN_TO = 2048;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export interface OidcLoginOptions {
  /** AUTH_ISSUER. */
  issuer?: string;
  /** AUTH_JWKS_URI; the discovered jwks_uri when unset. */
  jwksUri?: string;
  clientId?: string;
  clientSecret?: string;
  scopes: string;
  /** MCP_CANONICAL_URI: its origin hosts the pages and the callback. */
  canonicalUri: string;
  /** SECRET_APP_KEY (64 hex chars); the state cookie key is derived from it. */
  appKey?: string;
  /** Tests and local development: e.g. privateHostAllowlist for an http IdP on loopback. */
  fetchOptions?: SafeFetchOptions;
  fetchImpl?: typeof safeFetch;
  /** Tests: signing keys without a JWKS endpoint. */
  jwks?: JWTVerifyGetKey;
  now?: () => number;
}

export interface OidcLogin {
  readonly configured: boolean;
  startLogin(input: { returnTo: string }): Promise<{ redirectUrl: string; stateCookie: string }>;
  /** Verifies the callback and returns the principal; the caller creates the web session. */
  finishLogin(
    db: PrismaClient,
    input: { url: string; cookieHeader: string | undefined },
  ): Promise<{ principalId: string; returnTo: string }>;
}

const fail = (code: string): never => {
  throw new Error(code);
};

export function loginStateCookieName(canonicalUri: string): string {
  return secureCookies(canonicalUri) ? "__Host-wardby-web-login" : "wardby-dev-web-login";
}

function stateCookieHeader(canonicalUri: string, value: string, maxAgeSeconds: number): string {
  const secure = secureCookies(canonicalUri);
  return `${loginStateCookieName(canonicalUri)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** A Set-Cookie value that removes the login state cookie (send it with the callback's response). */
export function clearLoginStateCookie(canonicalUri: string): string {
  return stateCookieHeader(canonicalUri, "", 0);
}

/**
 * Only a same-origin path to a document (`/d/…`) or share link (`/s/…`): no
 * scheme or host, no `//` or backslash, no dot segments, nothing the URL
 * parser would rewrite (so what is checked is what the browser follows).
 */
export function isSafeReturnTo(value: string): boolean {
  if (!value || value.length > MAX_RETURN_TO) return false;
  if (!/^\/[ds]\/[^/]/.test(value) || value.includes("//") || value.includes("\\")) return false;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) <= 0x20 || value.charCodeAt(i) === 0x7f) return false;
  let u: URL;
  try {
    u = new URL(value, "https://return-to.invalid");
  } catch {
    return false;
  }
  return u.origin === "https://return-to.invalid" && u.pathname + u.search + u.hash === value;
}

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri?: string;
  authMethods?: string[];
}

const tokenResponseSchema = z.object({ id_token: z.string().min(1) });

const sealedStateSchema = z.object({
  s: z.string(),
  n: z.string(),
  v: z.string(),
  r: z.string(),
  e: z.number(),
});
type SealedState = z.infer<typeof sealedStateSchema>;

const random = () => randomBytes(32).toString("base64url");

function sameSecret(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** RFC 6749 section 2.3.1: each part form-urlencoded, then joined and base64-encoded. */
function basicCredentials(clientId: string, clientSecret: string): string {
  const enc = (v: string) => new URLSearchParams({ v }).toString().slice(2);
  return `Basic ${Buffer.from(`${enc(clientId)}:${enc(clientSecret)}`, "utf8").toString("base64")}`;
}

export function createOidcLogin(options: OidcLoginOptions): OidcLogin {
  const appKey = options.appKey && /^[0-9a-fA-F]{64}$/.test(options.appKey) ? Buffer.from(options.appKey, "hex") : null;
  const configured = Boolean(options.issuer && options.clientId && appKey);
  const key = appKey ? Buffer.from(hkdfSync("sha256", appKey, Buffer.alloc(0), KEY_INFO, 32)) : null;
  const now = options.now ?? Date.now;
  const redirectUri = new URL(WEB_LOGIN_CALLBACK_PATH, options.canonicalUri).href;
  const cookieName = loginStateCookieName(options.canonicalUri);
  const aad = Buffer.from(cookieName, "utf8");
  const scopes = [...new Set(["openid", ...options.scopes.split(/\s+/).filter(Boolean)])].join(" ");

  let discovery: { at: number; value: Promise<Discovery> } | undefined;
  let jwks: JWTVerifyGetKey | undefined = options.jwks;

  function requireConfigured(): { issuer: string; clientId: string; key: Buffer } {
    if (!configured || !key) return fail(WEB_LOGIN_NOT_CONFIGURED);
    return { issuer: options.issuer as string, clientId: options.clientId as string, key };
  }

  async function fetchDiscovery(issuer: string): Promise<Discovery> {
    const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const r = await oauthFetch(url, { method: "GET" }, options.fetchOptions, options.fetchImpl);
    if (r.status !== 200) return fail(WEB_LOGIN_FAILED);
    const parsed = discoverySchema.safeParse(r.json);
    if (!parsed.success) return fail(WEB_LOGIN_FAILED);
    const d = parsed.data;
    // OpenID Connect Discovery 1.0 section 4.3: the issuer must be exactly the one asked for.
    if (d.issuer !== issuer) return fail(WEB_LOGIN_FAILED);
    if (d.code_challenge_methods_supported && !d.code_challenge_methods_supported.includes("S256")) {
      return fail(WEB_LOGIN_FAILED);
    }
    for (const endpoint of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri]) {
      if (endpoint !== undefined && !isAllowedEndpoint(endpoint, options.fetchOptions)) return fail(WEB_LOGIN_FAILED);
    }
    return {
      authorizationEndpoint: d.authorization_endpoint,
      tokenEndpoint: d.token_endpoint,
      ...(d.jwks_uri ? { jwksUri: d.jwks_uri } : {}),
      ...(d.token_endpoint_auth_methods_supported ? { authMethods: d.token_endpoint_auth_methods_supported } : {}),
    };
  }

  async function discover(issuer: string): Promise<Discovery> {
    if (!discovery || now() - discovery.at > DISCOVERY_TTL_MS) {
      const value = fetchDiscovery(issuer);
      discovery = { at: now(), value };
      value.catch(() => {
        if (discovery?.value === value) discovery = undefined;
      });
    }
    try {
      return await discovery.value;
    } catch {
      return fail(WEB_LOGIN_FAILED);
    }
  }

  function seal(k: Buffer, state: SealedState): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", k, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    return COOKIE_VERSION + Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
  }

  function unseal(k: Buffer, cookieHeader: string | undefined): SealedState {
    const value = readCookie(cookieHeader, cookieName);
    if (!value || !value.startsWith(COOKIE_VERSION) || value.length > 4096) return fail(WEB_LOGIN_STATE_INVALID);
    try {
      const raw = Buffer.from(value.slice(COOKIE_VERSION.length), "base64url");
      if (raw.length < 12 + 16 + 1) return fail(WEB_LOGIN_STATE_INVALID);
      const decipher = createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString(
        "utf8",
      );
      const parsed = sealedStateSchema.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.e <= now() || !isSafeReturnTo(parsed.data.r)) {
        return fail(WEB_LOGIN_STATE_INVALID);
      }
      return parsed.data;
    } catch {
      return fail(WEB_LOGIN_STATE_INVALID);
    }
  }

  async function redeem(d: Discovery, clientId: string, code: string, verifier: string): Promise<string> {
    const form: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    };
    let authorization: string | undefined;
    const secret = options.clientSecret;
    if (!secret) {
      form.client_id = clientId;
    } else if (!d.authMethods || d.authMethods.includes("client_secret_basic")) {
      // client_secret_basic is the default method when the IdP lists none (RFC 8414).
      authorization = basicCredentials(clientId, secret);
    } else if (d.authMethods.includes("client_secret_post")) {
      form.client_id = clientId;
      form.client_secret = secret;
    } else {
      return fail(WEB_LOGIN_FAILED);
    }
    let r;
    try {
      r = await oauthFetch(
        d.tokenEndpoint,
        { method: "POST", form, ...(authorization ? { authorization } : {}) },
        options.fetchOptions,
        options.fetchImpl,
      );
    } catch {
      return fail(WEB_LOGIN_FAILED);
    }
    // Neither the error body nor its description is read: only the outcome.
    if (r.status !== 200) return fail(WEB_LOGIN_FAILED);
    const parsed = tokenResponseSchema.safeParse(r.json);
    if (!parsed.success) return fail(WEB_LOGIN_FAILED);
    return parsed.data.id_token;
  }

  return {
    configured,

    async startLogin({ returnTo }) {
      const { issuer, clientId, key: k } = requireConfigured();
      if (!isSafeReturnTo(returnTo)) return fail(WEB_LOGIN_FAILED);
      const d = await discover(issuer);
      const state = random();
      const nonce = random();
      const verifier = random();
      const url = new URL(d.authorizationEndpoint);
      const q = url.searchParams;
      q.set("response_type", "code");
      q.set("client_id", clientId);
      q.set("redirect_uri", redirectUri);
      q.set("scope", scopes);
      q.set("state", state);
      q.set("nonce", nonce);
      q.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      q.set("code_challenge_method", "S256");
      const sealed = seal(k, { s: state, n: nonce, v: verifier, r: returnTo, e: now() + WEB_LOGIN_STATE_MS });
      return {
        redirectUrl: url.href,
        stateCookie: stateCookieHeader(options.canonicalUri, sealed, WEB_LOGIN_STATE_MS / 1000),
      };
    },

    async finishLogin(db, { url, cookieHeader }) {
      const { issuer, clientId, key: k } = requireConfigured();
      const saved = unseal(k, cookieHeader);
      let params: URLSearchParams;
      try {
        params = new URL(url, "https://callback.invalid").searchParams;
      } catch {
        return fail(WEB_LOGIN_STATE_INVALID);
      }
      const state = params.get("state");
      if (!state || !sameSecret(state, saved.s)) return fail(WEB_LOGIN_STATE_INVALID);
      const code = params.get("code");
      if (params.has("error") || !code) return fail(WEB_LOGIN_FAILED);

      const d = await discover(issuer);
      const idToken = await redeem(d, clientId, code, saved.v);
      let subject: string;
      let claims: Record<string, unknown>;
      try {
        if (!jwks) {
          const jwksUri = options.jwksUri ?? d.jwksUri;
          if (!jwksUri) return fail(WEB_LOGIN_FAILED);
          jwks = remoteJwks(jwksUri);
        }
        claims = await verifyIdpJwt(idToken, jwks, { issuer, audience: clientId });
        // OIDC Core 3.1.3.7: with several audiences the authorized party must be us; azp, when present, too.
        const aud = claims.aud;
        if (
          (Array.isArray(aud) && aud.length > 1 && claims.azp === undefined) ||
          (claims.azp !== undefined && claims.azp !== clientId)
        ) {
          return fail(WEB_LOGIN_FAILED);
        }
        if (typeof claims.nonce !== "string" || !sameSecret(claims.nonce, saved.n)) return fail(WEB_LOGIN_FAILED);
        subject = subjectFromClaims(claims);
      } catch {
        return fail(WEB_LOGIN_FAILED);
      }

      // The same find-or-create the bearer path uses (resource-server.ts), so the
      // browser and MCP clients land on one principal for one IdP subject.
      const principal = await resolvePrincipal(subject, db);
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
      await upsertProfile(db, principal.id, {
        displayName: str(claims.name) ?? str(claims.preferred_username),
        email: str(claims.email),
        source: "oidc",
      });
      return { principalId: principal.id, returnTo: saved.r };
    },
  };
}
