/**
 * Operator inspection of agent memory, mirroring the Datastore MCP tools
 * (`./datastore.ts`). Memory is agent *data*, written by every triggerer's
 * runs, so every tool here is owner-only whatever the grants (resource-
 * sharing grants spec §3.4.6): showing it at read or execute would leak one
 * triggerer's run output to another (A6 through memory).
 */
import type { WardbyMcpServer } from "../server.js";
import { requireAgentAccess } from "../auth/access.js";
import { textResult } from "./text-result.js";

export function registerMemoryTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "get_agent_memory",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, key: { type: "string" } },
      required: ["agentId", "key"],
    },
    handler: async (args: { agentId: string; key: string }, ctx) => {
      await requireAgentAccess(ctx, args.agentId, "owner");
      const content = await ctx.providers.memory.get(args.agentId, args.key);
      return textResult({ content: content ?? null });
    },
  });

  mcp.registerTool({
    name: "list_agent_memory",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
    handler: async (args: { agentId: string }, ctx) => {
      await requireAgentAccess(ctx, args.agentId, "owner");
      const keys = await ctx.providers.memory.list(args.agentId);
      return textResult(keys);
    },
  });

  mcp.registerTool({
    name: "set_agent_memory",
    scope: "memory:write",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, key: { type: "string" }, content: { type: "string" } },
      required: ["agentId", "key", "content"],
    },
    handler: async (args: { agentId: string; key: string; content: string }, ctx) => {
      await requireAgentAccess(ctx, args.agentId, "owner");
      await ctx.providers.memory.set(args.agentId, args.key, args.content);
      return textResult({ ok: true });
    },
  });

  mcp.registerTool({
    name: "delete_agent_memory",
    scope: "memory:write",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, key: { type: "string" } },
      required: ["agentId", "key"],
    },
    handler: async (args: { agentId: string; key: string }, ctx) => {
      await requireAgentAccess(ctx, args.agentId, "owner");
      await ctx.providers.memory.delete(args.agentId, args.key);
      return textResult({ ok: true });
    },
  });
}
