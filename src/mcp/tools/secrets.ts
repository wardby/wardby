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
  hostProvidersUsingSecret,
  setSecretBroker,
  WEBHOOK_SECRET_ATTACHED,
} from "../../core/secrets.js";
import { mcpServersUsingSecret } from "../../core/mcp-servers.js";
import {
  finishOAuthSecretConnect,
  OAUTH_SECRET_PURPOSE,
  OAuthSecretFlowError,
  precheckOAuthSecretConnect,
  SECRET_NOT_OAUTH,
  SECRET_OAUTH_CIPHER_FAILED,
  SECRET_OAUTH_CLIENT_ID_REQUIRED,
  SECRET_OAUTH_INPUT_TOO_LONG,
  SECRET_OAUTH_RESOURCE_INVALID,
  SECRET_OAUTH_DISCOVERY_FAILED,
  SECRET_OAUTH_MANAGED,
  SECRET_OAUTH_PROVIDER_UNAVAILABLE,
  SECRET_OAUTH_REFRESH_UNAVAILABLE,
  startOAuthSecretConnect,
} from "../../core/oauth-secrets.js";
import { OAuthLinkError } from "../../core/oauth-link.js";
import { oauthRedirectUri } from "../../core/host-identity-links.js";
import { OAuthProtocolError } from "../../core/oauth-client/http.js";
import { Prisma } from "#prisma";
import { callbackOrigin } from "./host-accounts.js";
import { brokerConfigHash, parseSecretBrokerConfig, type SecretBrokerConfig } from "../../core/secret-broker-config.js";
import type { WardbyMcpServer } from "../server.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import { requireOwnedSecret } from "../auth/ownership.js";
import { requireScope } from "../auth/resource-server.js";
import { requireAgentAccess, requireBindable, requireBindingOwner } from "../auth/access.js";
import {
  clearUnbrokerOutcome,
  getSecretElicitationOutcome,
  type SecretElicitationPayload,
} from "./secret-elicitation.js";
import { allowedSecretNames, brokerCompatibilityWarnings } from "./secret-broker-compat.js";
import { textResult } from "./text-result.js";
import {
  mintOAuthLoopbackLink,
  OAUTH_LOOPBACK_LINK_TTL_MS,
  oauthLoopbackCommand,
  type OAuthLoopbackLinkAudience,
  type OAuthLoopbackLinkPayload,
} from "./oauth-loopback-link.js";

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
  if (message.startsWith("secret_oauth_managed")) throw new McpError(409, message);
  if (
    message.startsWith("secret_broker_config_invalid") ||
    message.startsWith("secret_broker_value_invalid") ||
    message.startsWith("host_provider_webhook_secret_short")
  ) {
    throw new McpError(400, message);
  }
  throw err;
}

const CONFIRMATION_CODE_ALONE =
  "Pass confirmationCode on its own with the name; do not combine it with value, broker or oauth.";

const OAUTH_NEEDS_HTTP =
  "Connecting an OAuth secret needs wardby's HTTP transport (the sign-in callback is served at MCP_CANONICAL_URI); " +
  "use an MCP client connected over HTTP.";

const OAUTH_LOOPBACK_UNAVAILABLE =
  'secret_oauth_loopback_unavailable: this wardby server does not hand out loopback sign-in links; use oauth.callback "web"';

const OAUTH_LOOPBACK_MESSAGE =
  "Run this command in a terminal on the computer where you use your browser: it opens the sign-in, then prints a confirmation code. " +
  "Then call create_secret again with the same name and that confirmationCode. " +
  "The command holds a sign-in link for this secret that works until expiresAt: do not share it.";

/**
 * Maps the OAuth secret flow's errors to MCP statuses. Every message is a fixed constant or a
 * fixed sentence of our own; provider, Prisma and cipher text is never passed through.
 */
