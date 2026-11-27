/**
 * get_run_steps: what a run did, one line per step, oldest first. Same access as get_run. Steps
 * are stored already redacted (src/core/run-steps/writer.ts) and returned as stored; a step's
 * callId is never returned; its detail text (the detail level) only to the agent's owner, the run's
 * starter and the stdio operator (canReadRunDetail).
 */
import type { PrismaClient } from "#prisma";
import { recordedRunStepsLevel, type RunStepsLevel } from "../../core/run-steps/config.js";
import type { WardbyMcpServer } from "../server.js";
import { canReadRunDetail, findReadableRun } from "./run-access.js";
import { textResult } from "./text-result.js";

export const RUN_STEPS_DEFAULT_LIMIT = 50;
export const RUN_STEPS_MAX_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRED_MEANING =
  "No steps are kept for this run: steps are deleted RUN_STEP_RETENTION_DAYS after they are recorded.";

export interface RunStepsToolOptions {
  level: RunStepsLevel;
  retentionDays: number;
  now?: () => Date;
}

/** One run step as get_run_steps (and the join API, join-api.ts) return it. */
export interface RunStepView {
  seq: number;
  at: string;
  kind: string;
  tool: string | null;
  summary: string;
  status: string | null;
  agent?: string;
  from?: string;
  detail?: string | null;
}

/**
 * A page of a run's steps after `after`, oldest first, as returned to a reader: detail only when
 * `showDetail` (canReadRunDetail). `next` is the after for the next page, or null; `rows` is the
 * page's length.
 */
export async function loadRunStepsPage(
  db: Pick<PrismaClient, "runStep">,
  runId: string,
  opts: { after: number; take: number; showDetail: boolean },
): Promise<{ steps: RunStepView[]; next: number | null; rows: number }> {
  const found = await db.runStep.findMany({
    where: { runId, seq: { gt: opts.after } },
    orderBy: { seq: "asc" },
    take: opts.take + 1,
    select: {
      seq: true,
      at: true,
      kind: true,
      tool: true,
      summary: true,
      status: true,
      agentRef: true,
      fromPrincipalId: true,
      ...(opts.showDetail ? { detail: true } : {}),
    },
  });
  const page = found.slice(0, opts.take);
  const steps = page.map((s) => ({
    seq: s.seq,
    at: s.at.toISOString(),
    kind: s.kind,
    tool: s.tool,
    summary: s.summary,
    status: s.status,
    ...(s.agentRef ? { agent: s.agentRef } : {}),
    // Join steps (join, leave, message, interrupt): the principal who joined, left or sent it.
    ...(s.fromPrincipalId ? { from: s.fromPrincipalId } : {}),
    ...(opts.showDetail ? { detail: (s as { detail?: string | null }).detail ?? null } : {}),
  }));
  return { steps, next: found.length > opts.take ? page[page.length - 1].seq : null, rows: page.length };
}

export function registerRunStepsTool(mcp: WardbyMcpServer, opts: RunStepsToolOptions): void {
  mcp.registerTool({
    name: "get_run_steps",
    scope: "agents:read",
    description:
      "What a run did, one line per step, oldest first: each tool call (the tool and its command, file or first " +
      "argument, cut short) with its status once known (ok, error or exit N), and what the model said, cut short. " +
      "At the detail level (the instance's WARDBY_RUN_STEPS and the agent's runSteps both detail), the agent's owner " +
      "and the run's starter also get each step's detail: the tool's input, the end of its output, or the model's " +
      "text, redacted. Others get the lines only. level is the run's own, fixed when it started. " +
      "To follow a running run, call again with after set to the last seq you have. " +
      `next is the after for the next page, or null. limit defaults to ${RUN_STEPS_DEFAULT_LIMIT}, at most ` +
      `${RUN_STEPS_MAX_LIMIT}. dropped counts steps past the per-run limit. Same access as get_run. ` +
      "A workflow run (codingProfile.workflow) also returns workflow: its phases ({ index, title }) and sub-agents " +
      "({ id, label, phaseIndex, state, attempt }); a step a sub-agent made has agent set to that sub-agent's id, " +
      "a step with no agent is the main session's. Titles and labels come from the repository's script. " +
      "People joined to the run (join_run) add steps of kind join, leave, message and interrupt, with from set to " +
      "the person's principal id; a message's full text is its detail.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        after: { type: "number", description: "Only steps with a larger seq" },
        limit: {
          type: "number",
          description: `Steps to return (default ${RUN_STEPS_DEFAULT_LIMIT}, at most ${RUN_STEPS_MAX_LIMIT})`,
        },
      },
      required: ["runId"],
    },
    handler: async (args: { runId: string; after?: number; limit?: number }, ctx) => {
      const run = await findReadableRun(ctx, args.runId);
      const showDetail = await canReadRunDetail(ctx.db, run, {
        principalId: ctx.principal.id,
        operator: ctx.operator,
      });
      const after = Number.isFinite(args.after) ? Math.max(0, Math.floor(args.after as number)) : 0;
      const requested = Number.isFinite(args.limit) ? Math.floor(args.limit as number) : RUN_STEPS_DEFAULT_LIMIT;
      const take = Math.min(Math.max(1, requested), RUN_STEPS_MAX_LIMIT);
      const { steps, next, rows } = await loadRunStepsPage(ctx.db, run.id, { after, take, showDetail });
      // A workflow run's phases and sub-agents (#582): each step's `agent` is one of workflow.agents' ids.
      // Best effort: a failure here leaves the steps ungrouped, never the call failed.
      const workflow: unknown = await Promise.resolve()
        .then(() => ctx.db.codingRun.findUnique({ where: { runId: run.id }, select: { workflowProgress: true } }))
        .then((coding) => coding?.workflowProgress ?? null)
        .catch(() => null);
      const now = (opts.now ?? (() => new Date()))();
      const expired =
        rows === 0 &&
        after === 0 &&
        run.finishedAt != null &&
        run.finishedAt.getTime() + opts.retentionDays * DAY_MS < now.getTime();
      return textResult({
        runId: run.id,
        level: recordedRunStepsLevel(run.runStepsLevel, opts.level),
        steps,
        ...(workflow ? { workflow } : {}),
        next,
        dropped: run.stepsDropped,
        ...(expired ? { expired: true, meaning: EXPIRED_MEANING } : {}),
      });
    },
  });
}
