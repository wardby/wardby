/**
 * MCP composition root: assembles the real providers, builds one
 * WardbyMcpServer, registers every tool module, and starts whichever
 * transport MCP_TRANSPORT selects. No business logic lives here — this
 * file only wires together pieces every earlier task already built and
 * tested on their own.
 *
 * stdio vs. HTTP diverge on two things a live smoke test surfaced (see the
 * ledger): stdio needs no `MCP_CANONICAL_URI` (there's no HTTP endpoint or
 * OAuth challenge to identify) and constructs no real `AuthProvider` at all
 * (per the design: "stdio local mode: no token; the operator is trusted") —
 * building one unconditionally would make `wardby mcp` over stdio fail on
 * missing `AUTH_JWKS_URI`/`AUTH_SIGNING_KEY` a deployment running stdio-only
 * never needed to set.
 */
import {
  loadProviderConfig,
  loadMcpConfig,
  loadAuthConfig,
  loadGitHubEventConfig,
  loadGitHubVcsConfig,
} from "../config/providers.js";
import { prisma } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { resolveLlmRegistrations, RoutingLlmProvider } from "../providers/llm/index.js";
import { PostgresDatastore } from "../providers/datastore/index.js";
import { PostgresAgentMemory } from "../providers/memory/index.js";
import { buildConfiguredExecutor, buildExecutor } from "../providers/executor/index.js";
import { buildSecretCipher } from "../providers/secrets/index.js";
import { buildReviewHosts } from "../providers/review-host/index.js";
import type { NativeRunProviders } from "../core/runner.js";
import { buildAuthProvider } from "../providers/auth/index.js";
import { GitHubAppClient } from "../providers/vcs/github.js";
import type { SelfHostedAuthProvider } from "../providers/auth/self-hosted.js";
import { buildMcpServer, type WardbyMcpServer } from "./server.js";
import type { McpProviders } from "./context.js";
import { countUnattendedSchedules, unattendedSchedulesWarning } from "./unattended-schedules.js";
import { runStdioServer } from "./transport/stdio.js";
import { startHttpServer } from "./transport/streamable-http.js";
import { resolvePrincipal } from "./auth/principal.js";
import { SCOPES_SUPPORTED } from "./auth/resource-server.js";
import { canonicalUrl } from "./transport/http-limits.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerBudgetGroupTools } from "./tools/budget-groups.js";
import { registerModelTools } from "./tools/models.js";
import { registerTriggerTool } from "./tools/trigger.js";
import { registerToolAuthoringTools } from "./tools/tools.js";
import { registerSchedulingTools } from "./tools/scheduling.js";
import { registerRunTools } from "./tools/runs.js";
import { registerDatastoreTools } from "./tools/datastore.js";
import { registerSubAgentTools } from "./tools/subagents.js";
import { registerRepositoryTools } from "./tools/repositories.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerSecretsTools, type SecretElicitationUrlBuilder } from "./tools/secrets.js";
import { registerWebhookTools } from "./tools/webhooks.js";
import { createStdioSecretElicitationHost } from "./tools/secret-elicitation-server.js";
import { SECRET_ELICITATION_PATH } from "./tools/secret-elicitation-form.js";
import { logger } from "../core/logger.js";

const mcpLog = logger.child({ module: "mcp-index" });
const SELF_HOSTED_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

/** Says out loud at startup when enabled schedules exist that nothing in this process will fire (see ./unattended-schedules.ts). */
async function warnIfNothingWillFireSchedules(): Promise<void> {
  try {
    const message = unattendedSchedulesWarning(await countUnattendedSchedules(prisma));
    if (message) mcpLog.warn(message);
  } catch (err) {
    // Advisory only - never let it stop the server coming up.
    mcpLog.debug({ err }, "could not check for unattended schedules");
  }
}

/** Placeholder identifier for stdio, which has no HTTP endpoint to name. Never surfaced: stdio's fixed context always holds every scope, so no scope challenge is ever built against it. */
const STDIO_PLACEHOLDER_URI = "urn:wardby:local-stdio";

/** Registers the full Phase 4 tool surface — every module, in one place. */
export function registerAllTools(
  mcp: WardbyMcpServer,
  opts: { secretElicitationUrl: SecretElicitationUrlBuilder; secretElicitationProtocol: boolean },
): void {
  registerAgentTools(mcp);
  registerBudgetGroupTools(mcp);
  registerModelTools(mcp);
  registerTriggerTool(mcp);
  registerToolAuthoringTools(mcp);
  registerSchedulingTools(mcp);
  registerRunTools(mcp);
  registerDatastoreTools(mcp);
  registerSubAgentTools(mcp);
  registerRepositoryTools(mcp);
  registerMemoryTools(mcp);
  registerSecretsTools(mcp, {
    buildElicitationUrl: opts.secretElicitationUrl,
    protocolElicitation: opts.secretElicitationProtocol,
  });
  registerWebhookTools(mcp);
}

export interface McpProviderComposition {
  providers: McpProviders;
}

