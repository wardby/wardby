import { safeFetch, type SafeFetchOptions } from "../../sandbox/safe-fetch.js";
import { packageVersion } from "../../package-version.js";

export type OAuthErrorCode =
  | "discovery_failed"
  | "registration_failed"
  | "invalid_grant"
  | "invalid_client"
  | "provider_unavailable"
  | "bad_response";

/** Messages are fixed sentences: a provider response body is never interpolated into one. */
export class OAuthProtocolError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OAuthProtocolError";
  }
}

export const OAUTH_MAX_BODY_BYTES = 64 * 1024;

export interface OAuthFetchInit {
  method: "GET" | "POST";
  form?: Record<string, string>;
  json?: unknown;
  accept?: string;
  /** Skip JSON parsing of the body (RFC 7009 revocation); the size cap still applies. */
  ignoreBody?: boolean;
}

export interface OAuthFetchResult {
  status: number;
  headers: Record<string, string>;
  /** Parsed body; undefined when the body is empty, or is not JSON on a non-2xx response. */
  json: unknown;
}

/** https only, except http to a host in `privateHostAllowlist` (tests and local development). */
export function isAllowedEndpoint(value: string, options?: SafeFetchOptions): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (options?.privateHostAllowlist ?? []).some((h) => h.replace(/^\[|\]$/g, "").toLowerCase() === host);
}

export async function oauthFetch(
  url: string,
  init: OAuthFetchInit,
  options?: SafeFetchOptions,
  fetchImpl: typeof safeFetch = safeFetch,
): Promise<OAuthFetchResult> {
  if (!isAllowedEndpoint(url, options)) {
    throw new OAuthProtocolError("bad_response", "OAuth endpoint must use https.");
  }
  const headers: Record<string, string> = {
    "user-agent": `wardby/${packageVersion()}`,
    accept: init.accept ?? "application/json",
  };
  let body: string | undefined;
  if (init.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  let response;
  try {
    response = await fetchImpl(
      url,
      { method: init.method, headers, ...(body !== undefined ? { body } : {}) },
      {
        ...options,
        followRedirects: false,
      },
    );
  } catch {
    throw new OAuthProtocolError("provider_unavailable", "The OAuth provider could not be reached.");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new OAuthProtocolError("bad_response", "The OAuth provider answered with a redirect.");
  }
  const raw = Buffer.from(response.bodyBase64, "base64");
  if (raw.length > OAUTH_MAX_BODY_BYTES) {
    throw new OAuthProtocolError("bad_response", "The OAuth provider response is too large.");
  }
  const ok = response.status >= 200 && response.status < 300;
  let json: unknown;
  if (raw.length > 0 && !init.ignoreBody) {
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      if (ok) throw new OAuthProtocolError("bad_response", "The OAuth provider response is not valid JSON.");
    }
  }
  return { status: response.status, headers: response.headers, json };
}
