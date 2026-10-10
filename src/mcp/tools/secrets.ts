/**
 * MCP secrets tools — thin wrappers over core/secrets.ts. The write-only /
 * never-returned invariants are enforced there (listSecrets already omits
 * value/ciphertext at the source); this file adds ownership on top.
 */
import { inputRequired, inputResponse } from "@modelcontextprotocol/server";
import type { PrismaClient } from "#prisma";
import {
  createSecret,
  listSecrets,
  attachSecret,
  detachSecret,
  deleteSecret,
  setSecretBroker,
} from "../../core/secrets.js";
import { brokerConfigHash, parseSecretBrokerConfig, type SecretBrokerConfig } from "../../core/secret-broker-config.js";
import type { WardbyMcpServer } from "../server.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import { requireOwnedSecret } from "../auth/ownership.js";
import { requireAgentAccess, requireBindingOwner } from "../auth/access.js";
import {
  clearUnbrokerOutcome,
  getSecretElicitationOutcome,
  type SecretElicitationPayload,
} from "./secret-elicitation.js";
import { allowedSecretNames, brokerCompatibilityWarnings } from "./secret-broker-compat.js";
import { textResult } from "./text-result.js";

const BROKER_SCHEMA_DOC =
  '{ hosts: exact hostnames, pathPrefixes?: ["/..."], placement: { kind: "header", name, format containing {value} } | { kind: "query", name } | { kind: "body", field } | { kind: "aws-sigv4", region, service } }';

/** Validates a caller-supplied broker config; an invalid one is the caller's 400. */
function parseBrokerArg(input: unknown): SecretBrokerConfig {
  try {
    return parseSecretBrokerConfig(input);
  } catch (err) {
    throw new McpError(400, err instanceof Error ? err.message : String(err));
  }
}

/** Maps core/secrets.ts's coded errors to MCP statuses; anything else propagates unchanged. */
function mapSecretError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("secret_not_found")) throw new McpError(404, message);
  if (message.startsWith("secret_broker_config_invalid") || message.startsWith("secret_broker_value_invalid")) {
    throw new McpError(400, message);
  }
  throw err;
}

/**
 * Non-blocking warnings: tools that can see this secret (under any alias it is
 * attached as) but still read it with secrets.get(), which a brokered secret refuses.
 */
async function brokerWarningsForSecret(db: PrismaClient, ownerId: string, name: string): Promise<string[]> {
  const bindings = await db.agentSecret.findMany({
    where: { secret: { ownerId, name } },
    select: { agentId: true, boundName: true },
  });
  if (!bindings.length) return [];
  const aliasesByAgent = new Map<string, Set<string>>();
  for (const b of bindings) {
    const aliases = aliasesByAgent.get(b.agentId) ?? new Set<string>();
    aliases.add(b.boundName);
    aliasesByAgent.set(b.agentId, aliases);
  }
  const attachments = await db.agentTool.findMany({
    where: { agentId: { in: [...aliasesByAgent.keys()] } },
    include: { tool: { select: { name: true, code: true } } },
  });
  const warnings = new Set<string>();
  for (const a of attachments) {
    const tools = [{ name: a.tool.name, code: a.tool.code, allowedSecrets: allowedSecretNames(a.allowedSecrets) }];
    for (const w of brokerCompatibilityWarnings(tools, aliasesByAgent.get(a.agentId)!)) warnings.add(w);
  }
  return [...warnings];
}

function withWarnings<T extends object>(body: T, warnings: string[]): T & { warnings?: string[] } {
  return warnings.length ? { ...body, warnings } : body;
}

