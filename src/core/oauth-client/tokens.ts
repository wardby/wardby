import { z } from "zod";
import type { safeFetch, SafeFetchOptions } from "../../sandbox/safe-fetch.js";
import type { OAuthMetadata } from "./discovery.js";
import { logger } from "../logger.js";
import { oauthFetch, OAuthProtocolError, type OAuthFetchResult, type OAuthRegistrationDetail } from "./http.js";

const log = logger.child({ module: "oauth-client" });

const PROVIDER_ERROR_CODE = /^[a-z_]{1,64}$/;
const KNOWN_OTHER_AUTH_METHODS = [
  "client_secret_jwt",
  "private_key_jwt",
  "tls_client_auth",
  "self_signed_tls_client_auth",
];

/** Operator-log text from a provider: control characters dropped, at most 300 characters. */
function boundedDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 300);
}

export type OAuthClientAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  /**
   * How the token endpoint authenticates the client (the registration's token_endpoint_auth_method).
   * Absent: the secret, when there is one, goes in the form.
   */
  authMethod?: OAuthClientAuthMethod;
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

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;

const registrationSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  token_endpoint_auth_method: z.enum(AUTH_METHODS).optional(),
});

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
  const fail = (detail?: OAuthRegistrationDetail): never => {
    throw new OAuthProtocolError("registration_failed", "The OAuth provider did not register the client.", detail);
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
  if (r.status < 200 || r.status >= 300) {
    const body = r.json !== null && typeof r.json === "object" ? (r.json as Record<string, unknown>) : {};
    const providerError =
      typeof body.error === "string" && PROVIDER_ERROR_CODE.test(body.error) ? body.error : undefined;
    // A registration request carries no secret values, so a bounded description may go to the operator log.
    let host = "";
    try {
      host = new URL(meta.registrationEndpoint as string).hostname;
    } catch {
      /* the endpoint was already fetched; keep the log line anyway */
    }
    log.warn(
      {
        host,
        status: r.status,
        ...(providerError ? { error: providerError } : {}),
        reason: "registration_failed",
        ...(boundedDescription(body.error_description) !== undefined
          ? { description: boundedDescription(body.error_description) }
          : {}),
      },
      "oauth client registration refused",
    );
    return fail({ status: r.status, ...(providerError ? { providerError } : {}) });
  }
  const rawMethod = (r.json as { token_endpoint_auth_method?: unknown } | null | undefined)?.token_endpoint_auth_method;
  if (typeof rawMethod === "string" && !(AUTH_METHODS as readonly string[]).includes(rawMethod)) {
    return fail({
      status: r.status,
      authMethod: KNOWN_OTHER_AUTH_METHODS.includes(rawMethod) ? rawMethod : "unsupported",
    });
  }
  const parsed = registrationSchema.safeParse(r.json);
  if (!parsed.success) fail({ status: r.status });
  const d = parsed.data as z.infer<typeof registrationSchema>;
  return {
    clientId: d.client_id,
    ...(d.client_secret ? { clientSecret: d.client_secret } : {}),
    ...(d.token_endpoint_auth_method ? { authMethod: d.token_endpoint_auth_method } : {}),
  };
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

/** RFC 6749 section 2.3.1: each part form-urlencoded, then joined and base64-encoded. */
function basicCredentials(clientId: string, clientSecret: string): string {
  const enc = (v: string) => new URLSearchParams({ v }).toString().slice(2);
  return `Basic ${Buffer.from(`${enc(clientId)}:${enc(clientSecret)}`, "utf8").toString("base64")}`;
}

/** The client's credentials as the token endpoint expects them: form fields, or an HTTP Basic header. */
function clientAuth(client: OAuthClient): { form: Record<string, string>; authorization?: string } {
  if (client.authMethod === "none" || !client.clientSecret) return { form: { client_id: client.clientId } };
  if (client.authMethod === "client_secret_basic") {
    return { form: {}, authorization: basicCredentials(client.clientId, client.clientSecret) };
  }
  return { form: { client_id: client.clientId, client_secret: client.clientSecret } };
}

async function tokenRequest(
  endpoint: string,
  client: OAuthClient,
  params: Record<string, string>,
  refusal: string,
  options: SafeFetchOptions | undefined,
  fetchImpl: Fetch | undefined,
  now: Date,
): Promise<OAuthTokens> {
  const auth = clientAuth(client);
  const r = await oauthFetch(
    endpoint,
    {
      method: "POST",
      form: { ...params, ...auth.form },
      ...(auth.authorization ? { authorization: auth.authorization } : {}),
    },
    options,
    fetchImpl,
  );
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
    client,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      resource: meta.resource,
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
    client,
    { grant_type: "refresh_token", refresh_token: refreshToken, resource: meta.resource },
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
  const auth = clientAuth(client);
  const r = await oauthFetch(
    meta.revocationEndpoint,
    {
      method: "POST",
      form: { token, token_type_hint: hint, ...auth.form },
      ...(auth.authorization ? { authorization: auth.authorization } : {}),
      ignoreBody: true,
    },
    options,
    fetchImpl,
  );
  if (retryable(r.status)) throw new OAuthProtocolError("provider_unavailable", "The OAuth provider is unavailable.");
  if (r.status < 200 || r.status >= 300) {
    throw new OAuthProtocolError("bad_response", "The OAuth provider refused the revocation request.");
  }
}
