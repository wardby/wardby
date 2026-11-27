import { createWebhook, listWebhooks, deleteWebhook } from "../../core/webhooks.js";
import type { WardbyMcpServer } from "../server.js";
import { actsForOf, requireAgentAccess } from "../auth/access.js";
import { requireWebhookAccess } from "../auth/ownership.js";
import { grantedIds } from "../../core/grants.js";
import { textResult } from "./text-result.js";
import { isOwnerAll } from "../auth/resource-server.js";

export function registerWebhookTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "create_webhook",
    permission: "webhooks:write",
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
    permission: "webhooks:write",
    description:
      "Lists webhooks you or your Teams created, every webhook on an agent you or your Teams own, and webhooks shared with you.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: Record<string, never>, ctx) => {
      const everything = ctx.operator === true || isOwnerAll(ctx);
      const acting = [...actsForOf(ctx)];
      const shared = await grantedIds(ctx.db, "webhook", acting, "read");
      // No Team and nothing shared: listWebhooks' own filter (created by the caller, or on an agent it owns).
      const where =
        everything || (acting.length === 1 && shared.length === 0)
          ? undefined
          : { OR: [{ ownerId: { in: acting } }, { agent: { ownerId: { in: acting } } }, { id: { in: shared } }] };
      const webhooks = await listWebhooks(ctx.principal.id, ctx.db, { all: everything, ...(where ? { where } : {}) });
      return textResult(webhooks);
    },
  });

  mcp.registerTool({
    name: "delete_webhook",
    permission: "webhooks:write",
    description: "Deletes a webhook you created, or any webhook on an agent you own.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args: { id: string }, ctx) => {
      await requireWebhookAccess(ctx, args.id, "owner");
      await deleteWebhook(args.id, ctx.db);
      return textResult({ deleted: args.id });
    },
  });
}
