import { createWebhook, listWebhooks, deleteWebhook } from "../../core/webhooks.js";
import type { ReevoMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { requireOwnedAgent } from "../auth/ownership.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function registerWebhookTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "create_webhook",
    scope: "webhooks:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    handler: async (args: { agentId: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      const created = await createWebhook(args.agentId, ctx.principal.id, ctx.db);
      return textResult(created);
    },
  });

  mcp.registerTool({
    name: "list_webhooks",
    scope: "webhooks:write",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: Record<string, never>, ctx) => {
      const webhooks = await listWebhooks(ctx.principal.id, ctx.db);
      return textResult(webhooks);
    },
  });

  mcp.registerTool({
    name: "delete_webhook",
    scope: "webhooks:write",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args: { id: string }, ctx) => {
      const owned = await listWebhooks(ctx.principal.id, ctx.db);
      if (!owned.some((w) => w.id === args.id)) throw new McpError(403, `Webhook "${args.id}" is not owned by the caller.`);
      await deleteWebhook(args.id, ctx.db);
      return textResult({ deleted: args.id });
    },
  });
}
