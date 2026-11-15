/**
 * Which secrets a run is delivered, as identity and version only (never a value or a ciphertext):
 * for the warm-round fingerprint (providers/jobs/warm-fingerprint.ts) and for transcript capture,
 * which stores nothing when a secret changed while the run ran (coding/transcript/recorder.ts). The
 * same set, under the same names, as secret-guard.ts loadAgentSecretValues redacts against.
 */
import type { PrismaClient } from "#prisma";

/** One secret delivered to a run: identity and version, never its value. */
export interface SecretVersion {
  /** Secret.id. */
  id: string;
  /** The name it is delivered under: the attachment's bound name, or `mcp:<server>/<secret>`. */
  name: string;
  /** Secret.updatedAt, ISO 8601: changes with every value, broker or OAuth change. */
  updatedAt: string;
}

/**
 * The identity and version of every secret loadAgentSecretValues would list for the agent (the same
 * set, the same names), sorted by name then id: each one's Secret.id, the name it is delivered under
 * and its updatedAt. One query; never reads a value or ciphertext. Rejects if the read fails.
 */
export async function agentSecretVersions(
  db: Pick<PrismaClient, "$queryRaw">,
  agentId: string,
): Promise<SecretVersion[]> {
  const rows = await db.$queryRaw<{ id: string; name: string; updatedAt: Date }[]>`
    SELECT s."id", a."boundName" AS "name", s."updatedAt"
      FROM "AgentSecret" a
      JOIN "Secret" s ON s."id" = a."secretId"
     WHERE a."agentId" = ${agentId}
    UNION ALL
    SELECT s."id", 'mcp:' || m."name" || '/' || s."name" AS "name", s."updatedAt"
      FROM "AgentMcpServer" am
      JOIN "McpServer" m ON m."id" = am."serverId"
      JOIN "Secret" s ON s."ownerId" = m."ownerId" AND s."name" = ANY(m."secretNames")
     WHERE am."agentId" = ${agentId}`;
  return rows
    .map((row) => ({ id: row.id, name: row.name, updatedAt: new Date(row.updatedAt).toISOString() }))
    .sort(compareVersions);
}

function compareVersions(a: SecretVersion, b: SecretVersion): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A stored list of secret versions (CodingRun.launchSecretVersions), or undefined when it is absent
 * or not exactly that shape. Only the three identity fields are kept.
 */
export function parseSecretVersions(value: unknown): SecretVersion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const versions: SecretVersion[] = [];
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== "object") return undefined;
    const { id, name, updatedAt } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || typeof updatedAt !== "string") return undefined;
    versions.push({ id, name, updatedAt });
  }
  return versions;
}

/** True when both lists name the same secrets at the same versions (order ignored). */
export function sameSecretVersions(a: readonly SecretVersion[], b: readonly SecretVersion[]): boolean {
  if (a.length !== b.length) return false;
  const key = (v: SecretVersion) => JSON.stringify([v.id, v.name, v.updatedAt]);
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((entry, i) => entry === right[i]);
}
