import { createWebhook, listWebhooks, deleteWebhook } from "../../core/webhooks.js";
import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { requireAgentAccess } from "../auth/access.js";
import { textResult } from "./text-result.js";

export function registerWebhookTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "create_webhook",
    scope: "webhooks:write",
    description:
      "Creates a standing trigger for an agent (needs write on it) and returns its secret once. It fires only while you still own the agent or hold execute on it.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    handler: async (args: { agentId: string }, ctx) => {
      // A standing trigger that can also carry task text for a native agent:
      // write, not just execute (resource-sharing grants spec §3.10).
      await requireAgentAccess(ctx, args.agentId, "write");
      const created = await createWebhook(args.agentId, ctx.principal.id, ctx.db);
      return textResult(created);
    },
  });

  mcp.registerTool({
    name: "list_webhooks",
    scope: "webhooks:write",
    description: "Lists webhooks you created, and every webhook on an agent you own.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: Record<string, never>, ctx) => {
      const webhooks = await listWebhooks(ctx.principal.id, ctx.db, { all: ctx.operator === true });
      return textResult(webhooks);
    },
  });

  mcp.registerTool({
    name: "delete_webhook",
    scope: "webhooks:write",
    description: "Deletes a webhook you created, or any webhook on an agent you own.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args: { id: string }, ctx) => {
      const webhook = await ctx.db.webhook.findUnique({ where: { id: args.id }, include: { agent: true } });
      const principalId = ctx.principal.id;
      const allowed =
        webhook !== null &&
        (ctx.operator === true || webhook.ownerId === principalId || webhook.agent.ownerId === principalId);
      if (!allowed) throw new McpError(403, `Webhook "${args.id}" is not owned by the caller.`);
      await deleteWebhook(args.id, ctx.db);
      return textResult({ deleted: args.id });
    },
  });
}
