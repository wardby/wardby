import { z } from "zod";
import type { safeFetch, SafeFetchOptions } from "../../sandbox/safe-fetch.js";
import type { OAuthMetadata } from "./discovery.js";
import { oauthFetch, OAuthProtocolError, type OAuthFetchResult } from "./http.js";

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date | null;
  scope?: string;
}

type Fetch = typeof safeFetch;

const MAX_EXPIRES_IN_SECONDS = 31_536_000;

const retryable = (status: number): boolean => status >= 500 || status === 429;

const registrationSchema = z.object({ client_id: z.string().min(1), client_secret: z.string().min(1).optional() });

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.preprocess(
    (v) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v),
    z.number().finite().positive().optional(),
  ),
  scope: z.string().optional(),
});

/** Dynamic client registration (RFC 7591) for a public client using PKCE. */
export async function registerClient(
  meta: Pick<OAuthMetadata, "registrationEndpoint">,
  redirectUri: string,
  options?: SafeFetchOptions,
  fetchImpl?: Fetch,
): Promise<OAuthClient> {
  const fail = (): never => {
    throw new OAuthProtocolError("registration_failed", "The OAuth provider did not register the client.");
  };
  if (!meta.registrationEndpoint) fail();
  let r: OAuthFetchResult;
  try {
    r = await oauthFetch(
      meta.registrationEndpoint as string,
      {
        method: "POST",
        json: {
          client_name: "Wardby",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
      },
      options,
      fetchImpl,
    );
  } catch (e) {
    if (e instanceof OAuthProtocolError && e.code === "provider_unavailable") throw e;
    return fail();
  }
  if (retryable(r.status)) {
    throw new OAuthProtocolError("provider_unavailable", "The OAuth provider is unavailable.");
  }
  if (r.status < 200 || r.status >= 300) fail();
  const parsed = registrationSchema.safeParse(r.json);
  if (!parsed.success) fail();
  const d = parsed.data as z.infer<typeof registrationSchema>;
  return { clientId: d.client_id, ...(d.client_secret ? { clientSecret: d.client_secret } : {}) };
}

export function buildAuthorizeUrl(
  meta: Pick<OAuthMetadata, "authorizationEndpoint" | "resource">,
  client: OAuthClient,
  input: { state: string; codeChallenge: string; redirectUri: string; scope?: string },
): string {
  const url = new URL(meta.authorizationEndpoint);
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", client.clientId);
  q.set("redirect_uri", input.redirectUri);
  q.set("state", input.state);
  q.set("code_challenge", input.codeChallenge);
  q.set("code_challenge_method", "S256");
  q.set("resource", meta.resource);
  if (input.scope) q.set("scope", input.scope);
  return url.href;
}

function clientParams(client: OAuthClient): Record<string, string> {
  return { client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) };
}

async function tokenRequest(
  endpoint: string,
  form: Record<string, string>,
  refusal: string,
  options: SafeFetchOptions | undefined,
  fetchImpl: Fetch | undefined,
  now: Date,
): Promise<OAuthTokens> {
  const r = await oauthFetch(endpoint, { method: "POST", form }, options, fetchImpl);
  if (retryable(r.status)) {
    throw new OAuthProtocolError("provider_unavailable", "The OAuth provider is unavailable.");
  }
  if (r.status < 200 || r.status >= 300) {
    // Only the short `error` code is read; the description is never used in a message.
    const code = (r.json as { error?: unknown } | undefined)?.error;
    if (code === "invalid_client") {
      throw new OAuthProtocolError("invalid_client", "The OAuth provider rejected the client.");
    }
    if (code === "invalid_grant") throw new OAuthProtocolError("invalid_grant", refusal);
    throw new OAuthProtocolError("bad_response", "The OAuth provider refused the token request.");
  }
  const parsed = tokenSchema.safeParse(r.json);
  if (!parsed.success) {
    throw new OAuthProtocolError("bad_response", "The OAuth provider returned an unusable token response.");
  }
  const d = parsed.data;
  return {
    accessToken: d.access_token,
    ...(d.refresh_token ? { refreshToken: d.refresh_token } : {}),
    expiresAt:
      d.expires_in !== undefined
        ? new Date(now.getTime() + Math.min(d.expires_in, MAX_EXPIRES_IN_SECONDS) * 1000)
        : null,
    ...(d.scope ? { scope: d.scope } : {}),
  };
}

export function exchangeCode(
  meta: Pick<OAuthMetadata, "tokenEndpoint" | "resource">,
  client: OAuthClient,
  input: { code: string; codeVerifier: string; redirectUri: string },
  options?: SafeFetchOptions,
  fetchImpl?: Fetch,
  now: Date = new Date(),
): Promise<OAuthTokens> {
  return tokenRequest(
    meta.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      resource: meta.resource,
      ...clientParams(client),
    },
    "The provider refused the authorization code.",
    options,
    fetchImpl,
    now,
  );
}

export function refreshTokens(
  meta: Pick<OAuthMetadata, "tokenEndpoint" | "resource">,
  client: OAuthClient,
  refreshToken: string,
  options?: SafeFetchOptions,
  fetchImpl?: Fetch,
  now: Date = new Date(),
): Promise<OAuthTokens> {
  return tokenRequest(
    meta.tokenEndpoint,
    { grant_type: "refresh_token", refresh_token: refreshToken, resource: meta.resource, ...clientParams(client) },
    "The provider refused the refresh token.",
    options,
    fetchImpl,
    now,
  );
}

/** RFC 7009. A no-op when the provider has no revocation endpoint. Callers treat revocation as best effort and should catch its errors. */
export async function revokeToken(
  meta: Pick<OAuthMetadata, "revocationEndpoint">,
  client: OAuthClient,
  token: string,
  hint: "refresh_token" | "access_token",
  options?: SafeFetchOptions,
  fetchImpl?: Fetch,
): Promise<void> {
  if (!meta.revocationEndpoint) return;
  const r = await oauthFetch(
    meta.revocationEndpoint,
    { method: "POST", form: { token, token_type_hint: hint, ...clientParams(client) }, ignoreBody: true },
    options,
    fetchImpl,
  );
  if (retryable(r.status)) throw new OAuthProtocolError("provider_unavailable", "The OAuth provider is unavailable.");
  if (r.status < 200 || r.status >= 300) {
    throw new OAuthProtocolError("bad_response", "The OAuth provider refused the revocation request.");
  }
}
