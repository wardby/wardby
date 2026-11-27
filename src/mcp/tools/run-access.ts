import type { PrismaClient, Run } from "#prisma";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import { isOwnerAll } from "../auth/resource-server.js";
import { atLeast, effectiveAccess, type GrantDb } from "../../core/grants.js";

/** Who is asking to read a run: a principal, and whether it is the stdio local operator. */
export interface RunReader {
  principalId: string;
  operator?: boolean;
}

/**
 * Run visibility (resource-sharing grants spec §3.5, A6, widened for join): a run's triggerer keeps
 * seeing it even after losing access to the agent; otherwise anyone with execute on the agent (its
 * owner included, and the stdio operator). Read on the agent is not enough. Execute is the level
 * that may join a run (join_run), so it sees every run of the agent, whoever started it. Only the
 * owner and the reader's own grants count: an everyone grant (a public agent) never shows one
 * person's runs to everyone.
 * TEAMS (#639, team-aware access): when team access lands, resolve this through accessFor/actsFor so a team member's execute counts too.
 */
export async function canReadRun(
  db: GrantDb & Pick<PrismaClient, "agent">,
  run: Pick<Run, "agentId" | "triggeredById">,
  reader: RunReader,
): Promise<boolean> {
  if (run.triggeredById !== null && run.triggeredById === reader.principalId) return true;
  const agent = await db.agent.findUnique({ where: { id: run.agentId }, select: { id: true, ownerId: true } });
  if (!agent) return false;
  return atLeast(
    "agent",
    await effectiveAccess(db, "agent", agent, reader.principalId, {
      operator: reader.operator === true,
      excludeEveryone: true,
    }),
    "execute",
  );
}

/**
 * Detail text (the run steps' detail level): the run's starter, the stdio operator, or anyone with
 * execute on the agent. The same readers as canReadRun, by decision (join): a person who joins a run
 * needs the full text of the messages and the agent's replies. Kept as its own function so that a
 * way to read runs added later does not reach detail text without its own decision.
 * TEAMS (#639, team-aware access): when team access lands, resolve this through accessFor/actsFor so a team member's execute counts too.
 */
export async function canReadRunDetail(
  db: GrantDb & Pick<PrismaClient, "agent">,
  run: Pick<Run, "agentId" | "triggeredById">,
  reader: RunReader,
): Promise<boolean> {
  if (reader.operator === true) return true;
  if (run.triggeredById !== null && run.triggeredById === reader.principalId) return true;
  const agent = await db.agent.findUnique({ where: { id: run.agentId }, select: { id: true, ownerId: true } });
  if (!agent) return false;
  return atLeast(
    "agent",
    await effectiveAccess(db, "agent", agent, reader.principalId, { excludeEveryone: true }),
    "execute",
  );
}

/** The run, when the caller may read it (canReadRun); otherwise the same 404 a missing run gets. */
export async function findReadableRun(ctx: McpRequestContext, runId: string): Promise<Run> {
  const run = await ctx.db.run.findUnique({ where: { id: runId } });
  const notFound = new McpError(404, `Run "${runId}" not found.`);
  if (!run) throw notFound;
  if (
    !(await canReadRun(ctx.db, run, {
      principalId: ctx.principal.id,
      operator: ctx.operator === true || isOwnerAll(ctx),
    }))
  )
    throw notFound;
  return run;
}
