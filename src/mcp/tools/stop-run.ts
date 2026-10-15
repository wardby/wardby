/**
 * stop_run: stops a run that is still pending (including a coding run queued for a slot) or
 * running, and the delegated child runs it has in flight (src/core/stop-run.ts). A run that already
 * finished is returned unchanged, so calling it again is harmless.
 *
 * Access mirrors trigger_agent: stopping a run needs execute on its agent. Runs are visible only to
 * the agent's owner and to the run's triggerer (get_run's rule), so anyone else gets the same 404 as
 * for a missing run; a triggerer whose access to the agent has dropped below execute gets a 403.
 */
import { z } from "zod";
import { atLeast } from "../../core/grants.js";
import { stopRun } from "../../core/stop-run.js";
import { agentAccess, insufficientAgentAccess } from "../auth/access.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const StopRunSchema = z
  .object({
    runId: z.string().trim().min(1).max(128),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export function registerStopRunTool(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "stop_run",
    scope: "runs:trigger",
    description:
      "Stop a run that is pending, queued, or running, and the sub-agent runs it delegated that are still in " +
      "flight. The run ends as `cancelled`; a coding run's worker is stopped and opens or updates no pull " +
      "request. A run that already finished is returned unchanged. Needs execute access to the run's agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string" },
        reason: {
          type: "string",
          description: "Why the run is being stopped; recorded on the run (up to 500 characters).",
        },
      },
      required: ["runId"],
    },
    handler: async (raw: unknown, ctx) => {
      const parsed = StopRunSchema.safeParse(raw);
      if (!parsed.success) {
        const details = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
        throw new McpError(400, `Invalid stop_run arguments: ${details}`);
      }
      const { runId, reason } = parsed.data;

      const notFound = new McpError(404, `Run "${runId}" not found.`);
      const run = await ctx.db.run.findUnique({
        where: { id: runId },
        select: { id: true, agentId: true, triggeredById: true },
      });
      if (!run) throw notFound;
      const agent = await ctx.db.agent.findUnique({ where: { id: run.agentId }, select: { id: true, ownerId: true } });
      if (!agent) throw notFound;
      const access = await agentAccess(ctx, agent);
      const isTriggerer = run.triggeredById !== null && run.triggeredById === ctx.principal.id;
      // Visible to the agent's owner and the run's triggerer only, exactly as get_run.
      if (access !== "owner" && !isTriggerer) throw notFound;
      if (!atLeast("agent", access, "execute")) throw insufficientAgentAccess(agent.id, "execute", access);

      const result = await stopRun({
        db: ctx.db,
        executor: ctx.providers.executor,
        runId,
        stoppedBy: ctx.principal.id,
        reason,
      });
      const message = !result.stopRequested
        ? `Run already finished as ${result.status}; nothing was changed.`
        : result.status === "cancelled"
          ? "Run stopped."
          : result.status === "pending" || result.status === "running"
            ? `Stop requested; the run is still ${result.status}. Check it again with get_run.`
            : `The run finished as ${result.status} before the stop took effect.`;
      return textResult({ ...result, message });
    },
  });
}
