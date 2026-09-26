import { Prisma } from "#prisma";
import { validateCronExpression } from "../../core/cron.js";
import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { assertAgentAccess, requireAgentAccess } from "../auth/access.js";
import { textResult } from "./text-result.js";

export function registerSchedulingTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "set_schedule",
    scope: "agents:write",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, schedule: { type: "string" }, timezone: { type: "string" } },
      required: ["agentId", "schedule", "timezone"],
    },
    handler: async (args: { agentId: string; schedule: string; timezone: string }, ctx) => {
      try {
        validateCronExpression(args.schedule, args.timezone);
      } catch (err) {
        throw new McpError(400, `Invalid schedule/timezone: ${err instanceof Error ? err.message : String(err)}`);
      }
      const agent = await ctx.db.$transaction(
        async (tx) => {
          const { agent: existing } = await assertAgentAccess(
            ctx,
            await tx.agent.findUnique({ where: { id: args.agentId }, include: { codingProfile: true } }),
            args.agentId,
            "write",
            tx,
          );
          if (existing.kind === "coding" && !existing.codingProfile?.defaultTask) {
            throw new McpError(400, "A default task is required before enabling a coding-agent schedule.");
          }
          return tx.agent.update({
            where: { id: args.agentId },
            data: { schedule: args.schedule, timezone: args.timezone, scheduleEnabled: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return textResult(agent);
    },
  });

  mcp.registerTool({
    name: "disable_schedule",
    scope: "agents:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    handler: async (args: { agentId: string }, ctx) => {
      await requireAgentAccess(ctx, args.agentId, "write");
      const agent = await ctx.db.agent.update({ where: { id: args.agentId }, data: { scheduleEnabled: false } });
      return textResult(agent);
    },
  });
}
