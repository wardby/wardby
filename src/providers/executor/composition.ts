import { tmpdir } from "node:os";
import type { RunStepSink } from "../../core/run-steps/types.js";
import { resolve } from "node:path";
import type { PrismaClient } from "#prisma";
import {
  loadBlobStoreConfig,
  loadCodingConcurrencyConfig,
  loadCodingResultBundleMaxBytes,
  loadContainerExecutorConfig,
  loadGitHubVcsConfig,
  loadKubernetesJobConfig,
  loadSubstrateJobConfig,
  loadProviderConfig,
  type ContainerExecutorConfig,
  type ProviderConfig,
} from "../../config/providers.js";
import { summarizePackageAudit } from "../../coding/registry/audit-mode.js";
import { summarizeRegistryFetches } from "../../coding/registry/report.js";
import { linkedIssueReader } from "./linked-issue-reader.js";
import { drainCodingQueue } from "../../core/coding-queue.js";
import { prismaServiceStateReporter } from "../../core/coding-service-status.js";
import { logger } from "../../core/logger.js";
import { outsideRunContext } from "../../core/async-context.js";
import { DISABLED_POWER, type Power } from "../../core/power.js";
import { onDocumentRunFinished } from "../../core/documents/agent-loop.js";
import { planRunFinishedHook } from "../../core/plans/hooks.js";
import {
  createPlanChainHook,
  createPlanReviewHook,
  issueNoticePoster,
  planTicketStartBlock,
  type TicketStartBlock,
  setPlanChainHook,
  setPlanReviewHook,
  type PlanApprovalDeps,
} from "../../core/plans/approval.js";
import { refusalOf } from "../../core/plans/refusal.js";
import { dispatchRun } from "../../core/dispatch.js";
import { RepositorySetRefusedError } from "../../core/coding-repository-set.js";
import { RESPONSE_PATH_SNAPSHOT_BUDGET, resolveWorkItem } from "../../core/attribution.js";
import { documentSecretValues } from "../../core/documents/redact.js";
import { planSummaryForRun } from "../../core/plans/publish.js";
import { planSummaryLines } from "../../core/plans/wording.js";
import { httpOrigin } from "../../mcp/tools/documents.js";
import type { SelfDefectSink } from "../../core/self-defects.js";
import { startDeferredForRequest } from "../../core/host-events.js";
import { syncMergeOrderChecks } from "../../core/merge-order-check.js";
import { changeHasExtraPullRequest, updateRelatedPullRequests } from "../../core/related-pull-requests.js";
import { reReviewAfterNoChangeFix, type ReReviewDeps } from "../../core/review-fix.js";
import { EnvironmentCredentialResolver } from "../coding-proxy/environment-credentials.js";
import { CodingProxy } from "../coding-proxy/proxy.js";
import { PrismaProxyLedger } from "../coding-proxy/prisma-ledger.js";
import { DockerJobLauncher } from "../jobs/docker.js";
import type { KubernetesApi } from "../jobs/kubernetes-api.js";
import { ClientNodeKubernetesApi } from "../jobs/kubernetes-client.js";
import { isRegistryDigest } from "../jobs/kubernetes-isolation.js";
import { assertPlatformConfig, platformProfile } from "../jobs/kubernetes-platform.js";
import { preflightCanaryImage, runKubernetesPreflight } from "../jobs/kubernetes-preflight.js";
import { CODING_WORKER_IMAGES_REQUIRED } from "../../coding/docker-preflight.js";
import { KubernetesJobLauncher } from "../jobs/kubernetes.js";
import { createSubstrateApi } from "../jobs/substrate/client.js";
import type { SubstrateApi } from "../jobs/substrate/api.js";
import { SubstrateJobLauncher } from "../jobs/substrate/launcher.js";
import { PrismaSubstrateRunStore } from "../jobs/substrate/run-store.js";
import { PrismaSubstrateTemplateStore } from "../jobs/substrate/template-store.js";
import { PrismaRelayStore } from "../coding-proxy/substrate/prisma-relay-store.js";
import type { WorkspaceJobLauncher } from "../jobs/types.js";
import { buildVcsProvider } from "../vcs/index.js";
import {
  RunTranscriptRecorder,
  loadTranscriptMaxBytes,
  loadTranscriptRetentionDays,
} from "../../coding/transcript/recorder.js";
import { PlanFilesRecorder } from "../../coding/plan-files/recorder.js";
import { loadAgentSecretValues } from "../../core/secret-guard.js";
import { agentSecretVersions } from "../../core/secret-versions.js";
import { createBlobStore } from "../storage/index.js";
import { ContainerExecutor, PrismaContainerExecutionStore, RunCapabilityVault } from "./container.js";
import { loadMcpToolPins } from "../../core/mcp-tools.js";
import { PrismaExecutionKindResolver, RoutingExecutor } from "./routing.js";
import type { Executor } from "./types.js";
import { createRepoAccessGate, type RepoAccessGate } from "../../core/repo-access.js";
import { buildIssueTrackers } from "../issue-tracker/index.js";
import { buildReviewHosts } from "../review-host/index.js";

