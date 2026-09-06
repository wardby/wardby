/**
 * AuthProvider selector — builds the adapter for the configured AUTH_PROVIDER
 * kind. Both adapters implement the same AuthProvider (incl. verifyBearer),
 * so the resource-server middleware and tool handlers never branch on mode.
 *
 * self-hosted is wired in Task 4 (SelfHostedAuthProvider doesn't exist yet
 * at this point in the plan); this throws a clear "not implemented" until
 * then rather than importing a file that isn't there.
 */
import type { AuthProviderKind, AuthConfig } from "../../config/providers.js";
import type { AuthProvider } from "./types.js";
import { DelegatingAuthProvider } from "./delegating.js";

export { DelegatingAuthProvider } from "./delegating.js";

export function buildAuthProvider(kind: AuthProviderKind, config: AuthConfig): AuthProvider {
  if (kind === "self-hosted") {
    throw new Error("AUTH_PROVIDER=self-hosted not implemented yet.");
  }
  return new DelegatingAuthProvider(config);
}
