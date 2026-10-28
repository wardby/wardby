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
import { startupTestSimulators } from "../config/test-simulators.js";
import {
  loadProviderConfig,
  loadMcpConfig,
  loadShutdownDrainSeconds,
  loadAuthConfig,
  loadGitHubEventConfig,
  loadJiraConfig,
  loadGitHubVcsConfig,
  loadBlobStoreConfig,
} from "../config/providers.js";
import { prisma } from "../core/db.js";
import { guardDatastore, guardAgentMemory } from "../core/secret-guarded-stores.js";
import { createDbSecretWriteGuard } from "../core/secret-guard.js";
import { waitForInFlightRuns } from "../core/in-flight-runs.js";
import { NativeEngine } from "../core/engine-native.js";
import { resolveLlmRegistrations, RoutingLlmProvider } from "../providers/llm/index.js";
import { startModelCatalog } from "../providers/llm/catalog-store.js";
import { PostgresDatastore } from "../providers/datastore/index.js";
import { PostgresAgentMemory } from "../providers/memory/index.js";
import { buildConfiguredExecutor, buildExecutor } from "../providers/executor/index.js";
import { buildNativeSandboxExecutor } from "../native-worker/composition.js";
import { buildSecretCipher } from "../providers/secrets/index.js";
import { buildIssueTrackers } from "../providers/issue-tracker/index.js";
import { buildHostUserAuthorizers, buildReviewHosts } from "../providers/review-host/index.js";
import { buildChatProviders } from "../providers/chat/index.js";
import { createRepoAccessGate } from "../core/repo-access.js";
import { userCallbackPath } from "../core/host-identity-links.js";
import type { NativeRunProviders } from "../core/runner.js";
import { buildAuthProvider } from "../providers/auth/index.js";
import { GitHubAppClient } from "../providers/vcs/github.js";
import { loadGitHubAllowedAccounts } from "../config/github-allowed-accounts.js";
import type { SelfHostedAuthProvider } from "../providers/auth/self-hosted.js";
import { buildMcpServer, type WardbyMcpServer } from "./server.js";
import { buildPower } from "../core/power-composition.js";
import type { McpProviders, McpRequestContext } from "./context.js";
import type { Principal, PrismaClient } from "#prisma";
import { countUnattendedSchedules, unattendedSchedulesWarning } from "./unattended-schedules.js";
import { logZod3ToolWarnings } from "../core/zod3-window.js";
import { runStdioServer } from "./transport/stdio.js";
import { startHttpServer } from "./transport/streamable-http.js";
import { resolvePrincipal } from "./auth/principal.js";
import { ROLE_NAMES, SCOPES_SUPPORTED, authenticate } from "./auth/resource-server.js";
import { canonicalUrl } from "./transport/http-limits.js";
import { createViewerApi } from "../viewer/http.js";
import { createViewerEventBus } from "../viewer/event-bus.js";
import { buildInfraInfo } from "../viewer/infra.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerServiceTools } from "./tools/services.js";
import { registerBudgetGroupTools } from "./tools/budget-groups.js";
import { registerModelCatalogTools } from "./tools/model-catalog.js";
import { registerPowerTools } from "./tools/power.js";
import { registerHelpTools } from "./tools/help.js";
import { registerTriggerTool } from "./tools/trigger.js";
import { registerToolAuthoringTools } from "./tools/tools.js";
import { registerSchedulingTools } from "./tools/scheduling.js";
import { registerRunTools } from "./tools/runs.js";
import { registerStopRunTool } from "./tools/stop-run.js";
import { registerCostReportTools } from "./tools/cost-report.js";
import { registerDatastoreTools } from "./tools/datastore.js";
import { registerSubAgentTools } from "./tools/subagents.js";
import { registerGrantTools } from "./tools/grants.js";
import { registerRepositoryTools } from "./tools/repositories.js";
import { registerIssueProjectTools } from "./tools/issue-projects.js";
import { registerNotificationChannelTools } from "./tools/notification-channels.js";
import { registerHostAccountTools } from "./tools/host-accounts.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerPackageTools } from "./tools/packages.js";
import { registerSecretsTools, type SecretElicitationUrlBuilder } from "./tools/secrets.js";
import { registerWebhookTools } from "./tools/webhooks.js";
import { STDIO_SECRET_PATH, secretFormRoute } from "./tools/secret-elicitation-server.js";
import { createStdioLinkHost } from "./transport/stdio-link-host.js";
import { registerRunTranscriptTool } from "./tools/run-transcript.js";
import { handleRunTranscriptDownload, RUN_TRANSCRIPT_DOWNLOAD_PATH } from "./tools/run-transcript-download.js";
import { createBlobStore } from "../providers/storage/index.js";
import type { BlobStore } from "../providers/storage/types.js";
import { SECRET_ELICITATION_PATH } from "./tools/secret-elicitation-form.js";
import { installWorkflowEventRecorder } from "../core/notifications.js";
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

