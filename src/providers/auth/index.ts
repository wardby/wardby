/**
 * AuthProvider selector — builds the adapter for the configured AUTH_PROVIDER
 * kind. Both adapters implement the same AuthProvider (incl. verifyBearer),
 * so the resource-server middleware and tool handlers never branch on mode.
 */
import type { PrismaClient } from "@prisma/client";
import type { AuthProviderKind, AuthConfig } from "../../config/providers.js";
import type { AuthProvider } from "./types.js";
import { DelegatingAuthProvider } from "./delegating.js";
import { SelfHostedAuthProvider } from "./self-hosted.js";

export { DelegatingAuthProvider } from "./delegating.js";
export { SelfHostedAuthProvider } from "./self-hosted.js";

export function buildAuthProvider(kind: AuthProviderKind, config: AuthConfig, db: PrismaClient): AuthProvider {
  if (kind === "self-hosted") {
    if (!config.audience || !config.signingKey) {
      throw new Error("AUTH_AUDIENCE and AUTH_SIGNING_KEY are required by the self-hosted AS adapter.");
    }
    return new SelfHostedAuthProvider({ canonicalUri: config.audience, signingKey: config.signingKey }, db);
  }
  return new DelegatingAuthProvider(config);
}
