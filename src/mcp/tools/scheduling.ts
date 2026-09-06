import { validateCronExpression } from "../../core/cron.js";
import type { ReevoMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { requireOwnedAgent } from "../auth/ownership.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function registerSchedulingTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "set_schedule",
    scope: "agents:write",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, schedule: { type: "string" }, timezone: { type: "string" } },
      required: ["agentId", "schedule", "timezone"],
    },
    handler: async (args: { agentId: string; schedule: string; timezone: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      try {
        validateCronExpression(args.schedule, args.timezone);
      } catch (err) {
        throw new McpError(400, `Invalid schedule/timezone: ${err instanceof Error ? err.message : String(err)}`);
      }
      const agent = await ctx.db.agent.update({
        where: { id: args.agentId },
        data: { schedule: args.schedule, timezone: args.timezone, scheduleEnabled: true },
      });
      return textResult(agent);
    },
  });

  mcp.registerTool({
    name: "disable_schedule",
    scope: "agents:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    handler: async (args: { agentId: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      const agent = await ctx.db.agent.update({ where: { id: args.agentId }, data: { scheduleEnabled: false } });
      return textResult(agent);
    },
  });
}
