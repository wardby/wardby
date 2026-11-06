import { createHash } from "node:crypto";

/** SHA-256 (base64url) of a run credential: the proxy stores only this, never the value. */
export function capabilityHash(capability: string): string {
  return createHash("sha256").update(capability).digest("base64url");
}
