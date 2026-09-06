import { createWebhook, listWebhooks, deleteWebhook } from "../../core/webhooks.js";
import type { ReevoMcpServer } from "../server.js";
import { requireOwnedAgent, requireOwnedWebhook } from "../auth/ownership.js";
import { textResult } from "./text-result.js";

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
      await requireOwnedWebhook(ctx.db, args.id, ctx.principal.id);
      await deleteWebhook(args.id, ctx.db);
      return textResult({ deleted: args.id });
    },
  });
}
