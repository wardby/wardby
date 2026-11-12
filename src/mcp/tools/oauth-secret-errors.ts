/**
 * The OAuth secret flow's errors as a status, a fixed code and a fixed message: shared by
 * `create_secret` (as an McpError) and the loopback sign-in routes (as JSON). Every message is a
 * fixed constant or a fixed sentence of our own; provider, Prisma and cipher text is never passed
 * through, and an error this does not recognise is left to the caller (undefined).
 */
import { Prisma } from "#prisma";
import { OAuthLinkError } from "../../core/oauth-link.js";
import { OAuthProtocolError } from "../../core/oauth-client/http.js";
import {
  OAuthSecretFlowError,
  SECRET_NOT_OAUTH,
  SECRET_OAUTH_CIPHER_FAILED,
  SECRET_OAUTH_CLIENT_ID_REQUIRED,
  SECRET_OAUTH_DISCOVERY_FAILED,
  SECRET_OAUTH_INPUT_TOO_LONG,
  SECRET_OAUTH_PROVIDER_UNAVAILABLE,
  SECRET_OAUTH_REFRESH_UNAVAILABLE,
  SECRET_OAUTH_RESOURCE_INVALID,
} from "../../core/oauth-secrets.js";

export interface OAuthSecretErrorDescription {
  status: number;
  /** A fixed snake_case code: the message's own `code:` prefix, or one named here. */
  code: string;
  message: string;
}

function described(status: number, message: string, fallbackCode: string): OAuthSecretErrorDescription {
  const prefix = /^([a-z][a-z0-9_]*):/.exec(message);
  return { status, code: prefix ? prefix[1] : fallbackCode, message };
}

export function describeOAuthSecretError(err: unknown): OAuthSecretErrorDescription | undefined {
  if (err instanceof OAuthLinkError) {
    return described(
      err.status,
      err.message,
      err.status === 429 ? "secret_oauth_too_many_pending" : "secret_oauth_link_refused",
    );
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return described(409, "a secret with this name already exists", "secret_exists");
  }
  if (err instanceof OAuthProtocolError) {
    if (err.code === "discovery_failed") return described(400, SECRET_OAUTH_DISCOVERY_FAILED, "");
    if (err.code === "provider_unavailable") return described(503, SECRET_OAUTH_PROVIDER_UNAVAILABLE, "");
    return described(502, err.message, "secret_oauth_provider_error");
  }
  if (err instanceof OAuthSecretFlowError) {
    if (err.reason === "cipher_failed") return described(500, SECRET_OAUTH_CIPHER_FAILED, "");
    if (err.reason === "refresh_unavailable") return described(503, SECRET_OAUTH_REFRESH_UNAVAILABLE, "");
    const code = `secret_oauth_${err.reason}`;
    if (err.reason === "bad_context" || err.reason === "issuer_mismatch") return described(400, err.message, code);
    return described(502, err.message, code);
  }
  const message = err instanceof Error ? err.message : "";
  const fixed: [prefix: string, status: number, message: string][] = [
    ["secret_oauth_discovery_failed", 400, SECRET_OAUTH_DISCOVERY_FAILED],
    ["secret_oauth_resource_invalid", 400, SECRET_OAUTH_RESOURCE_INVALID],
    ["secret_oauth_input_too_long", 400, SECRET_OAUTH_INPUT_TOO_LONG],
    ["secret_oauth_client_id_required", 400, SECRET_OAUTH_CLIENT_ID_REQUIRED],
    ["secret_oauth_name_taken", 409, SECRET_NOT_OAUTH],
    ["secret_oauth_encryption_failed", 500, SECRET_OAUTH_CIPHER_FAILED],
    ["secret_oauth_provider_unavailable", 503, SECRET_OAUTH_PROVIDER_UNAVAILABLE],
    ["secret_oauth_refresh_unavailable", 503, SECRET_OAUTH_REFRESH_UNAVAILABLE],
  ];
  for (const [prefix, status, text] of fixed) {
    if (message.startsWith(prefix)) return described(status, text, prefix);
  }
  return undefined;
}