/** Builds the real provider set (LLM/engine/datastore/secrets/executor) — shared by both transports. */
export function buildMcpProviders(): McpProviderComposition {
  const providerConfig = loadProviderConfig();

  const llmResult = resolveLlmRegistrations();
  if (llmResult.kind !== "registrations") {
    throw new Error(
      "No LLM credentials present. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, and/or BEDROCK_REGION (or AWS_REGION).",
    );
  }
  const llm = new RoutingLlmProvider(llmResult.registrations);
  const engine = new NativeEngine();
  const secrets = buildSecretCipher(providerConfig);
  const datastore = new PostgresDatastore(prisma, secrets);
  const memory = new PostgresAgentMemory(prisma);
  const reviewHosts = buildReviewHosts();
  // `nativeProviders` is passed by reference into buildExecutor, and native
  // runs it drives read `this.providers.executor` at call time (not at
  // construction time) — so patching `.executor` on afterward, once the
  // full RoutingExecutor exists, is enough for a native run's own
  // delegate_to_<boundName> dispatch to reach a coding-kind sub-agent
  // through the same composed executor everything else uses. There's no
  // way to hand the native executor a reference to its own wrapping
  // RoutingExecutor before that wrapper is constructed.
  const nativeProviders: NativeRunProviders = { llm, engine, datastore, secrets, memory, reviewHosts };
  const nativeExecutor = buildExecutor(providerConfig, nativeProviders, prisma);
  const executor = buildConfiguredExecutor({ native: nativeExecutor, db: prisma, providerConfig });
  nativeProviders.executor = executor;

  return { providers: { llm, engine, datastore, secrets, executor, memory, reviewHosts } };
}

/** Handle returned by `startMcp()` — closes the running transport, then the executor. */
export interface McpServerHandle {
  close(): Promise<void>;
}

export interface StartMcpOptions {
  /**
   * A pre-built provider set. `wardby serve` builds one and shares it, because
   * DbosExecutor is a per-process singleton and two executors cannot coexist
   * (dbos.ts launch()). Built internally when omitted.
   */
  providers?: McpProviders;
  /**
   * Set by a composition root that also runs the scheduler, so startup does
   * not warn that enabled schedules will never fire.
   */
  schedulerAttached?: boolean;
}

/** Awaits `promise` (if any), logging and swallowing a rejection instead of propagating it. */
async function closeQuietly(promise: Promise<void> | undefined, what: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    mcpLog.warn({ err }, `${what} failed during MCP shutdown`);
  }
}

/** The real CLI entry point: `wardby mcp`. Reads config from the environment, starts stdio or HTTP per MCP_TRANSPORT. */
export async function startMcp(options: StartMcpOptions = {}): Promise<McpServerHandle> {
  const mcpConfig = loadMcpConfig();
  const providers = options.providers ?? buildMcpProviders().providers;
  await providers.executor.launch?.();
  if (!options.schedulerAttached) await warnIfNothingWillFireSchedules();

  if (mcpConfig.transport === "stdio") {
    const mcp = buildMcpServer({ providers, db: prisma, config: { canonicalUri: STDIO_PLACEHOLDER_URI } });
    const secretElicitationHost = createStdioSecretElicitationHost({
      verify: (token) => mcp.verifyRequestState(token),
      secrets: providers.secrets,
      db: prisma,
    });
    registerAllTools(mcp, {
      secretElicitationUrl: (token) => secretElicitationHost.urlFor(token),
      secretElicitationProtocol: mcpConfig.secretElicitationProtocol,
    });

    // stdio never carries per-call AuthInfo — one fixed, fully-trusted
    // local identity for the whole connection, per the design's own
    // "stdio local mode: no token; the operator is trusted."
    const principal = await resolvePrincipal(mcpConfig.localPrincipal, prisma);
    mcp.setFixedContext({
      principal,
      scopes: new Set(SCOPES_SUPPORTED),
      canonicalUri: STDIO_PLACEHOLDER_URI,
      providers,
      db: prisma,
      clientSupportsTasks: false,
      // Placeholder — server.ts's resolveCtx overwrites this with the
      // current call's real mcpReq on every dispatch.
      mcpReq: { requestState: () => undefined },
    });
    const stdio = runStdioServer(mcp);
    return {
      close: async () => {
        await closeQuietly(stdio.close(), "stdio transport close");
        await closeQuietly(providers.executor.close?.(), "executor close");
      },
    };
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
  const httpOrigin = canonicalUrl(mcpConfig.canonicalUri).origin;
  registerAllTools(mcp, {
    secretElicitationUrl: (token) =>
      Promise.resolve(`${httpOrigin}${SECRET_ELICITATION_PATH}?t=${encodeURIComponent(token)}`),
    secretElicitationProtocol: mcpConfig.secretElicitationProtocol,
  });

  const eventConfig = loadGitHubEventConfig();
  const githubConfig = loadGitHubVcsConfig();
  const reviewHosts = providers.reviewHosts;
  const hostEvents =
    eventConfig.webhookSecret && reviewHosts?.github && githubConfig.appId && githubConfig.privateKey
      ? {
          github: {
            db: prisma,
            executor: providers.executor,
            hosts: reviewHosts,
            webhookSecret: eventConfig.webhookSecret,
            appIdentity: (() => {
              const client = new GitHubAppClient({
                appId: githubConfig.appId,
                privateKey: githubConfig.privateKey,
                apiVersion: githubConfig.apiVersion,
              });
              return () => client.appIdentity();
            })(),
          },
        }
      : undefined;
  mcpLog.info({ enabled: Boolean(hostEvents) }, "GitHub host events ingress");

  const http = await startHttpServer({
    mcp,
    config: {
      canonicalUri: canonicalUrl(mcpConfig.canonicalUri).href,
      httpBind: mcpConfig.httpBind,
      authProviderKind,
      authorizationServer: authConfig.issuer,
      allowedOrigins: mcpConfig.allowedOrigins,
    },
    auth: { authProvider, db: prisma, providers },
    selfHosted,
    hostEvents,
  });
  const cleanupTimer = selfHosted
    ? setInterval(() => {
        selfHosted.cleanup().catch((err: unknown) => mcpLog.warn({ err }, "self-hosted auth cleanup failed"));
      }, SELF_HOSTED_CLEANUP_INTERVAL_MS)
    : undefined;
  return {
    close: async () => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      await closeQuietly(http.close(), "HTTP transport close");
      await closeQuietly(providers.executor.close?.(), "executor close");
    },
  };
}
