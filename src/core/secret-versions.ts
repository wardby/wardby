/**
 * Warm rounds: which secrets a run is delivered, as identity and version only (never a value or a
 * ciphertext), for the warm-round fingerprint (providers/jobs/warm-fingerprint.ts). The same set,
 * under the same names, as secret-guard.ts loadAgentSecretValues redacts against.
 */
import type { PrismaClient } from "#prisma";

/**
 * Warm rounds: the identity and version of every secret loadAgentSecretValues would list for the
 * agent (the same set, the same names), sorted by name then id: each one's Secret.id, the name it is
 * delivered under and its updatedAt. Never reads a value or ciphertext. Rejects if any read fails.
 */
export async function agentSecretVersions(
  db: Pick<PrismaClient, "agentSecret" | "agentMcpServer" | "secret">,
  agentId: string,
): Promise<{ id: string; name: string; updatedAt: string }[]> {
  const [attached, servers] = await Promise.all([
    db.agentSecret.findMany({
      where: { agentId },
      select: { boundName: true, secret: { select: { id: true, updatedAt: true } } },
    }),
    db.agentMcpServer.findMany({
      where: { agentId },
      select: { server: { select: { name: true, ownerId: true, secretNames: true } } },
    }),
  ]);
  const versions = attached.map(({ boundName, secret }) => ({
    id: secret.id,
    name: boundName,
    updatedAt: secret.updatedAt.toISOString(),
  }));
  for (const { server } of servers) {
    if (server.secretNames.length === 0) continue;
    const rows = await db.secret.findMany({
      where: { ownerId: server.ownerId, name: { in: server.secretNames } },
      select: { id: true, name: true, updatedAt: true },
    });
    for (const row of rows) {
      versions.push({ id: row.id, name: `mcp:${server.name}/${row.name}`, updatedAt: row.updatedAt.toISOString() });
    }
  }
  return versions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
