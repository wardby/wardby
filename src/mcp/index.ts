/**
 * MCP composition root: assembles the real providers, builds one
 * ReevoMcpServer, registers every tool module, and starts whichever
 * transport MCP_TRANSPORT selects. No business logic lives here — this
 * file only wires together pieces every earlier task already built and
 * tested on their own.
 *
 * stdio vs. HTTP diverge on two things a live smoke test surfaced (see the
 * ledger): stdio needs no `MCP_CANONICAL_URI` (there's no HTTP endpoint or
 * OAuth challenge to identify) and constructs no real `AuthProvider` at all
 * (per the design: "stdio local mode: no token; the operator is trusted") —
 * building one unconditionally would make `reevo mcp` over stdio fail on
 * missing `AUTH_JWKS_URI`/`AUTH_SIGNING_KEY` a deployment running stdio-only
 * never needed to set.
 */
import { loadProviderConfig, loadMcpConfig, loadAuthConfig } from "../config/providers.js";
import { prisma } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { resolveLlmRegistrations, RoutingLlmProvider } from "../providers/llm/index.js";
import { PostgresDatastore } from "../providers/datastore/index.js";
import { InProcessExecutor } from "../providers/executor/index.js";
import { buildSecretCipher } from "../providers/secrets/index.js";
import { buildAuthProvider } from "../providers/auth/index.js";
import { SelfHostedAuthProvider } from "../providers/auth/self-hosted.js";
import { buildMcpServer, type ReevoMcpServer } from "./server.js";
import type { McpProviders } from "./context.js";
import { runStdioServer } from "./transport/stdio.js";
import { startHttpServer } from "./transport/streamable-http.js";
import { resolvePrincipal } from "./auth/principal.js";
import { SCOPES_SUPPORTED } from "./auth/resource-server.js";
import { canonicalUrl } from "./transport/http-limits.js";
import { assertSelfHostedReleased } from "../providers/auth/release-gate.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerTriggerTool } from "./tools/trigger.js";
import { registerToolAuthoringTools } from "./tools/tools.js";
import { registerSchedulingTools } from "./tools/scheduling.js";
import { registerRunTools } from "./tools/runs.js";
import { registerDatastoreTools } from "./tools/datastore.js";
import { registerSecretsTools } from "./tools/secrets.js";
import { registerWebhookTools } from "./tools/webhooks.js";

/** Placeholder identifier for stdio, which has no HTTP endpoint to name. Never surfaced: stdio's fixed context always holds every scope, so no scope challenge is ever built against it. */
const STDIO_PLACEHOLDER_URI = "urn:reevo:local-stdio";

/** Registers the full Phase 4 tool surface — every module, in one place. */
export function registerAllTools(mcp: ReevoMcpServer): void {
  registerAgentTools(mcp);
  registerTriggerTool(mcp);
  registerToolAuthoringTools(mcp);
  registerSchedulingTools(mcp);
  registerRunTools(mcp);
  registerDatastoreTools(mcp);
  registerSecretsTools(mcp);
  registerWebhookTools(mcp);
}

export interface McpProviderComposition {
  providers: McpProviders;
}

/** Builds the real provider set (LLM/engine/datastore/secrets/executor) — shared by both transports. */
export function buildMcpProviders(): McpProviderComposition {
  const providerConfig = loadProviderConfig();

  const llmResult = resolveLlmRegistrations(providerConfig);
  if (llmResult.kind !== "registrations") {
    throw new Error(
      llmResult.kind === "bedrock-reserved"
        ? `LLM_PROVIDER "bedrock" is reserved but has no adapter yet — use "openai" and/or "anthropic".`
        : "No LLM credentials present. Set OPENAI_API_KEY and/or ANTHROPIC_API_KEY.",
    );
  }
  const llm = new RoutingLlmProvider(llmResult.registrations);
  const engine = new NativeEngine();
  const datastore = new PostgresDatastore(prisma);
  const secrets = buildSecretCipher(providerConfig);
  const executor = new InProcessExecutor({ llm, engine, datastore, secrets }, prisma);

  return { providers: { llm, engine, datastore, secrets, executor } };
}

/** The real CLI entry point: `reevo mcp`. Reads config from the environment, starts stdio or HTTP per MCP_TRANSPORT. */
export async function startMcp(): Promise<void> {
  const mcpConfig = loadMcpConfig();
  if (mcpConfig.transport === "http" && loadProviderConfig().auth === "self-hosted") assertSelfHostedReleased();
  const { providers } = buildMcpProviders();

  if (mcpConfig.transport === "stdio") {
    const mcp = buildMcpServer({ providers, db: prisma, config: { canonicalUri: STDIO_PLACEHOLDER_URI } });
    registerAllTools(mcp);

    // stdio never carries per-call AuthInfo — one fixed, fully-trusted
    // local identity for the whole connection, per the design's own
    // "stdio local mode: no token; the operator is trusted."
    const principal = await resolvePrincipal(mcpConfig.localPrincipal, prisma);
    mcp.setFixedContext({
      principal,
      scopes: new Set(SCOPES_SUPPORTED),
      providers,
      db: prisma,
      clientSupportsTasks: false,
    });
    runStdioServer(mcp);
    return;
  }

  if (!mcpConfig.canonicalUri) {
    throw new Error("MCP_CANONICAL_URI is required when MCP_TRANSPORT=http.");
  }
  if (!mcpConfig.httpBind) {
    throw new Error("MCP_HTTP_BIND is required when MCP_TRANSPORT=http.");
  }

  const providerConfig = loadProviderConfig();
  const authConfig = loadAuthConfig();
  if (!authConfig.audience || canonicalUrl(mcpConfig.canonicalUri).href !== canonicalUrl(authConfig.audience).href) {
    throw new Error("MCP_CANONICAL_URI and AUTH_AUDIENCE must be identical normalized URLs.");
  }
  const authProviderKind = providerConfig.auth === "self-hosted" ? "self-hosted" : "delegating";
  const authProvider = buildAuthProvider(providerConfig.auth, authConfig, prisma);
  const selfHosted = authProviderKind === "self-hosted" ? (authProvider as SelfHostedAuthProvider) : undefined;

  const mcp = buildMcpServer({ providers, db: prisma, config: { canonicalUri: mcpConfig.canonicalUri } });
  registerAllTools(mcp);

  await startHttpServer({
    mcp,
    config: { canonicalUri: canonicalUrl(mcpConfig.canonicalUri).href, httpBind: mcpConfig.httpBind, authProviderKind, authorizationServer: authConfig.issuer, allowedOrigins: mcpConfig.allowedOrigins },
    auth: { authProvider, db: prisma, providers },
    selfHosted,
  });
}
