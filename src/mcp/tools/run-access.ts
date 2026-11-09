import type { PrismaClient, Run } from "#prisma";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import { effectiveAccess, type GrantDb } from "../../core/grants.js";

/** Who is asking to read a run: a principal, and whether it is the stdio local operator. */
export interface RunReader {
  principalId: string;
  operator?: boolean;
}

/**
 * Run visibility (resource-sharing grants spec §3.5, A6): a run's triggerer
 * keeps seeing it even after losing access to the agent; otherwise only the
 * agent's owner (or the stdio operator). Read on the agent is not enough.
 */
export async function canReadRun(
  db: GrantDb & Pick<PrismaClient, "agent">,
  run: Pick<Run, "agentId" | "triggeredById">,
  reader: RunReader,
): Promise<boolean> {
  if (run.triggeredById !== null && run.triggeredById === reader.principalId) return true;
  const agent = await db.agent.findUnique({ where: { id: run.agentId }, select: { id: true, ownerId: true } });
  if (!agent) return false;
  return (
    (await effectiveAccess(db, "agent", agent, reader.principalId, { operator: reader.operator === true })) === "owner"
  );
}

/**
 * Detail text (the run steps' detail level): only the agent's owner, the run's starter, or the
 * stdio operator. Today these are exactly canReadRun's readers (no grant reaches owner access, and
 * run reads consult no admin role); this is defence in depth, so that a way to read runs added
 * later does not reach detail text without its own decision.
 */
export async function canReadRunDetail(
  db: Pick<PrismaClient, "agent">,
  run: Pick<Run, "agentId" | "triggeredById">,
  reader: RunReader,
): Promise<boolean> {
  if (reader.operator === true) return true;
  if (run.triggeredById !== null && run.triggeredById === reader.principalId) return true;
  const agent = await db.agent.findUnique({ where: { id: run.agentId }, select: { ownerId: true } });
  return agent?.ownerId != null && agent.ownerId === reader.principalId;
}

/** The run, when the caller may read it (canReadRun); otherwise the same 404 a missing run gets. */
export async function findReadableRun(ctx: McpRequestContext, runId: string): Promise<Run> {
  const run = await ctx.db.run.findUnique({ where: { id: runId } });
  const notFound = new McpError(404, `Run "${runId}" not found.`);
  if (!run) throw notFound;
  if (!(await canReadRun(ctx.db, run, { principalId: ctx.principal.id, operator: ctx.operator }))) throw notFound;
  return run;
}
