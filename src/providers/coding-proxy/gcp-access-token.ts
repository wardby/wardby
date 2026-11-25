/**
 * An `Authorization` value for the coding proxy's own Google service account, for a `gcp` intercept rule
 * (docs/coding-proxy-tunnel.md): an OAuth access token from the metadata server, which on GKE with Workload
 * Identity is the token of the GCP service account the proxy's Kubernetes ServiceAccount is bound to. The
 * token never leaves the proxy: it is attached to an intercepted request after the run's own `Authorization`
 * is dropped, and it is never logged.
 *
 * Tokens last about an hour. One is fetched on first use, reused until REFRESH_BEFORE_EXPIRY_MS before it
 * expires, and refetched then; concurrent requests share one fetch. A failed fetch is not cached, so the next
 * request tries again.
 */

/** The metadata server's token endpoint for the pod's default (Workload Identity) service account. */
export const GCP_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
/** Refetch this long before the token expires, so no request carries one that expires on the way. */
export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;
/** An access token is one header-safe token: printable ASCII, no spaces. */
const TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** Why a token could not be had: a fixed code, safe to log. */
export class GcpTokenError extends Error {
  constructor(readonly code: "metadata_unreachable" | `metadata_http_${number}` | "metadata_bad_response") {
    super(`gcp_token_unavailable:${code}`);
    this.name = "GcpTokenError";
  }
}

export interface GcpTokenSourceOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** A function returning `Bearer <access token>` for the proxy's service account, cached and refreshed. */
export function gcpAccessTokenSource(options: GcpTokenSourceOptions = {}): () => Promise<string> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { authorization: string; refreshAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const load = async (): Promise<string> => {
    let response: Response;
    try {
      response = await fetchImpl(GCP_TOKEN_URL, {
        headers: { "Metadata-Flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new GcpTokenError("metadata_unreachable");
    }
    if (!response.ok) throw new GcpTokenError(`metadata_http_${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GcpTokenError("metadata_bad_response");
    }
    const { access_token: token, expires_in: expiresIn } = (body ?? {}) as Record<string, unknown>;
    if (typeof token !== "string" || !TOKEN.test(token) || typeof expiresIn !== "number" || !(expiresIn > 0)) {
      throw new GcpTokenError("metadata_bad_response");
    }
    const authorization = `Bearer ${token}`;
    cached = { authorization, refreshAt: now() + expiresIn * 1000 - REFRESH_BEFORE_EXPIRY_MS };
    return authorization;
  };

  return async () => {
    if (cached && now() < cached.refreshAt) return cached.authorization;
    inFlight ??= load().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