function mapOAuthSecretError(err: unknown): never {
  if (err instanceof OAuthLinkError) throw new McpError(err.status, err.message);
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw new McpError(409, "a secret with this name already exists");
  }
  if (err instanceof OAuthProtocolError) {
    if (err.code === "discovery_failed") throw new McpError(400, SECRET_OAUTH_DISCOVERY_FAILED);
    if (err.code === "provider_unavailable") throw new McpError(503, SECRET_OAUTH_PROVIDER_UNAVAILABLE);
    throw new McpError(502, err.message);
  }
  if (err instanceof OAuthSecretFlowError) {
    if (err.reason === "cipher_failed") throw new McpError(500, SECRET_OAUTH_CIPHER_FAILED);
    if (err.reason === "refresh_unavailable") throw new McpError(503, SECRET_OAUTH_REFRESH_UNAVAILABLE);
    if (err.reason === "bad_context" || err.reason === "issuer_mismatch") throw new McpError(400, err.message);
    throw new McpError(502, err.message);
  }
  const message = err instanceof Error ? err.message : "";
  if (message.startsWith("secret_oauth_discovery_failed")) throw new McpError(400, SECRET_OAUTH_DISCOVERY_FAILED);
  if (message.startsWith("secret_oauth_resource_invalid")) throw new McpError(400, SECRET_OAUTH_RESOURCE_INVALID);
  if (message.startsWith("secret_oauth_input_too_long")) throw new McpError(400, SECRET_OAUTH_INPUT_TOO_LONG);
  if (message.startsWith("secret_oauth_client_id_required")) throw new McpError(400, SECRET_OAUTH_CLIENT_ID_REQUIRED);
  if (message.startsWith("secret_oauth_name_taken")) throw new McpError(409, SECRET_NOT_OAUTH);
  if (message.startsWith("secret_oauth_encryption_failed")) throw new McpError(500, SECRET_OAUTH_CIPHER_FAILED);
  if (message.startsWith("secret_oauth_provider_unavailable")) {
    throw new McpError(503, SECRET_OAUTH_PROVIDER_UNAVAILABLE);
  }
  if (message.startsWith("secret_oauth_refresh_unavailable")) {
    throw new McpError(503, SECRET_OAUTH_REFRESH_UNAVAILABLE);
  }
  throw err;
}

interface OAuthArg {
  resource: string;
  scope?: string;
  clientId?: string;
  /** Where the provider sends the browser back: wardby's web callback, or the owner's CLI on 127.0.0.1. */
  callback: "web" | "loopback";
}

/** Validates the caller's `oauth` argument; an invalid one is the caller's 400. */
function parseOAuthArg(input: unknown): OAuthArg {
  const o = input as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new McpError(400, "oauth must be an object.");
  for (const key of Object.keys(o)) {
    if (key !== "resource" && key !== "scope" && key !== "clientId" && key !== "callback") {
      throw new McpError(400, `oauth has an unknown field "${key}".`);
    }
  }
  const str = (key: string, required: boolean): string | undefined => {
    const v = o[key];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || v.length === 0) throw new McpError(400, `oauth.${key} must be a non-empty string.`);
    return v;
  };
  const scope = str("scope", false);
  const clientId = str("clientId", false);
  const callback = o.callback ?? "web";
  if (callback !== "web" && callback !== "loopback") {
    throw new McpError(400, 'oauth.callback must be "web" or "loopback".');
  }
  return {
    resource: str("resource", true)!,
    ...(scope ? { scope } : {}),
    ...(clientId ? { clientId } : {}),
    callback,
  };
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

/**
 * A host provider's secret needs hosts:admin as well as secrets:write: replacing a credential
 * or its broker config changes what the provider does. True when the caller passed that check,
 * and its links say so; checked before any link is minted, and again when one is submitted.
 */
async function requireHostsAdminIfProviderSecret(ctx: McpRequestContext, name: string): Promise<boolean> {
  const secret = await ctx.db.secret.findUnique({
    where: { ownerId_name: { ownerId: ctx.principal.id, name } },
    select: { id: true },
  });
  if (!secret || (await hostProvidersUsingSecret(ctx.db, secret.id)).providers.length === 0) return false;
  requireScope(ctx, ctx.canonicalUri, "hosts:admin");
  return true;
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
  /**
   * Loopback sign-in links (`oauth.callback: "loopback"`): the origin the link names (HTTP: the
   * canonical origin; stdio: the loopback link host) and the host that will accept it. Absent: refused.
   */
  oauthLoopback?: {
    origin: () => Promise<string>;
    audience: OAuthLoopbackLinkAudience;
    now?: () => Date;
  };
}