const compositionLog = logger.child({ module: "executor-composition" });

/**
 * The coding-run terminal hook: a review-fix round's coding run that made no change re-reviews
 * the PR once (core/review-fix.ts), and the reviews of its pull request that waited for it (a
 * draft's head it may have pushed before recording its result, core/host-events.ts) are
 * released. Started in the background so the executor's terminal path (and the slot release
 * after it) never waits on the host; idempotent (released rows are claimed), and never throws.
 * Started outside the caller's async context: a delegated coding run finishes inside its lead's
 * delegation step, and a review started from there would be refused by DBOS as a workflow
 * started from inside a step. `deps` is read only when a run finishes, after composition returned.
 */
export function reReviewOnCodingRunTerminal(deps: () => ReReviewDeps): (runId: string) => void {
  return (runId) =>
    outsideRunContext(() => {
      void Promise.resolve()
        .then(() => reReviewAfterNoChangeFix(runId, deps()))
        .catch((err: unknown) => compositionLog.warn({ err, runId }, "no-change re-review hook failed"));
      // Never throws (logs its own failures).
      void Promise.resolve()
        .then(() => startDeferredForRequest(deps(), runId))
        .catch((err: unknown) =>
          compositionLog.warn({ err, runId }, "could not release the reviews waiting for this run"),
        );
      // A top-level coding run of a change with pull requests in several repositories (#537), its
      // root or a follow-up that continued it, is its own request set: no lead ends after it to list
      // them in each other's Related sections or to post their merge order checks. Both never throw.
      void Promise.resolve()
        .then(async () => {
          const { db, hosts, issueTrackers } = deps();
          if (!(await ownsPullRequestSet(db, runId))) return;
          await updateRelatedPullRequests(db, { id: runId }, hosts, issueTrackers);
          await syncMergeOrderChecks({ db, hosts }, runId);
        })
        .catch((err: unknown) =>
          compositionLog.warn({ err, runId }, "could not update the related pull requests of this run"),
        );
    });
}

/**
 * The document send-to-agent completion, outside the finishing run's async context. Never throws.
 * Answering a run can start a reconcile run, so the self-defect sink is required: its start
 * failure is filed as a send's is.
 */
export function documentRunFinishedHook(
  deps: () => {
    db: PrismaClient;
    executor: Executor;
    cipher: Parameters<typeof loadAgentSecretValues>[1];
    selfDefects: SelfDefectSink;
  },
): (runId: string) => void {
  return (runId) =>
    outsideRunContext(() => {
      void Promise.resolve()
        .then(() => {
          const { db, ...rest } = deps();
          return onDocumentRunFinished(db, rest, runId);
        })
        .catch((err: unknown) =>
          compositionLog.warn(
            { runId, errorName: err instanceof Error ? err.name : typeof err },
            "document hook failed",
          ),
        );
    });
}

/** A top-level coding run whose change (its root and the root's continuations) opened pull requests in extra repositories (#537). */
async function ownsPullRequestSet(db: ReReviewDeps["db"], runId: string): Promise<boolean> {
  const run = await db.run.findUnique({ where: { id: runId }, select: { parentRunId: true } });
  if (!run || run.parentRunId !== null) return false;
  return changeHasExtraPullRequest(db, runId);
}

