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
 * The agents the owner's secret `secretName` is delivered to, attached directly or through an
 * attached MCP server; undefined when they can't be read (logged, ids and error class only).
 */
export async function agentsReachedBySecret(
  ctx: RoundsContext,
  ownerId: string,
  secretName: string,
): Promise<string[] | undefined> {
  if (!ctx.providers.executor?.removeRetainedRounds) return [];
  try {
    const [attached, viaServers] = await Promise.all([
      ctx.db.agentSecret.findMany({ where: { secret: { ownerId, name: secretName } }, select: { agentId: true } }),
      ctx.db.agentMcpServer.findMany({
        where: { server: { ownerId, secretNames: { has: secretName } } },
        select: { agentId: true },
      }),
    ]);
    return [...new Set([...attached, ...viaServers].map((row) => row.agentId))];
  } catch (err) {
    roundsLog.warn(
      { event: "coding.warm_remove_failed", errorName: err instanceof Error ? err.name : typeof err },
      "could not find the agents a changed secret is delivered to; their retained rounds start fresh",
    );
    return undefined;
  }
}

/**
 * The agents MCP server `serverId` is attached to; undefined when they can't be read (logged, ids
 * and error class only).
 */
export async function agentsAttachedToServer(ctx: RoundsContext, serverId: string): Promise<string[] | undefined> {
  if (!ctx.providers.executor?.removeRetainedRounds) return [];
  try {
    const rows = await ctx.db.agentMcpServer.findMany({ where: { serverId }, select: { agentId: true } });
    return [...new Set(rows.map((row) => row.agentId))];
  } catch (err) {
    roundsLog.warn(
      { serverId, event: "coding.warm_remove_failed", errorName: err instanceof Error ? err.name : typeof err },
      "could not find the agents an MCP server is attached to; their retained rounds start fresh",
    );
    return undefined;
  }
}

/** Removes the retained rounds of each of `agentIds` (none when undefined). Never throws. */
export async function removeRetainedRoundsOf(ctx: RoundsContext, agentIds: readonly string[] | undefined) {
  for (const agentId of agentIds ?? []) await removeRetainedRounds(ctx, agentId);
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
  await removeRetainedRoundsOf(ctx, await agentsReachedBySecret(ctx, ownerId, secretName));
}