export function registerSecretsTools(mcp: WardbyMcpServer, opts: SecretsToolsOptions): void {
  mcp.registerTool({
    name: "create_secret",
    scope: "secrets:write",
    description:
      'Creates a secret. Omit "value" to enter it securely via a one-time browser link instead of passing it as a plaintext argument. Pass "broker" ({ hosts, pathPrefixes?, placement }) to make it brokered: tools can then only send it to those hosts with fetch(url, { secrets: [name] }) and can never read it. A secret a host provider uses also needs hosts:admin. Pass `oauth: { resource }` to connect an OAuth-only service (for example a hosted MCP server) instead: it returns a sign-in link, then call again with `confirmationCode`. With `oauth.callback: "loopback"` (for providers that only accept a 127.0.0.1 redirect) it returns a command for the user to run in a terminal on their own computer instead; it prints the confirmationCode. See the help article "brokered-secrets".',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        value: { type: "string" },
        broker: { type: "object", description: `Optional broker config: ${BROKER_SCHEMA_DOC}` },
        oauth: {
          type: "object",
          description:
            'Connect an OAuth-only service: resource is its URL; scope and clientId are optional (clientId is needed only when the provider has no dynamic client registration). callback is "web" (default: sign in through wardby\'s callback page) or "loopback" (sign in through the Wardby CLI on the user\'s computer, for providers that only accept a 127.0.0.1 redirect).',
          properties: {
            resource: { type: "string" },
            scope: { type: "string" },
            clientId: { type: "string" },
            callback: { type: "string", enum: ["web", "loopback"] },
          },
          required: ["resource"],
          additionalProperties: false,
        },
        confirmationCode: { type: "string", minLength: 1, maxLength: 32 },
      },
      required: ["name"],
    },
    handler: async (
      args: { name: string; value?: string; broker?: unknown; oauth?: unknown; confirmationCode?: string },
      ctx,
    ) => {
      const hostManager = await requireHostsAdminIfProviderSecret(ctx, args.name);
      if (args.confirmationCode !== undefined) {
        if (args.value !== undefined || args.broker !== undefined || args.oauth !== undefined) {
          throw new McpError(400, CONFIRMATION_CODE_ALONE);
        }
        try {
          return textResult(
            await finishOAuthSecretConnect({
              db: ctx.db,
              cipher: ctx.providers.secrets,
              ownerId: ctx.principal.id,
              name: args.name,
              confirmationCode: args.confirmationCode,
            }),
          );
        } catch (err) {
          mapOAuthSecretError(err);
        }
      }
      if (args.oauth !== undefined) {
        if (args.value !== undefined) throw new McpError(400, "Pass either value or oauth, not both.");
        if (args.broker !== undefined) {
          throw new McpError(400, "An OAuth secret's broker is set by wardby; do not pass broker with oauth.");
        }
        const oauth = parseOAuthArg(args.oauth);
        if (oauth.callback === "loopback") {
          const loopback = opts.oauthLoopback;
          if (!loopback) throw new McpError(400, OAUTH_LOOPBACK_UNAVAILABLE);
          // No discovery yet (that runs when the CLI starts the sign-in); only the checks that need no provider.
          let resource: string;
          try {
            ({ resource } = await precheckOAuthSecretConnect({
              db: ctx.db,
              ownerId: ctx.principal.id,
              name: args.name,
              resource: oauth.resource,
              ...(oauth.scope ? { scope: oauth.scope } : {}),
              ...(oauth.clientId ? { clientId: oauth.clientId } : {}),
              options: ctx.providers.sandboxFetchOptions,
            }));
          } catch (err) {
            mapOAuthSecretError(err);
          }
          const exp = (loopback.now ?? (() => new Date()))().getTime() + OAUTH_LOOPBACK_LINK_TTL_MS;
          const payload: OAuthLoopbackLinkPayload = {
            kind: "oauth-loopback",
            principalId: ctx.principal.id,
            name: args.name,
            resource,
            ...(oauth.scope ? { scope: oauth.scope } : {}),
            ...(oauth.clientId ? { clientId: oauth.clientId } : {}),
            aud: loopback.audience,
            ...(ctx.operator && loopback.audience === "stdio" ? { operator: true } : {}),
            exp,
          };
          const link = await mintOAuthLoopbackLink((p) => mcp.mintRequestState(p), await loopback.origin(), payload);
          return textResult({
            status: "pending",
            command: oauthLoopbackCommand(link),
            expiresAt: new Date(exp).toISOString(),
            message: OAUTH_LOOPBACK_MESSAGE,
          });
        }
        const origin = callbackOrigin(ctx.canonicalUri);
        if (!origin) throw new McpError(400, OAUTH_NEEDS_HTTP);
        let started;
        try {
          started = await startOAuthSecretConnect({
            db: ctx.db,
            cipher: ctx.providers.secrets,
            ownerId: ctx.principal.id,
            name: args.name,
            resource: oauth.resource,
            ...(oauth.scope ? { scope: oauth.scope } : {}),
            ...(oauth.clientId ? { clientId: oauth.clientId } : {}),
            redirectUri: oauthRedirectUri(origin, OAUTH_SECRET_PURPOSE),
            options: ctx.providers.sandboxFetchOptions,
            fetchImpl: ctx.providers.sandboxFetch,
          });
        } catch (err) {
          mapOAuthSecretError(err);
        }
        return textResult({
          status: "pending",
          url: started.authorizeUrl,
          message:
            "Open this link in your browser and sign in, then call create_secret again with the same name and the confirmationCode the page shows.",
        });
      }
      const broker = args.broker === undefined ? undefined : parseBrokerArg(args.broker);
      if (args.value === undefined) {
        const named = await ctx.db.secret.findUnique({
          where: { ownerId_name: { ownerId: ctx.principal.id, name: args.name } },
          select: { oauth: true },
        });
        if (named?.oauth != null) throw new McpError(409, SECRET_OAUTH_MANAGED);
      }
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
        ...(hostManager ? { hostManager } : {}),
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
      'Sets or changes a secret\'s broker config ({ hosts, pathPrefixes?, placement }), so tools can only send it to those hosts with fetch(url, { secrets: [name] }) and never read it. broker: null removes brokering, which must be confirmed by a person in the browser link this returns. Every change is audited. A secret a host provider uses also needs hosts:admin. See the help article "brokered-secrets".',
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
      const hostManager = await requireHostsAdminIfProviderSecret(ctx, args.name);
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
        ...(hostManager ? { hostManager } : {}),
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
      await requireBindable(ctx, agent);
      const ownerId = agent.ownerId!;
      try {
        // Resolved among the agent owner's secrets (== the caller here).
        await attachSecret(args.agentId, args.name, ownerId, ctx.db, args.alias ?? args.name);
      } catch (err) {
        if (err instanceof Error && err.message === WEBHOOK_SECRET_ATTACHED) throw new McpError(409, err.message);
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
      const { providers } = await hostProvidersUsingSecret(ctx.db, args.id);
      if (providers.length > 0) {
        throw new McpError(
          409,
          `This secret is used by host provider ${providers.map((p) => `"${p}"`).join(", ")}; re-register it or delete_host_provider first.`,
        );
      }
      const secret = await ctx.db.secret.findUnique({ where: { id: args.id }, select: { name: true } });
      const servers = secret ? await mcpServersUsingSecret(ctx.db, ctx.principal.id, secret.name) : [];
      if (servers.length > 0) {
        throw new McpError(
          409,
          `Secret "${secret!.name}" is used by MCP server(s) ${servers.join(", ")}; update or delete them first.`,
        );
      }
      await deleteSecret(args.id, ctx.db, {
        cipher: ctx.providers.secrets,
        options: ctx.providers.sandboxFetchOptions,
        fetchImpl: ctx.providers.sandboxFetch,
        actorId: ctx.principal.id,
      });
      return textResult({ deleted: args.id });
    },
  });
}
