/** Operator inspection of agent memory, mirroring the Datastore MCP tools (`./datastore.ts`). */
import type { ReevoMcpServer } from "../server.js";
import { requireOwnedAgent, requireReadableAgent } from "../auth/ownership.js";
import { textResult } from "./text-result.js";

export function registerMemoryTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "get_agent_memory",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, key: { type: "string" } },
      required: ["agentId", "key"],
    },
    handler: async (args: { agentId: string; key: string }, ctx) => {
      await requireReadableAgent(ctx.db, args.agentId, ctx.principal.id);
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
      await requireReadableAgent(ctx.db, args.agentId, ctx.principal.id);
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
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
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
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      await ctx.providers.memory.delete(args.agentId, args.key);
      return textResult({ ok: true });
    },
  });
}
