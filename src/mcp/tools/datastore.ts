import type { ReevoMcpServer } from "../server.js";
import type { DatastoreValue } from "../../providers/index.js";
import { requireOwnedAgent, requireReadableAgent } from "../auth/ownership.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function registerDatastoreTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "datastore_get",
    scope: "agents:read",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, key: { type: "string" } }, required: ["agentId", "key"] },
    handler: async (args: { agentId: string; key: string }, ctx) => {
      await requireReadableAgent(ctx.db, args.agentId, ctx.principal.id);
      const value = await ctx.providers.datastore.get(args.agentId, args.key);
      return textResult({ value: value ?? null });
    },
  });

  mcp.registerTool({
    name: "datastore_list",
    scope: "agents:read",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, prefix: { type: "string" } }, required: ["agentId"] },
    handler: async (args: { agentId: string; prefix?: string }, ctx) => {
      await requireReadableAgent(ctx.db, args.agentId, ctx.principal.id);
      const keys = await ctx.providers.datastore.list(args.agentId, args.prefix);
      return textResult(keys);
    },
  });

  mcp.registerTool({
    name: "datastore_set",
    scope: "datastore:write",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, key: { type: "string" }, value: {} },
      required: ["agentId", "key", "value"],
    },
    handler: async (args: { agentId: string; key: string; value: DatastoreValue }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      await ctx.providers.datastore.set(args.agentId, args.key, args.value);
      return textResult({ ok: true });
    },
  });

  mcp.registerTool({
    name: "datastore_delete",
    scope: "datastore:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, key: { type: "string" } }, required: ["agentId", "key"] },
    handler: async (args: { agentId: string; key: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      await ctx.providers.datastore.delete(args.agentId, args.key);
      return textResult({ ok: true });
    },
  });
}
