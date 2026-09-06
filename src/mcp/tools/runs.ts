import type { ReevoMcpServer } from "../server.js";
import { McpError } from "../errors.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function requireOwnedAgent(db: import("@prisma/client").PrismaClient, id: string, principalId: string) {
  const agent = await db.agent.findUnique({ where: { id } });
  if (!agent) throw new McpError(404, `Agent "${id}" not found.`);
  if (agent.ownerId !== principalId) throw new McpError(403, `Agent "${id}" is not owned by the caller.`);
  return agent;
}

export function registerRunTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "list_runs",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, status: { type: "string" }, limit: { type: "number" } },
      required: ["agentId"],
    },
    handler: async (args: { agentId: string; status?: string; limit?: number }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      const runs = await ctx.db.run.findMany({
        where: { agentId: args.agentId, ...(args.status ? { status: args.status as never } : {}) },
        take: args.limit,
        orderBy: { startedAt: "desc" },
      });
      return textResult(runs);
    },
  });

  mcp.registerTool({
    name: "get_run",
    scope: "agents:read",
    inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
    handler: async (args: { runId: string }, ctx) => {
      const run = await ctx.db.run.findUnique({ where: { id: args.runId } });
      if (!run) throw new McpError(404, `Run "${args.runId}" not found.`);
      await requireOwnedAgent(ctx.db, run.agentId, ctx.principal.id);
      return textResult(run);
    },
  });
}
