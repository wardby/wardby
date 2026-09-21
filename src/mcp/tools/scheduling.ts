import { Prisma } from "@prisma/client";
import { validateCronExpression } from "../../core/cron.js";
import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { assertCanMutate, requireOwnedAgent } from "../auth/ownership.js";
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
          const existing = await tx.agent.findUnique({ where: { id: args.agentId }, include: { codingProfile: true } });
          if (!existing) throw new McpError(404, `Agent "${args.agentId}" not found.`);
          assertCanMutate(existing.ownerId, ctx.principal.id, `Agent "${args.agentId}" is not owned by the caller.`);
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
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      const agent = await ctx.db.agent.update({ where: { id: args.agentId }, data: { scheduleEnabled: false } });
      return textResult(agent);
    },
  });
}