export interface ConfiguredExecutorOptions {
  native: Executor;
  /**
   * Runs native agents whose run snapshot says `sandbox`. Composed whether or
   * not a coding job launcher is configured. Absent: sandbox runs go to
   * `native`, whose runner refuses them (RoutingExecutor).
   */
  nativeSandbox?: Executor;
  db: PrismaClient;
  env?: NodeJS.ProcessEnv;
  providerConfig?: ProviderConfig;
  /** Tests only: replaces the kubeconfig-backed client when JOB_LAUNCHER=kubernetes. */
  kubernetesApi?: KubernetesApi;
  /** Tests only: replaces the gRPC client when JOB_LAUNCHER=substrate. */
  substrateApi?: SubstrateApi;
  /** Repository authorization for coding runs; built from the configured review hosts when absent. */
  repoAccess?: RepoAccessGate;
  /**
   * Low-power mode, built once by the composition root and shared. Used only by the Kubernetes
   * launcher (wakes the coding proxy before a run); absent: `DISABLED_POWER`.
   */
  power?: Power;
  /** Decrypts agent secrets for transcript redaction (session resume). Absent: transcripts are never stored. */
  secretCipher?: Parameters<typeof loadAgentSecretValues>[1];
  /** The process's run-steps writer (a continuation's warm-start step line). Absent: no such line. */
  runSteps?: RunStepSink;
}

/**
 * Substrate only: every Codex worker image of a toolchain (CODING_WORKER_IMAGE_<TOOLCHAIN>_<VERSION>)
 * is pulled by the Substrate Codex bridge too, so each must be a digest (the Kubernetes launcher
 * checks only the images it pulls itself).
 */
export function assertSubstrateDigestImages(config: Pick<ContainerExecutorConfig, "additionalWorkerImages">): void {
  for (const [toolchain, versions] of Object.entries(config.additionalWorkerImages)) {
    for (const [version, image] of Object.entries(versions)) {
      if (isRegistryDigest(image)) continue;
      const variable = `CODING_WORKER_IMAGE_${toolchain}_${version}`.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      throw new Error(`${variable} must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=substrate.`);
    }
  }
}

/** The worker images a registry-pulling launcher (Kubernetes, Substrate) will run must be digests. */
function assertDigestImages(
  config: Pick<
    ReturnType<typeof loadContainerExecutorConfig>,
    "workerImage" | "claudeWorkerImage" | "claudeToolRunnerImage" | "claudeToolRunnerImages"
  >,
  launcher: "kubernetes" | "substrate",
): void {
  if (config.workerImage !== undefined && !isRegistryDigest(config.workerImage)) {
    throw new Error(`CODING_WORKER_IMAGE must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=${launcher}.`);
  }
  for (const image of [config.claudeWorkerImage, config.claudeToolRunnerImage]) {
    if (image !== undefined && !isRegistryDigest(image)) {
      throw new Error(
        `CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE must be registry digests (repo@sha256:...) when JOB_LAUNCHER=${launcher}.`,
      );
    }
  }
  const claudePython = config.claudeToolRunnerImages["node-python"]?.["3.12"];
  if (claudePython !== undefined && !isRegistryDigest(claudePython)) {
    throw new Error(
      `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12 must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=${launcher}.`,
    );
  }
}

/**
 * The experimental Substrate launcher: the gRPC client, the per-run Secret in the credentials
 * namespace, the run table, and the blob store shared with the coding proxy (BLOB_STORE).
 */
