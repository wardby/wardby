/**
 * The tunnel host patterns a coding run is given at dispatch (#627): its agent's
 * codingProfile.tunnelHosts as the operator's ceiling allows them at that moment, pinned on the run's
 * proxy session so a later edit to the agent does not change the run. The same for every coding provider.
 */
import type { PrismaClient } from "#prisma";
import type { Logger } from "./logger.js";
import {
  ANY_TUNNEL_HOST,
  parseTunnelHostPattern,
  tunnelHostsWithinCeiling,
  type TunnelAgentHostLevel,
} from "../coding/tunnel-hosts.js";

/**
 * The agent's stored patterns that still parse, within `level`; `*` only while its admin approval is
 * recorded. A pattern left out is counted in a warning (no values: the count and the agent id only).
 */
export async function loadTunnelHostPins(
  db: Pick<PrismaClient, "codingAgentProfile">,
  agentId: string,
  level: TunnelAgentHostLevel,
  log: Pick<Logger, "warn">,
): Promise<string[]> {
  if (level === "off") return [];
  const profile = await db.codingAgentProfile.findUnique({
    where: { agentId },
    select: { tunnelHosts: true, tunnelAnyHostAuthorizedById: true },
  });
  const stored = profile?.tunnelHosts ?? [];
  if (stored.length === 0) return [];
  const valid = stored.filter((pattern) => {
    const parsed = parseTunnelHostPattern(pattern);
    return parsed.ok && parsed.pattern === pattern;
  });
  const pins = tunnelHostsWithinCeiling([...new Set(valid)], level).filter(
    (pattern) => pattern !== ANY_TUNNEL_HOST || Boolean(profile?.tunnelAnyHostAuthorizedById),
  );
  if (pins.length < stored.length) {
    log.warn(
      { event: "coding.tunnel_hosts_left_out", agentId, leftOut: stored.length - pins.length, ceiling: level },
      "some of the agent's tunnel hosts are above the ceiling or unapproved; the run is not given them",
    );
  }
  return pins;
}
