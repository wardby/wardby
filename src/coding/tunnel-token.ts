import { createHash } from "node:crypto";

/** A one-way, tunnel-only token for the coding proxy's CONNECT tunnel. The proxy stores its hash and
 *  accepts it only on the tunnel port, so a tunnel client never holds the model capability, and the
 *  registry token never opens a tunnel. A launcher derives it from the run's capability, as it does the
 *  registry token. */
export function deriveTunnelToken(capability: string): string {
  return `rtn_${createHash("sha256").update("wardby-tunnel\0").update(capability).digest("base64url")}`;
}
