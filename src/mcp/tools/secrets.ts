/**
 * MCP secrets tools — thin wrappers over core/secrets.ts. The write-only /
 * never-returned invariants are enforced there (listSecrets already omits
 * value/ciphertext at the source); this file adds ownership on top.
 */
import { createSecret, listSecrets, attachSecret, detachSecret, deleteSecret } from "../../core/secrets.js";
import type { ReevoMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { requireOwnedAgent } from "../auth/ownership.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function registerSecretsTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "create_secret",
    scope: "secrets:write",
    inputSchema: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name", "value"] },
    handler: async (args: { name: string; value: string }, ctx) => {
      const secret = await createSecret(args.name, args.value, ctx.principal.id, ctx.providers.secrets, ctx.db);
      return textResult({ id: secret.id, name: secret.name, keyId: secret.keyId, createdAt: secret.createdAt });
    },
  });

  mcp.registerTool({
    name: "list_secrets",
    scope: "secrets:write",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: Record<string, never>, ctx) => {
      const secrets = await listSecrets(ctx.principal.id, ctx.db);
      return textResult(secrets);
    },
  });

  mcp.registerTool({
    name: "attach_secret",
    scope: "secrets:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, name: { type: "string" } }, required: ["agentId", "name"] },
    handler: async (args: { agentId: string; name: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      try {
        await attachSecret(args.agentId, args.name, ctx.principal.id, ctx.db);
      } catch (err) {
        throw new McpError(404, err instanceof Error ? err.message : String(err));
      }
      return textResult({ attached: true });
    },
  });

  mcp.registerTool({
    name: "detach_secret",
    scope: "secrets:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, name: { type: "string" } }, required: ["agentId", "name"] },
    handler: async (args: { agentId: string; name: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      await detachSecret(args.agentId, args.name, ctx.principal.id, ctx.db);
      return textResult({ detached: true });
    },
  });

  mcp.registerTool({
    name: "delete_secret",
    scope: "secrets:write",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args: { id: string }, ctx) => {
      const owned = await listSecrets(ctx.principal.id, ctx.db);
      if (!owned.some((s) => s.id === args.id)) throw new McpError(403, `Secret "${args.id}" is not owned by the caller.`);
      await deleteSecret(args.id, ctx.db);
      return textResult({ deleted: args.id });
    },
  });
}