async function findOwnSecret(ctx: McpRequestContext, name: string) {
  const secret = await ctx.db.secret.findUnique({ where: { ownerId_name: { ownerId: ctx.principal.id, name } } });
  if (!secret) throw new McpError(404, `secret_not_found: no secret named "${name}"`);
  return secret;
}

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
      'Creates a secret. Omit "value" to enter it securely via a one-time browser link instead of passing it as a plaintext argument. Pass "broker" ({ hosts, pathPrefixes?, placement }) to make it brokered: tools can then only send it to those hosts with fetch(url, { secrets: [name] }) and can never read it. See the help article "brokered-secrets".',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        value: { type: "string" },
        broker: { type: "object", description: `Optional broker config: ${BROKER_SCHEMA_DOC}` },
      },
      required: ["name"],
    },
    handler: async (args: { name: string; value?: string; broker?: unknown }, ctx) => {
      const broker = args.broker === undefined ? undefined : parseBrokerArg(args.broker);
      if (args.value !== undefined) {
        let secret;
        try {
          secret = await createSecret(args.name, args.value, ctx.principal.id, ctx.providers.secrets, ctx.db, {
            broker,
            via: "mcp",
          });
        } catch (err) {
          mapSecretError(err);
        }
        // A fresh broker config supersedes any earlier, browser-confirmed removal still on record.
        if (broker) await clearUnbrokerOutcome(ctx.principal.id, args.name, ctx.db);
        return textResult({
          id: secret.id,
          name: secret.name,
          keyId: secret.keyId,
          createdAt: secret.createdAt,
          broker: secret.broker == null ? null : parseSecretBrokerConfig(secret.broker),
        });
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

      const payload: SecretElicitationPayload = {
        ownerId: ctx.principal.id,
        secretName: args.name,
        kind: "create",
        ...(broker ? { broker } : {}),
      };
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
    name: "set_secret_broker",
    scope: "secrets:write",
    description:
      'Sets or changes a secret\'s broker config ({ hosts, pathPrefixes?, placement }), so tools can only send it to those hosts with fetch(url, { secrets: [name] }) and never read it. broker: null removes brokering, which must be confirmed by a person in the browser link this returns. Every change is audited. See the help article "brokered-secrets".',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        broker: {
          type: ["object", "null"],
          description: `The broker config ${BROKER_SCHEMA_DOC}, or null to remove brokering (browser-confirmed).`,
        },
      },
      required: ["name", "broker"],
    },
    handler: async (args: { name: string; broker: unknown }, ctx) => {
      const ownerId = ctx.principal.id;
      if (args.broker !== null) {
        const broker = parseBrokerArg(args.broker);
        await findOwnSecret(ctx, args.name);
        let change;
        try {
          change = await setSecretBroker(ctx.db, ctx.providers.secrets, {
            ownerId,
            name: args.name,
            broker,
            actorId: ownerId,
            via: "mcp",
          });
        } catch (err) {
          mapSecretError(err);
        }
        await clearUnbrokerOutcome(ownerId, args.name, ctx.db);
        const warnings = await brokerWarningsForSecret(ctx.db, ownerId, args.name);
        return textResult(withWarnings({ name: args.name, before: change.before, broker: change.after }, warnings));
      }

      // broker: null — never removed here. Only a person submitting the
      // browser form (fulfillUnbrokerElicitation) removes it; this call hands
      // out the link and, once that has happened, reports it.
      if (opts.protocolElicitation) {
        const state = ctx.mcpReq.requestState<SecretElicitationPayload>();
        if (state) {
          const view = inputResponse(ctx.mcpReq.inputResponses, "confirmUnbroker");
          if (view.kind === "elicit" && view.action !== "accept") {
            throw new McpError(400, `Removing brokering was ${view.action}d.`);
          }
        }
      }

      const existingOutcome = await getSecretElicitationOutcome(ownerId, args.name, ctx.db, "unbroker");
      if (existingOutcome) {
        if (!existingOutcome.ok) mapSecretError(new Error(existingOutcome.error));
        return textResult({ unbrokered: true, secret: existingOutcome.secret });
      }

      const secret = await findOwnSecret(ctx, args.name);
      if (secret.broker == null) {
        // Nothing to remove, so nothing for a person to confirm.
        const metadata = (await listSecrets(ownerId, ctx.db)).find((s) => s.id === secret.id);
        return textResult({ unbrokered: true, secret: metadata });
      }

      // The hash pins the link to the config being confirmed: if it changes before
      // the person submits, fulfillUnbrokerElicitation refuses (secret_broker_changed).
      const payload: SecretElicitationPayload = {
        ownerId,
        secretName: args.name,
        kind: "unbroker",
        brokerHash: brokerConfigHash(parseSecretBrokerConfig(secret.broker)),
      };
      const token = await mcp.mintRequestState(payload);
      const url = await opts.buildElicitationUrl(token);

      if (opts.protocolElicitation) {
        return inputRequired({
          requestState: token,
          inputRequests: {
            confirmUnbroker: inputRequired.elicitUrl({
              url,
              message: `Confirm removing brokering for secret "${args.name}" in your browser.`,
            }),
          },
        });
      }

      return textResult({
        status: "pending",
        message: `Open this link in your browser to confirm removing brokering for secret "${args.name}", then call set_secret_broker again with broker: null to finish.`,
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
