/**
 * AuthProvider selector — builds the adapter for the configured AUTH_PROVIDER
 * kind. Both adapters implement the same AuthProvider (incl. verifyBearer),
 * so the resource-server middleware and tool handlers never branch on mode.
 */
import type { PrismaClient } from "#prisma";
import type { AuthProviderKind, AuthConfig } from "../../config/providers.js";
import type { AuthProvider } from "./types.js";
import { DelegatingAuthProvider } from "./delegating.js";
import { SelfHostedAuthProvider } from "./self-hosted.js";

export { DelegatingAuthProvider } from "./delegating.js";
export { SelfHostedAuthProvider } from "./self-hosted.js";

export function buildAuthProvider(kind: AuthProviderKind, config: AuthConfig, db: PrismaClient): AuthProvider {
  if (kind === "self-hosted") {
    if (!config.audience || !config.signingKey || !config.credentialHashKey) {
      throw new Error("AUTH_AUDIENCE, AUTH_SIGNING_KEY, and AUTH_CREDENTIAL_HASH_KEY are required.");
    }
    if (config.credentialHashKey.toLowerCase() === process.env.SECRET_APP_KEY?.toLowerCase())
      throw new Error("Credential and encryption keys must be distinct.");
    return new SelfHostedAuthProvider(
      {
        canonicalUri: config.audience,
        signingKey: config.signingKey,
        credentialHashKey: config.credentialHashKey,
        maxClients: config.maxClients,
      },
      db,
    );
  }
  return new DelegatingAuthProvider(config);
}
