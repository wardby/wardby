/**
 * Warm rounds: removing an agent's retained coding sandboxes (Executor.removeRetainedRounds) when
 * something a kept round depends on changes. Best effort: a failed removal never fails the tool,
 * and the kept round would start the next round fresh anyway (its fingerprint no longer matches).
 * Only ids and the error's class name are logged: never a secret's value, or its name.
 */
import { logger } from "../../core/logger.js";
import type { McpRequestContext } from "../context.js";

const roundsLog = logger.child({ module: "mcp-retained-rounds" });

type RoundsContext = Pick<McpRequestContext, "db" | "providers">;

/** Removes `agentId`'s retained coding sandboxes. Never throws. */
export async function removeRetainedRounds(ctx: RoundsContext, agentId: string): Promise<void> {
  try {
    await ctx.providers.executor?.removeRetainedRounds?.(agentId);
  } catch (err) {
    roundsLog.warn(
      { agentId, event: "coding.warm_remove_failed", errorName: err instanceof Error ? err.name : typeof err },
      "could not remove an agent's retained rounds",
    );
  }
}

/**
 * After the owner's secret `secretName` changed (a new value, a broker change, an OAuth connect):
 * removes the retained rounds of every agent it is delivered to, attached directly or through an
 * attached MCP server. A kept round's session holds the old value, which the next round's
 * transcript would no longer be redacted against. Never throws.
 */
export async function removeRetainedRoundsForSecret(
  ctx: RoundsContext,
  ownerId: string,
  secretName: string,
): Promise<void> {
  if (!ctx.providers.executor?.removeRetainedRounds) return;
  let agentIds: string[];
  try {
    const [attached, viaServers] = await Promise.all([
      ctx.db.agentSecret.findMany({ where: { secret: { ownerId, name: secretName } }, select: { agentId: true } }),
      ctx.db.agentMcpServer.findMany({
        where: { server: { ownerId, secretNames: { has: secretName } } },
        select: { agentId: true },
      }),
    ]);
    agentIds = [...new Set([...attached, ...viaServers].map((row) => row.agentId))];
  } catch (err) {
    roundsLog.warn(
      { event: "coding.warm_remove_failed", errorName: err instanceof Error ? err.name : typeof err },
      "could not find the agents a changed secret is delivered to; their retained rounds start fresh",
    );
    return;
  }
  for (const agentId of agentIds) await removeRetainedRounds(ctx, agentId);
}