export function buildSubstrateJobLauncher(options: {
  env: NodeJS.ProcessEnv;
  db: PrismaClient;
  workspaceRoot: string;
  resolveCapability: (runId: string) => Promise<string>;
  /** The run's MCP token (capabilities.mcpToken), asked only for a spec with mcpTools. */
  resolveMcpToken?: (runId: string) => Promise<string | undefined>;
  substrateApi?: SubstrateApi;
  kubernetesApi?: KubernetesApi;
}): SubstrateJobLauncher {
  const substrate = loadSubstrateJobConfig(options.env);
  const blobStoreConfig = loadBlobStoreConfig(options.env);
  if (!blobStoreConfig) throw new Error("BLOB_STORE is required when JOB_LAUNCHER=substrate.");
  return new SubstrateJobLauncher({
    api:
      options.substrateApi ??
      createSubstrateApi({
        baseUrl: substrate.apiUrl,
        tokenFile: substrate.tokenFile,
        ...(substrate.caFile ? { caFile: substrate.caFile } : {}),
        ...(substrate.serverName ? { serverName: substrate.serverName } : {}),
      }),
    runs: new PrismaSubstrateRunStore(options.db),
    templates: new PrismaSubstrateTemplateStore(options.db),
    relay: new PrismaRelayStore(options.db),
    blobs: createBlobStore(blobStoreConfig),
    secrets: options.kubernetesApi ?? new ClientNodeKubernetesApi({ context: substrate.kubeContext }),
    config: {
      atespace: substrate.atespace,
      credentialsNamespace: substrate.credentialsNamespace,
      proxyHost: substrate.proxyHost,
      proxyPort: substrate.proxyPort,
      ...(substrate.workerSelector ? { workerSelector: substrate.workerSelector } : {}),
    },
    workspaceRoot: options.workspaceRoot,
    resolveCapability: options.resolveCapability,
    ...(options.resolveMcpToken ? { resolveMcpToken: options.resolveMcpToken } : {}),
    ...(substrate.collectGraceSec !== undefined ? { collectGraceMs: substrate.collectGraceSec * 1000 } : {}),
    ...(substrate.startupTimeoutSec !== undefined ? { startupTimeoutMs: substrate.startupTimeoutSec * 1000 } : {}),
    ...(substrate.templateTtlSec !== undefined ? { templateTtlMs: substrate.templateTtlSec * 1000 } : {}),
    ...(substrate.templateReadySec !== undefined ? { templateReadyMs: substrate.templateReadySec * 1000 } : {}),
    ...(substrate.templateRetrySec !== undefined ? { templateRetryMs: substrate.templateRetrySec * 1000 } : {}),
    ...(substrate.warmRounds
      ? { warmRounds: { parkTtlMs: substrate.warmRounds.parkTtlSec * 1000, parkMax: substrate.warmRounds.parkMax } }
      : {}),
  });
}

/**
 * Starts a plan ticket's builder run (spec §7b). Under the set's row lock (R16), only an approved set
 * with no ticket run in flight; a refusal reports what that guard saw, not a later re-read. A run the
 * chain follows (followedByChain) is recorded as the chain's run in the transaction that creates it,
 * so a run that ends at once still finds itself the chain's run (plans/approval.ts onTicketFinished).
 */
export function planTicketStarter(deps: {
  db: PrismaClient;
  executor: () => Executor;
  issueTrackers: Parameters<typeof resolveWorkItem>[1];
  cipher?: ConfiguredExecutorOptions["secretCipher"];
  dispatch?: typeof dispatchRun;
}): PlanApprovalDeps["startTicket"] {
  const dispatch = deps.dispatch ?? dispatchRun;
  return async ({ builderAgentId, set, ticket, starterId, trigger, followedByChain }) => {
    const guard: { blocked: TicketStartBlock | null } = { blocked: null };
    try {
      const attribution =
        set.issueProvider && set.issueKey
          ? {
              source: "explicit" as const,
              item: await resolveWorkItem(
                deps.db,
                deps.issueTrackers,
                set.issueProvider,
                set.issueKey,
                RESPONSE_PATH_SNAPSHOT_BUDGET,
              ),
            }
          : undefined;
      const dispatched = await dispatch({
        db: deps.db,
        executor: deps.executor(),
        selfDefects: { db: deps.db, issueTrackers: deps.issueTrackers },
        agentId: builderAgentId,
        trigger,
        ...(starterId ? { triggeredById: starterId } : {}),
        codingRepository: set.repository,
        codingTask: `Build ticket ${ticket} of plan ${set.number}.`,
        planNumber: set.number,
        planTicket: ticket,
        // Only this set: the gate's newest visible set for the repository and number may be another's.
        expectedPlanSetId: set.id,
        ...(deps.cipher ? { secretCipher: deps.cipher } : {}),
        ...(attribution ? { attribution } : {}),
        // A reopen or a concurrent start (the chain's, or a build ticket comment's) waits for the lock.
        beforePersist: async (tx) => {
          guard.blocked = await planTicketStartBlock(tx, set.id);
          return guard.blocked === null;
        },
        afterPersist: async (tx, run) => {
          if (!followedByChain || (run.status !== "pending" && run.status !== "running")) return;
          await tx.$queryRaw`
            UPDATE "PlanSet" SET "chainRunId" = ${run.id}
            WHERE "id" = ${set.id} AND "chainTicket" = ${ticket} AND "chainStopped" IS NULL
            RETURNING "id"`;
        },
      });
      if (!dispatched) return guard.blocked ?? { refused: "plan_not_approved" };
      if (dispatched.run.status === "refused" || dispatched.run.status === "failed") {
        return { refused: (dispatched.run.error ?? "refused").split(":")[0] };
      }
      return { runId: dispatched.run.id };
    } catch (err) {
      const refusal = refusalOf(err) ?? (err instanceof RepositorySetRefusedError ? { error: err.code } : undefined);
      if (refusal) return { refused: refusal.error };
      throw err;
    }
  };
}