/**
 * stdio's one fixed identity: the local operator (LOCAL_PRINCIPAL), trusted
 * with every supported scope and every role — whoever can start the
 * process already holds the database and its keys.
 */
export function localOperatorContext(
  principal: Principal,
  providers: McpProviders,
  db: PrismaClient,
): McpRequestContext {
  return {
    principal,
    scopes: new Set(SCOPES_SUPPORTED),
    roles: [...ROLE_NAMES],
    // Full access to every resource (resource-sharing grants spec §3.9),
    // but never past the binding rules.
    operator: true,
    canonicalUri: STDIO_PLACEHOLDER_URI,
    providers,
    db,
    clientSupportsTasks: false,
    // Placeholder — server.ts's resolveCtx overwrites this with the
    // current call's real mcpReq on every dispatch.
    mcpReq: { requestState: () => undefined },
  };
}

/** Registers the full Phase 4 tool surface — every module, in one place. */
export function registerAllTools(
  mcp: WardbyMcpServer,
  opts: {
    secretElicitationUrl: SecretElicitationUrlBuilder;
    secretElicitationProtocol: boolean;
    /** Builds a get_run_transcript download URL for a minted token; absent = transcripts are not served. */
    runTranscriptUrl?: (token: string) => Promise<string>;
    /** Whether a blob store is configured to serve run transcripts from. */
    blobStoreConfigured?: boolean;
    /** Which host serves those links (default http). */
    runTranscriptAudience?: "stdio" | "http";
    /** Rebuilds the process's installed model CatalogStore after set_model/disable_model/reset_model. */
    refreshModelCatalog?: () => Promise<void>;
  },
): void {
  registerAgentTools(mcp);
  registerServiceTools(mcp);
  registerBudgetGroupTools(mcp);
  registerModelCatalogTools(mcp, { refresh: opts.refreshModelCatalog });
  registerPowerTools(mcp);
  registerHelpTools(mcp);
  registerTriggerTool(mcp);
  registerToolAuthoringTools(mcp);
  registerSchedulingTools(mcp);
  registerRunTools(mcp);
  const runTranscriptUrl = opts.runTranscriptUrl;
  registerRunTranscriptTool(mcp, {
    downloadUrl: runTranscriptUrl ?? (() => Promise.reject(new Error("run transcripts are not served here"))),
    blobStoreConfigured: runTranscriptUrl !== undefined && opts.blobStoreConfigured === true,
    audience: opts.runTranscriptAudience ?? "http",
  });
  registerStopRunTool(mcp);
  registerCostReportTools(mcp);
  registerDatastoreTools(mcp);
  registerSubAgentTools(mcp);
  registerGrantTools(mcp);
  registerRepositoryTools(mcp);
  registerIssueProjectTools(mcp);
  registerNotificationChannelTools(mcp);
  registerHostAccountTools(mcp);
  registerMemoryTools(mcp);
  registerPackageTools(mcp);
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
  const secretGuard = createDbSecretWriteGuard(prisma, secrets);
  const datastore = guardDatastore(new PostgresDatastore(prisma, secrets), secretGuard);
  const memory = guardAgentMemory(new PostgresAgentMemory(prisma), secretGuard);
  const reviewHosts = buildReviewHosts(process.env, prisma);
  const issueTrackers = buildIssueTrackers();
  const hostUserAuthorizers = buildHostUserAuthorizers();
  // Installed here (not just serve/scheduler) so `wardby mcp`, which handles
  // webhooks, records events too; only serve and the scheduler command start
  // the dispatcher.
  const chat = buildChatProviders();
  installWorkflowEventRecorder(prisma, chat);
  // One gate (and one cache) for the whole process: set-time checks in the
  // MCP tools, repo_* calls in native runs, coding runs, and host events.
  const repoAccess = createRepoAccessGate({ db: prisma, hosts: reviewHosts });
  // `nativeProviders` is passed by reference into buildExecutor, and native
  // runs it drives read `this.providers.executor` at call time (not at
  // construction time) — so patching `.executor` on afterward, once the
  // full RoutingExecutor exists, is enough for a native run's own
  // delegate_to_<boundName> dispatch to reach a coding-kind sub-agent
  // through the same composed executor everything else uses. There's no
  // way to hand the native executor a reference to its own wrapping
  // RoutingExecutor before that wrapper is constructed.
  const nativeProviders: NativeRunProviders = {
    llm,
    engine,
    datastore,
    secrets,
    memory,
    reviewHosts,
    issueTrackers,
    repoAccess,
  };
  const nativeExecutor = buildExecutor(providerConfig, nativeProviders, prisma);
  // One Power for the process, shared by both executors (wake) and the scheduler leader (sleep).
  const power = buildPower({ env: process.env, db: prisma });
  const executor = buildConfiguredExecutor({
    native: nativeExecutor,
    db: prisma,
    providerConfig,
    repoAccess,
    power,
    secretCipher: secrets,
    // Sandbox-mode native runs (docs/native-sandbox.md); undefined when NATIVE_SANDBOX_LAUNCHER is unset.
    nativeSandbox: buildNativeSandboxExecutor({ db: prisma, providers: nativeProviders, power }),
  });
  nativeProviders.executor = executor;

  return {
    providers: {
      llm,
      engine,
      datastore,
      secrets,
      executor,
      memory,
      reviewHosts,
      issueTrackers,
      hostUserAuthorizers,
      repoAccess,
      chat,
      power,
    },
  };
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

/**
 * Fire-and-forget: starts the executor's start-up warm-up (e.g. KubernetesJobLauncher's memoized
 * cluster preflight, via RoutingExecutor -> ContainerExecutor -> the job launcher's own `warmUp`)
 * right when a long-running server process starts, so its first coding run doesn't pay for it.
 * Never awaited by its caller and never throws: `warmUp()` on every implementation already swallows
 * its own failure (logging it instead), but this still guards the call site against a surprise
 * rejection, since nothing here may block or fail server start-up. Called from `startMcp` below —
 * i.e. from `wardby mcp` (stdio and HTTP) and from `wardby serve`, which shares this same start-up
 * path — and, separately, from `cli.ts`'s `scheduler()` (`wardby scheduler`), which dispatches
 * scheduled coding runs through its own Kubernetes executor but never starts an MCP server. Never
 * called from a one-shot CLI command (`wardby run`, `coding preflight`, migrations, imports).
 */
export function warmUpExecutor(executor: Pick<McpProviders["executor"], "warmUp">): void {
  void executor.warmUp?.()?.catch((err: unknown) => {
    mcpLog.warn({ err }, "executor warm-up failed unexpectedly");
  });
}

/** The real CLI entry point: `wardby mcp`. Reads config from the environment, starts stdio or HTTP per MCP_TRANSPORT. */
export async function startMcp(options: StartMcpOptions = {}): Promise<McpServerHandle> {
  const mcpConfig = loadMcpConfig();
  // WARDBY_TEST_SIMULATORS (test only): refuses to start beside production configuration.
  startupTestSimulators("server");
  // Parsed up front so a malformed value fails at startup, not at shutdown.
  const drainSeconds = loadShutdownDrainSeconds();
  // Parsed now so a malformed list stops startup instead of failing every event.
  const allowedAccounts = loadGitHubAllowedAccounts();
  mcpLog.info(
    { additionalAccounts: [...allowedAccounts] },
    "GitHub App serves its owner plus WARDBY_GITHUB_ALLOWED_ACCOUNTS",
  );
  // Loads the model catalog before anything else: running on the shipped
  // catalog alone (the fallback currentModelCatalog() uses before a store
  // is installed) would quietly re-enable models an admin turned off.
  // `modelCatalog` is handed to registerAllTools as `refreshModelCatalog`,
  // which the model catalog tools (set_model, disable_model, reset_model)
  // call via `modelCatalog.refreshNow()` after each write — there is no
  // separate refresh tool.
  const modelCatalog = await startModelCatalog(prisma);
  const providers = options.providers ?? buildMcpProviders().providers;
  await providers.executor.launch?.();
  warmUpExecutor(providers.executor);
  if (!options.schedulerAttached) await warnIfNothingWillFireSchedules();
  // Zod 3 compatibility window: one warning per custom tool the next release breaks. In the background.
  void logZod3ToolWarnings(prisma, mcpLog);

  // Run transcripts (get_run_transcript) are served from the blob store they were stored in.
  const blobStoreConfig = loadBlobStoreConfig();
  const blobs: BlobStore | undefined = blobStoreConfig ? createBlobStore(blobStoreConfig) : undefined;

  if (mcpConfig.transport === "stdio") {
    const mcp = buildMcpServer({ providers, db: prisma, config: { canonicalUri: STDIO_PLACEHOLDER_URI } });
    // One loopback server for every signed link a stdio tool hands out.
    const linkHost = createStdioLinkHost({
      [STDIO_SECRET_PATH]: secretFormRoute({
        verify: (token) => mcp.verifyRequestState(token),
        secrets: providers.secrets,
        db: prisma,
      }),
      [RUN_TRANSCRIPT_DOWNLOAD_PATH]: (req, res, token) =>
        handleRunTranscriptDownload(req.method, token, res, {
          verify: (t) => mcp.verifyRequestState(t),
          audience: "stdio",
          db: prisma,
          blobs,
        }),
    });
    registerAllTools(mcp, {
      secretElicitationUrl: (token) => linkHost.urlFor(STDIO_SECRET_PATH, token),
      runTranscriptUrl: (token) => linkHost.urlFor(RUN_TRANSCRIPT_DOWNLOAD_PATH, token),
      runTranscriptAudience: "stdio",
      blobStoreConfigured: blobs !== undefined,
      secretElicitationProtocol: mcpConfig.secretElicitationProtocol,
      refreshModelCatalog: () => modelCatalog.refreshNow(),
    });

    // stdio never carries per-call AuthInfo — one fixed, fully-trusted
    // local identity for the whole connection, per the design's own
    // "stdio local mode: no token; the operator is trusted."
    const principal = await resolvePrincipal(mcpConfig.localPrincipal, prisma);
    mcp.setFixedContext(localOperatorContext(principal, providers, prisma));
    const stdio = runStdioServer(mcp);
    return {
      close: async () => {
        await closeQuietly(stdio.close(), "stdio transport close");
        await closeQuietly(providers.executor.close?.(), "executor close");
        modelCatalog.close();
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

  const mcp = buildMcpServer({
    providers,
    db: prisma,
    config: { canonicalUri: mcpConfig.canonicalUri },
    deriveRequestStateKey: true,
  });
  const httpOrigin = canonicalUrl(mcpConfig.canonicalUri).origin;
  registerAllTools(mcp, {
    secretElicitationUrl: (token) =>
      Promise.resolve(`${httpOrigin}${SECRET_ELICITATION_PATH}?t=${encodeURIComponent(token)}`),
    runTranscriptUrl: (token) =>
      Promise.resolve(`${httpOrigin}${RUN_TRANSCRIPT_DOWNLOAD_PATH}?t=${encodeURIComponent(token)}`),
    blobStoreConfigured: blobs !== undefined,
    secretElicitationProtocol: mcpConfig.secretElicitationProtocol,
    refreshModelCatalog: () => modelCatalog.refreshNow(),
  });

  const eventConfig = loadGitHubEventConfig();
  const githubConfig = loadGitHubVcsConfig();
  const reviewHosts = providers.reviewHosts;
  const githubApp =
    githubConfig.appId && githubConfig.privateKey
      ? new GitHubAppClient({
          appId: githubConfig.appId,
          privateKey: githubConfig.privateKey,
          apiVersion: githubConfig.apiVersion,
        })
      : undefined;
  const githubEvents =
    eventConfig.webhookSecret && reviewHosts?.github && githubApp
      ? {
          github: {
            db: prisma,
            executor: providers.executor,
            hosts: reviewHosts,
            repoAccess: providers.repoAccess ?? createRepoAccessGate({ db: prisma, hosts: reviewHosts }),
            ...(providers.issueTrackers ? { issueTrackers: providers.issueTrackers } : {}),
            webhookSecret: eventConfig.webhookSecret,
            appIdentity: (opts?: { fresh?: boolean }) => githubApp.appIdentity(opts),
            allowedAccounts: () => allowedAccounts,
            mentionExplanations: eventConfig.mentionExplanations,
            uninstallInstallation: (id: number) => githubApp.deleteInstallation(id),
          },
        }
      : undefined;
  mcpLog.info({ enabled: Boolean(githubEvents) }, "GitHub host events ingress");
  const jiraConfig = loadJiraConfig();
  const jiraEvents =
    jiraConfig && providers.issueTrackers?.jira
      ? {
          db: prisma,
          executor: providers.executor,
          trackers: providers.issueTrackers,
          webhookSecret: jiraConfig.webhookSecret,
        }
      : undefined;
  mcpLog.info({ enabled: Boolean(jiraEvents) }, "Jira host events ingress");
  if (jiraEvents) {
    // Best effort: show which Jira account wardby acts as; never blocks startup.
    void providers.issueTrackers?.jira?.identity().then(
      ({ accountId, displayName, accountType }) =>
        accountType === "atlassian"
          ? mcpLog.error(
              { accountId, displayName, accountType },
              "Jira token belongs to a person's account; wardby refuses to act and the Jira ingress answers 503 until a service account token is configured",
            )
          : mcpLog.info({ accountId, displayName, accountType }, "Jira acting as"),
      (err: unknown) =>
        mcpLog.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "could not read the Jira account identity",
        ),
    );
  }
  if (jiraConfig?.tokenExpiresAt && jiraConfig.tokenExpiresAt.getTime() - Date.now() < 14 * 24 * 60 * 60 * 1000) {
    mcpLog.warn(
      { expiresAt: jiraConfig.tokenExpiresAt.toISOString() },
      "the Jira API token expires within 14 days; rotate WARDBY_JIRA_API_TOKEN",
    );
  }
  const hostEvents =
    githubEvents || jiraEvents
      ? { ...(githubEvents ? githubEvents : {}), ...(jiraEvents ? { jira: jiraEvents } : {}) }
      : undefined;
  const githubAuthorizer = providers.hostUserAuthorizers?.github;
  const hostUserAuth = githubAuthorizer
    ? {
        github: {
          db: prisma,
          authorizer: githubAuthorizer,
          redirectUri: `${httpOrigin}${userCallbackPath("github")}`,
        },
      }
    : undefined;
  mcpLog.info({ enabled: Boolean(hostUserAuth) }, "GitHub account linking");

  const canonicalHref = canonicalUrl(mcpConfig.canonicalUri).href;
  const viewerBus = process.env.DATABASE_URL
    ? createViewerEventBus({ connectionString: process.env.DATABASE_URL })
    : undefined;
  const viewer = viewerBus
    ? createViewerApi({
        db: prisma,
        bus: viewerBus,
        authenticate: (authorization) =>
          authenticate({ authorization }, { authProvider, db: prisma, providers, canonicalUri: canonicalHref }),
        canonicalUri: canonicalHref,
        infra: buildInfraInfo(),
        issueSites: jiraConfig ? { jira: jiraConfig.siteUrl } : {},
      })
    : undefined;
  const http = await startHttpServer({
    mcp,
    config: {
      canonicalUri: canonicalHref,
      httpBind: mcpConfig.httpBind,
      authProviderKind,
      authorizationServer: authConfig.issuer,
      allowedOrigins: mcpConfig.allowedOrigins,
    },
    auth: { authProvider, db: prisma, providers },
    selfHosted,
    hostEvents,
    hostUserAuth,
    viewer,
    blobs,
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
      await closeQuietly(viewerBus?.close(), "viewer event bus close");
      // Let the runs this instance is executing finish before the executor
      // closes under them; a run abandoned here is lost, never resumed.
      await waitForInFlightRuns(drainSeconds * 1000);
      await closeQuietly(providers.executor.close?.(), "executor close");
      modelCatalog.close();
    },
  };
}
