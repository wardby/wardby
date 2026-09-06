/**
 * Agent CRUD tools. Scope is enforced generically by server.ts's registerTool
 * wrapper before a handler ever runs (see Task 6) — this file only adds
 * ownership: a mutating call must own the target agent, and a read is
 * limited to the caller's own agents plus public (null-owner) ones, the
 * same visibility rule get_agent and list_agents both apply. No business
 * logic beyond that lives here; handlers call Prisma directly.
 */
import type { ReevoMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { canRead, requireOwnedAgent, visibleToPrincipal } from "../auth/ownership.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function registerAgentTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "create_agent",
    scope: "agents:write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        systemPrompt: { type: "string" },
        model: { type: "string" },
        budgetUsd: { type: "number" },
        maxTurns: { type: "number" },
        schedule: { type: "string" },
        timezone: { type: "string" },
      },
      required: ["name", "systemPrompt", "model", "budgetUsd"],
    },
    handler: async (
      args: { name: string; systemPrompt: string; model: string; budgetUsd: number; maxTurns?: number; schedule?: string; timezone?: string },
      ctx,
    ) => {
      const agent = await ctx.db.agent.create({
        data: {
          name: args.name,
          systemPrompt: args.systemPrompt,
          model: args.model,
          budgetUsd: args.budgetUsd,
          ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
          ...(args.schedule !== undefined ? { schedule: args.schedule } : {}),
          ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
          ownerId: ctx.principal.id,
        },
      });
      return textResult(agent);
    },
  });

  mcp.registerTool({
    name: "update_agent",
    scope: "agents:write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        systemPrompt: { type: "string" },
        model: { type: "string" },
        budgetUsd: { type: "number" },
        maxTurns: { type: "number" },
      },
      required: ["id"],
    },
    handler: async (
      args: { id: string; name?: string; systemPrompt?: string; model?: string; budgetUsd?: number; maxTurns?: number },
      ctx,
    ) => {
      await requireOwnedAgent(ctx.db, args.id, ctx.principal.id);
      const { id, ...updates } = args;
      const agent = await ctx.db.agent.update({ where: { id }, data: updates });
      return textResult(agent);
    },
  });

  mcp.registerTool({
    name: "list_agents",
    scope: "agents:read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: Record<string, never>, ctx) => {
      const agents = await ctx.db.agent.findMany({
        where: visibleToPrincipal(ctx.principal.id),
      });
      return textResult(agents);
    },
  });

  mcp.registerTool({
    name: "get_agent",
    scope: "agents:read",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args: { id: string }, ctx) => {
      const agent = await ctx.db.agent.findUnique({
        where: { id: args.id },
        include: { tools: { include: { tool: true } } },
      });
      if (!agent || !canRead(agent.ownerId, ctx.principal.id)) {
        throw new McpError(404, `Agent "${args.id}" not found.`);
      }
      return textResult(agent);
    },
  });

  mcp.registerTool({
    name: "delete_agent",
    scope: "agents:write",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args: { id: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.id, ctx.principal.id);
      await ctx.db.agent.delete({ where: { id: args.id } });
      return textResult({ deleted: args.id });
    },
  });
}
