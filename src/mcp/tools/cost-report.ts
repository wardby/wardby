import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { agentAccessResolver, readableAgentsWhere } from "../auth/access.js";
import { costReport, CostReportInputError, parseCostReportQuery, type CostVisibility } from "../../core/cost-report.js";
import { isOwnerAll } from "../auth/resource-server.js";
import { textResult } from "./text-result.js";

/**
 * Cost rolled up by issue, parent (epic, as of each run's dispatch), scope
 * (project/team), agent, model, or run. Same visibility as list_runs/get_run:
 * the agents the caller owns (Agent.ownerId), plus runs the caller
 * triggered. USD only; tokens by priced kind.
 */
export function registerCostReportTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "cost_report",
    permission: "agents:read",
    description:
      "Agent spend (USD) and tokens by kind, grouped by issue, parent (epic), scope (project/team), agent, model, or run, " +
      "over a time window (default: last 30 days). Combine filters with groupBy to drill down, e.g. groupBy=issue with parentKey. " +
      "Totals always sum each run's full cost over attributed runs, whatever the grouping; with groupBy=model, rows come from " +
      "per-model usage and can add up to less than the total when some runs have no per-model record. " +
      "`unattributed` covers visible runs in the window that have no issue; only agentId narrows it " +
      "(provider/scope/parent/issue filters do not).",
    inputSchema: {
      type: "object",
      properties: {
        groupBy: { type: "string", enum: ["issue", "parent", "scope", "agent", "model", "run"] },
        from: { type: "string", description: "ISO date (inclusive)" },
        to: { type: "string", description: "ISO date (exclusive)" },
        provider: { type: "string" },
        scopeKey: { type: "string" },
        parentKey: { type: "string" },
        issueKey: { type: "string" },
        agentId: { type: "string" },
        limit: { type: "number" },
      },
    },
    handler: async (args: unknown, ctx) => {
      let query;
      try {
        query = parseCostReportQuery(args);
      } catch (err) {
        if (err instanceof CostReportInputError) throw new McpError(400, err.message);
        throw err;
      }
      let visibility: CostVisibility | null = null;
      if (!ctx.operator && !isOwnerAll(ctx)) {
        const resolve = await agentAccessResolver(ctx);
        const agents = await ctx.db.agent.findMany({
          where: await readableAgentsWhere(ctx),
          select: { id: true, ownerId: true },
        });
        visibility = {
          ownedAgentIds: agents.filter((a) => resolve(a) === "owner").map((a) => a.id),
          principalId: ctx.principal.id,
        };
      }
      return textResult(await costReport(ctx.db, query, visibility));
    },
  });
}