/**
 * Builds container execution only when Docker, Kubernetes or Substrate is explicitly
 * selected, and native sandbox routing whenever a sandbox executor is given.
 */
export function buildConfiguredExecutor(options: ConfiguredExecutorOptions): Executor {
  const env = options.env ?? process.env;
  const providerConfig = options.providerConfig ?? loadProviderConfig(env);
  if (providerConfig.jobs !== "docker" && providerConfig.jobs !== "kubernetes" && providerConfig.jobs !== "substrate") {
    if (!options.nativeSandbox) return options.native;
    // No coding launcher: coding runs reach the native executor, whose runner fails them with
    // the "needs a container executor" explanation, exactly as without this wrapper.
    return new RoutingExecutor(
      new PrismaExecutionKindResolver(options.db),
      options.native,
      options.native,
      options.nativeSandbox,
    );
  }

  const github = loadGitHubVcsConfig(env);
  const config = loadContainerExecutorConfig(env);
  // Each provider's images are optional, but a coding launcher with neither can run nothing.
  const claudeConfigured = Boolean(config.claudeWorkerImage && config.claudeToolRunnerImage);
  if (!config.workerImage && !claudeConfigured) {
    throw new Error(`${CODING_WORKER_IMAGES_REQUIRED} when JOB_LAUNCHER=${providerConfig.jobs}.`);
  }
  if (config.claudeCommandMaxRaised) {
    compositionLog.info("CODING_BASH_MAX_TIMEOUT_MS unset: raised to CODING_BASH_DEFAULT_TIMEOUT_MS");
  }
  const proxyContainer = config.proxyContainer;
  if (providerConfig.jobs === "docker" && !proxyContainer) {
    throw new Error("CODING_PROXY_CONTAINER is required when JOB_LAUNCHER=docker.");
  }
  const workspaceRoot = resolve(github.workRoot ?? resolve(tmpdir(), "wardby-vcs"));
  const artifactRoot = resolve(config.artifactRoot ?? resolve(tmpdir(), "wardby-coding-artifacts"));
  const vcs = buildVcsProvider(providerConfig, { ...github, workRoot: workspaceRoot }, env);
  const capabilities = new RunCapabilityVault();
  const sessions = new CodingProxy({
    ledger: new PrismaProxyLedger(options.db),
    credentials: new EnvironmentCredentialResolver(env),
  });
  const onServiceState = prismaServiceStateReporter(options.db);
  let jobs: WorkspaceJobLauncher;
  if (providerConfig.jobs === "kubernetes") {
    assertDigestImages(config, "kubernetes");
    const kubernetes = loadKubernetesJobConfig(env);
    // The preflight only runs on the first launch; a configuration that cannot work should
    // fail the process at start-up, not the first coding run an hour later.
    assertPlatformConfig(platformProfile(kubernetes.platform), {
      runtimeClassName: kubernetes.runtimeClassName,
      maxDiskMb: config.maxDiskMb,
    });
    const api = options.kubernetesApi ?? new ClientNodeKubernetesApi({ context: kubernetes.context });
    // The canary needs some worker image to run node in; the Claude worker stands in on a Claude-only server.
    const workerImage = preflightCanaryImage(config) as string;
    jobs = new KubernetesJobLauncher({
      onServiceState,
      api,
      config: kubernetes,
      workspaceRoot,
      resolveCapability: (runId) => capabilities.get(runId),
      resolveMcpToken: (runId) => capabilities.mcpToken(runId),
      readyTimeoutMs: kubernetes.readyTimeoutMs,
      enforcementExecTimeoutMs: kubernetes.enforcementExecTimeoutMs,
      power: options.power ?? DISABLED_POWER,
      preflight: async () => {
        const { proxyIp } = await runKubernetesPreflight({
          api,
          config: kubernetes,
          workerImage,
          maxDiskMb: config.maxDiskMb,
          timeoutMs: kubernetes.preflightTimeoutMs,
        });
        return { proxyIp };
      },
      onWarning: (message) => compositionLog.warn(message),
    });
  } else if (providerConfig.jobs === "substrate") {
    assertDigestImages(config, "substrate");
    assertSubstrateDigestImages(config);
    jobs = buildSubstrateJobLauncher({
      env,
      db: options.db,
      workspaceRoot,
      resolveCapability: (runId) => capabilities.get(runId),
      resolveMcpToken: (runId) => capabilities.mcpToken(runId),
      substrateApi: options.substrateApi,
      kubernetesApi: options.kubernetesApi,
    });
  } else {
    const stateRoot = resolve(config.stateRoot ?? resolve(tmpdir(), "wardby-docker-jobs"));
    jobs = new DockerJobLauncher({
      onServiceState,
      stateRoot,
      workspaceRoot,
      proxyContainer: proxyContainer as string,
      resolveCapability: (runId) => capabilities.get(runId),
      resolveMcpToken: (runId) => capabilities.mcpToken(runId),
      isRunActive: async (runId, handle) => {
        const coding = await options.db.codingRun.findUnique({
          where: { runId },
          include: { run: { select: { status: true } } },
        });
        return (
          coding?.run.status === "running" && coding.jobBackend === handle.backend && coding.jobHandle === handle.id
        );
      },
    });
  }
  const issueTrackers = buildIssueTrackers(env);
  const concurrency = loadCodingConcurrencyConfig(env);
  const reviewHosts = buildReviewHosts(env, options.db);
  const repoAccess = options.repoAccess ?? createRepoAccessGate({ db: options.db, hosts: reviewHosts });
  // The release and terminal hooks need the composed RoutingExecutor, which only exists
  // after the ContainerExecutor it wraps is built. The closure reads
  // `composed` only when a run finishes, which is after this function returns.
  const blobStoreConfig = loadBlobStoreConfig(env);
  const cipher = options.secretCipher;
  const origin = httpOrigin(env.MCP_CANONICAL_URI);
  // Spec §7b: a plan set's approval notifies on its issue or starts its builder for ticket 1. startTicket
  // reads `composed` only when it is called, after this function returns, as the terminal hooks do.
  const planDeps: PlanApprovalDeps = {
    postIssueNotice: issueNoticePoster({ db: options.db, reviewHosts, issueTrackers }),
    mentionHandle: async () => (reviewHosts.github?.appSlug ? await reviewHosts.github.appSlug() : null),
    secretValues: async (agentId) => {
      if (!cipher) throw new Error("plan_secrets_unavailable");
      return documentSecretValues(options.db, cipher, agentId);
    },
    startTicket: planTicketStarter({
      db: options.db,
      executor: () => composed,
      issueTrackers,
      ...(cipher ? { cipher } : {}),
    }),
  };
  // Without the cipher no notice can be redacted, so no plan approval hook runs (as for the run hooks).
  setPlanReviewHook(cipher ? createPlanReviewHook(planDeps) : undefined);
  // The build chain (C3): a merged ticket PR starts the next ticket; a failed ticket run stops it.
  setPlanChainHook(cipher ? createPlanChainHook(planDeps) : undefined);
  const transcripts = new RunTranscriptRecorder({
    db: options.db,
    blobs: blobStoreConfig && cipher ? createBlobStore(blobStoreConfig) : undefined,
    secretValues: async (agentId) => {
      if (!cipher) throw new Error("transcript_secrets_unavailable");
      const named = await loadAgentSecretValues(options.db, cipher, agentId);
      return named.flatMap((entry) => entry.values);
    },
    secretVersions: (agentId) => agentSecretVersions(options.db, agentId),
    retentionDays: loadTranscriptRetentionDays(env),
    maxBytes: loadTranscriptMaxBytes(env),
  });
  const planFiles = new PlanFilesRecorder({
    db: options.db,
    secretValues: async (agentId) => {
      if (!cipher) throw new Error("plan_files_secrets_unavailable");
      const named = await loadAgentSecretValues(options.db, cipher, agentId);
      return named.flatMap((entry) => entry.values);
    },
    secretVersions: (agentId) => agentSecretVersions(options.db, agentId),
  });
  const coding = new ContainerExecutor({
    transcripts,
    planFiles,
    planSummary: async (runId) => {
      const s = await planSummaryForRun(options.db, runId, origin);
      return s ? planSummaryLines(s) : [];
    },
    ...(options.runSteps ? { runSteps: options.runSteps } : {}),
    store: new PrismaContainerExecutionStore(options.db, {
      maxConcurrent: concurrency.maxConcurrent,
      issueTrackers,
      warmRounds: jobs.warmRounds === true,
      // Threads sent from a document: publish the run's edit and post its replies; a planner run's
      // plan files become its plan set, and a planner with no lead replies on its issue (neither throws). Without the
      // cipher the agent's secrets cannot be redacted, so nothing is posted or published.
      ...(cipher
        ? {
            onTerminal: (() => {
              const documentHook = documentRunFinishedHook(() => ({
                db: options.db,
                executor: composed,
                cipher,
                selfDefects: { db: options.db, issueTrackers },
              }));
              const planHook = planRunFinishedHook(() => ({
                db: options.db,
                cipher,
                origin,
                postIssueNotice: planDeps.postIssueNotice,
              }));
              return (runId: string) => {
                documentHook(runId);
                void planHook(runId);
              };
            })(),
          }
        : {}),
    }),
    jobs,
    vcs,
    sessions,
    capabilities,
    // Remote MCP servers: a coding run gets its agent's pinned tools and an MCP token ([] when off).
    mcpToolPins: (agentId, pinOptions) => loadMcpToolPins(options.db, agentId, pinOptions),
    artifactRoot,
    workerImage: config.workerImage,
    claudeWorkerImage: config.claudeWorkerImage,
    claudeToolRunnerImage: config.claudeToolRunnerImage,
    claudeToolRunnerImages: config.claudeToolRunnerImages,
    additionalWorkerImages: config.additionalWorkerImages,
    credentialRef: config.credentialRef,
    anthropicCredentialRef: config.anthropicCredentialRef,
    limits: { cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids, diskMb: config.diskMb },
    maxDiskMb: config.maxDiskMb,
    resultBundleMaxBytes: loadCodingResultBundleMaxBytes(env),
    claudeCommandTimeouts: config.claudeCommandTimeouts,
    repoAccess,
    readLinkedIssue: linkedIssueReader({ hosts: reviewHosts, issueTrackers }),
    issueUrl: (provider, key) => (provider === "jira" ? issueTrackers.jira?.issueUrl(key) : undefined),
    registryReport: async (runId) => {
      const rows = await options.db.registryFetch.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
      const coding = await options.db.codingRun.findUnique({ where: { runId }, select: { packageAuditMode: true } });
      const packageAuditMode = coding?.packageAuditMode ?? null;
      if (!packageAuditMode) return summarizeRegistryFetches(rows);
      const audits = await options.db.registryAuditRecord.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
      return {
        ...summarizeRegistryFetches(rows),
        packageAuditMode,
        packageAudit: summarizePackageAudit(audits).entries,
      };
    },
    onCodingRunTerminal: reReviewOnCodingRunTerminal((): ReReviewDeps => ({
      db: options.db,
      executor: composed,
      hosts: reviewHosts,
      repoAccess,
      issueTrackers,
      secretCipher: cipher,
    })),
    onSlotReleased: () => {
      void drainCodingQueue({
        db: options.db,
        executor: composed,
        maxConcurrent: concurrency.maxConcurrent,
        queueTimeoutSec: concurrency.queueTimeoutSec,
        selfDefects: { db: options.db, issueTrackers },
      }).catch((err: unknown) => {
        // Never throws: the next scheduler tick drains again.
        compositionLog.warn({ err }, "coding queue drain after a released slot failed");
      });
    },
  });
  const composed: Executor = new RoutingExecutor(
    new PrismaExecutionKindResolver(options.db),
    options.native,
    coding,
    options.nativeSandbox,
  );
  return composed;
}
