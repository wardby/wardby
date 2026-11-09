/**
 * get_run_steps: what a run did, one line per step, oldest first. Same access as get_run. Steps
 * are stored already redacted (src/core/run-steps/writer.ts) and returned as stored; a step's
 * callId is never returned; its detail text (the detail level) only to the agent's owner, the run's
 * starter and the stdio operator (canReadRunDetail).
 */
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
      `${RUN_STEPS_MAX_LIMIT}. dropped counts steps past the per-run limit. Same access as get_run.`,
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
      const rows = await ctx.db.runStep.findMany({
        where: { runId: run.id, seq: { gt: after } },
        orderBy: { seq: "asc" },
        take: take + 1,
        select: {
          seq: true,
          at: true,
          kind: true,
          tool: true,
          summary: true,
          status: true,
          ...(showDetail ? { detail: true } : {}),
        },
      });
      const page = rows.slice(0, take);
      const now = (opts.now ?? (() => new Date()))();
      const expired =
        page.length === 0 &&
        after === 0 &&
        run.finishedAt != null &&
        run.finishedAt.getTime() + opts.retentionDays * DAY_MS < now.getTime();
      return textResult({
        runId: run.id,
        level: recordedRunStepsLevel(run.runStepsLevel, opts.level),
        steps: page.map((s) => ({
          seq: s.seq,
          at: s.at.toISOString(),
          kind: s.kind,
          tool: s.tool,
          summary: s.summary,
          status: s.status,
          ...(showDetail ? { detail: s.detail ?? null } : {}),
        })),
        next: rows.length > take ? page[page.length - 1].seq : null,
        dropped: run.stepsDropped,
        ...(expired ? { expired: true, meaning: EXPIRED_MEANING } : {}),
      });
    },
  });
}
