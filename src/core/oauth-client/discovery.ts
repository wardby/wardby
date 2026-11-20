import { z } from "zod";
import type { SafeFetchOptions } from "../../sandbox/safe-fetch.js";
import type { safeFetch } from "../../sandbox/safe-fetch.js";
import { packageVersion } from "../../package-version.js";
import { isAllowedEndpoint, oauthFetch, OAuthProtocolError } from "./http.js";

export interface OAuthMetadata {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  /**
   * Set when the resource has no protected-resource metadata (RFC 9728) and its own origin's
   * authorization-server metadata was used instead (MCP authorization spec 2025-03-26). Absent: RFC 9728.
   */
  discovery?: "legacy-origin";
}

const resourceMetadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});

const serverMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  revocation_endpoint: z.string().optional(),
  grant_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

function fail(): never {
  throw new OAuthProtocolError("discovery_failed", "OAuth discovery failed for this server.");
}

/** Scheme, host and path compared after lowercasing the host and dropping default ports and a trailing slash. */
function normalise(value: string): string | undefined {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

function sameUrl(a: string, b: string): boolean {
  const na = normalise(a);
  return na !== undefined && na === normalise(b);
}

/** Strict: only a quoted https/http URL in a Bearer challenge's resource_metadata parameter. */
function challengeMetadataUrl(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return /(?:^|[\s,])resource_metadata="([^"\s]{1,2048})"/i.exec(header)?.[1];
}

function wellKnown(base: string, suffix: string, appendPath: boolean): string {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, "");
  u.search = "";
  u.hash = "";
  u.pathname = appendPath ? `${path}/.well-known/${suffix}` : `/.well-known/${suffix}${path}`;
  return u.href;
}

type Fetch = (url: string, init: { method: "GET" }) => ReturnType<typeof oauthFetch>;

/** What firstDocument returns when every candidate answered 4xx. */
const NOT_FOUND = Symbol("not-found");

/**
 * First candidate that answers 200; any 4xx moves on, a 5xx is a provider outage, anything else fails.
 * `NOT_FOUND` when every candidate answered 4xx.
 */
async function firstDocument(candidates: string[], get: Fetch, options?: SafeFetchOptions): Promise<unknown> {
  for (const url of candidates) {
    if (!isAllowedEndpoint(url, options)) fail();
    const r = await get(url, { method: "GET" });
    if (r.status === 200) return r.json;
    if (r.status >= 500) throw new OAuthProtocolError("provider_unavailable", "The OAuth provider is unavailable.");
    if (r.status < 400 || r.status >= 500) fail();
  }
  return NOT_FOUND;
}

function found(document: unknown): unknown {
  return document === NOT_FOUND ? fail() : document;
}

export async function discoverOAuth(
  resource: string,
  options?: SafeFetchOptions,
  fetchImpl?: typeof safeFetch,
): Promise<OAuthMetadata> {
  if (!isAllowedEndpoint(resource, options)) fail();
  const get: Fetch = (url, init) => oauthFetch(url, init, options, fetchImpl);

  // 1. Ask the resource itself; a 401 challenge may name its metadata document.
  let probe: Awaited<ReturnType<typeof oauthFetch>> | undefined;
  try {
    probe = await oauthFetch(
      resource,
      {
        method: "POST",
        ignoreBody: true,
        accept: "application/json, text/event-stream",
        json: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "wardby", version: packageVersion() },
          },
        },
      },
      options,
      fetchImpl,
    );
  } catch (e) {
    // A redirect or an unusable answer from the probe only means "no challenge"; an unreachable server is fatal.
    if (!(e instanceof OAuthProtocolError) || e.code !== "bad_response") throw e;
  }
  const challenged = probe?.status === 401 ? challengeMetadataUrl(probe.headers["www-authenticate"]) : undefined;

  // 2. Protected-resource metadata (RFC 9728).
  const root = new URL("/.well-known/oauth-protected-resource", resource).href;
  const candidates = challenged
    ? [challenged]
    : [...new Set([wellKnown(resource, "oauth-protected-resource", false), root])];
  const document = await firstDocument(candidates, get, options);

  // 2b. None at all, and the challenge named none: the 2025-03-26 MCP flow, where the resource's own
  // origin is its authorization server. Only the origin (never a host from a response), and only real
  // metadata (no default /authorize, /token, /register). A challenge that named a document it then did
  // not serve, or a document that does not validate, is not this shape: those still fail.
  const legacy = document === NOT_FOUND && !challenged;
  let resourceId: string;
  let authServer: string;
  let scopesSupported: string[] | undefined;
  if (legacy) {
    resourceId = resource;
    authServer = new URL(resource).origin;
  } else {
    const prm = resourceMetadataSchema.safeParse(found(document));
    if (!prm.success || !sameUrl(prm.data.resource, resource)) fail();
    resourceId = prm.data.resource;
    authServer = prm.data.authorization_servers[0];
    scopesSupported = prm.data.scopes_supported;
  }
  if (!isAllowedEndpoint(authServer, options)) fail();

  // 3. Authorization-server metadata (RFC 8414, then OpenID discovery).
  const as = serverMetadataSchema.safeParse(
    found(
      await firstDocument(
        [
          ...new Set([
            wellKnown(authServer, "oauth-authorization-server", false),
            wellKnown(authServer, "openid-configuration", false),
            wellKnown(authServer, "openid-configuration", true),
          ]),
        ],
        get,
        options,
      ),
    ),
  );
  if (!as.success || !sameUrl(as.data.issuer, authServer)) fail();
  const m = as.data;
  if (!m.code_challenge_methods_supported?.includes("S256")) fail();
  if (m.grant_types_supported && !m.grant_types_supported.includes("authorization_code")) fail();
  for (const endpoint of [m.authorization_endpoint, m.token_endpoint, m.registration_endpoint, m.revocation_endpoint]) {
    if (endpoint !== undefined && !isAllowedEndpoint(endpoint, options)) fail();
  }
  return {
    resource: resourceId,
    issuer: m.issuer,
    authorizationEndpoint: m.authorization_endpoint,
    tokenEndpoint: m.token_endpoint,
    ...(m.registration_endpoint ? { registrationEndpoint: m.registration_endpoint } : {}),
    ...(m.revocation_endpoint ? { revocationEndpoint: m.revocation_endpoint } : {}),
    ...(scopesSupported ? { scopesSupported } : {}),
    ...(legacy ? { discovery: "legacy-origin" as const } : {}),
  };
}
