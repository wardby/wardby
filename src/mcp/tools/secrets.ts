/**
 * MCP secrets tools — thin wrappers over core/secrets.ts. The write-only /
 * never-returned invariants are enforced there (listSecrets already omits
 * value/ciphertext at the source); this file adds ownership on top.
 */
import { inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { createSecret, listSecrets, attachSecret, detachSecret, deleteSecret } from "../../core/secrets.js";
import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { requireOwnedSecret } from "../auth/ownership.js";
import { requireAgentAccess, requireBindingOwner } from "../auth/access.js";
import { getSecretElicitationOutcome, type SecretElicitationPayload } from "./secret-elicitation.js";
import { textResult } from "./text-result.js";

/** Builds the browser-form URL for a minted token — stdio's ephemeral loopback server or the HTTP transport's mounted route (see mcp/index.ts and streamable-http.ts). */
export type SecretElicitationUrlBuilder = (token: string) => Promise<string>;

export interface SecretsToolsOptions {
  buildElicitationUrl: SecretElicitationUrlBuilder;
  /**
   * Use the MCP protocol's own URL-mode elicitation (InputRequiredResult)
   * instead of the plain-text "here's a link, call me again" fallback.
   * See McpConfig.secretElicitationProtocol for why this defaults off.
   */
  protocolElicitation: boolean;
}

export function registerSecretsTools(mcp: WardbyMcpServer, opts: SecretsToolsOptions): void {
  mcp.registerTool({
    name: "create_secret",
    scope: "secrets:write",
    description:
      'Creates a secret. Omit "value" to enter it securely via a one-time browser link instead of passing it as a plaintext argument.',
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, value: { type: "string" } },
      required: ["name"],
    },
    handler: async (args: { name: string; value?: string }, ctx) => {
      if (args.value !== undefined) {
        const secret = await createSecret(args.name, args.value, ctx.principal.id, ctx.providers.secrets, ctx.db);
        return textResult({ id: secret.id, name: secret.name, keyId: secret.keyId, createdAt: secret.createdAt });
      }

      if (opts.protocolElicitation) {
        const state = ctx.mcpReq.requestState<SecretElicitationPayload>();
        if (state) {
          const view = inputResponse(ctx.mcpReq.inputResponses, "secretValue");
          if (view.kind === "elicit" && view.action !== "accept") {
            throw new McpError(400, `Secret entry was ${view.action}d.`);
          }
          // Not yet submitted in the browser falls through to the shared
          // outcome check below, then re-mints so the client's retry/cancel
          // controls apply to the fresh elicitation.
        }
      }

      const existingOutcome = await getSecretElicitationOutcome(ctx.principal.id, args.name, ctx.db);
      if (existingOutcome) {
        if (!existingOutcome.ok) throw new McpError(400, existingOutcome.error);
        return textResult(existingOutcome.secret);
      }

      const payload: SecretElicitationPayload = { ownerId: ctx.principal.id, secretName: args.name };
      const token = await mcp.mintRequestState(payload);
      const url = await opts.buildElicitationUrl(token);

      if (opts.protocolElicitation) {
        return inputRequired({
          requestState: token,
          inputRequests: {
            secretValue: inputRequired.elicitUrl({
              url,
              message: `Enter the value for secret "${args.name}" in your browser.`,
            }),
          },
        });
      }

      // Polling fallback: no MCP protocol feature required, so it works
      // regardless of what the connecting client declares support for.
      return textResult({
        status: "pending",
        message: `Open this link in your browser to enter the value for secret "${args.name}", then call create_secret again with the same name to finish.`,
        url,
      });
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
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        name: { type: "string" },
        alias: { type: "string" },
      },
      required: ["agentId", "name"],
    },
    handler: async (args: { agentId: string; name: string; alias?: string }, ctx) => {
      // Strictly the agent owner's own secret on the owner's own agent
      // (A2/S2-2): a binding hands the value to every tool the owner lets
      // read it. Not even the stdio operator crosses owners.
      const { agent } = await requireAgentAccess(ctx, args.agentId, "read");
      requireBindingOwner(ctx, agent);
      const ownerId = agent.ownerId!;
      try {
        // Resolved among the agent owner's secrets (== the caller here).
        await attachSecret(args.agentId, args.name, ownerId, ctx.db, args.alias ?? args.name);
      } catch (err) {
        throw new McpError(404, err instanceof Error ? err.message : String(err));
      }
      return textResult({ attached: true });
    },
  });

  mcp.registerTool({
    name: "detach_secret",
    scope: "secrets:write",
    description:
      "Detaches a secret from an agent. `name` is the alias it was attached under; the secret's own name also works when no attachment has that alias.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, name: { type: "string" } },
      required: ["agentId", "name"],
    },
    handler: async (args: { agentId: string; name: string }, ctx) => {
      const { agent } = await requireAgentAccess(ctx, args.agentId, "read");
      requireBindingOwner(ctx, agent);
      const count = await detachSecret(args.agentId, args.name, ctx.db);
      if (count === 0) {
        throw new McpError(404, `No secret is attached to agent "${args.agentId}" as "${args.name}".`);
      }
      return textResult({ detached: true, count });
    },
  });

  mcp.registerTool({
    name: "delete_secret",
    scope: "secrets:write",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args: { id: string }, ctx) => {
      await requireOwnedSecret(ctx.db, args.id, ctx.principal.id);
      await deleteSecret(args.id, ctx.db);
      return textResult({ deleted: args.id });
    },
  });
}
