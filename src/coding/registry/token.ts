import { createHash } from "node:crypto";

/** A one-way, registry-only token for npm and pip. The proxy stores its hash and
 *  accepts it only on /registry/ routes, so package tools never hold the model
 *  capability. */
export function deriveRegistryToken(capability: string): string {
  return `rrg_${createHash("sha256").update("wardby-registry\0").update(capability).digest("base64url")}`;
}
