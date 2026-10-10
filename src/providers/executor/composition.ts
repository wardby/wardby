import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { PrismaClient } from "#prisma";
import {
  loadCodingConcurrencyConfig,
  loadContainerExecutorConfig,
  loadGitHubVcsConfig,
  loadKubernetesJobConfig,
  loadProviderConfig,
  type ProviderConfig,
} from "../../config/providers.js";
import { summarizeRegistryFetches } from "../../coding/registry/report.js";
import { drainCodingQueue } from "../../core/coding-queue.js";
import { prismaServiceStateReporter } from "../../core/coding-service-status.js";
import { logger } from "../../core/logger.js";
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
import type { WorkspaceJobLauncher } from "../jobs/types.js";
import { buildVcsProvider } from "../vcs/index.js";
import { ContainerExecutor, PrismaContainerExecutionStore, RunCapabilityVault } from "./container.js";
import { PrismaExecutionKindResolver, RoutingExecutor } from "./routing.js";
import type { Executor } from "./types.js";
import { createRepoAccessGate, type RepoAccessGate } from "../../core/repo-access.js";
import { buildIssueTrackers } from "../issue-tracker/index.js";
import { buildReviewHosts } from "../review-host/index.js";

const compositionLog = logger.child({ module: "executor-composition" });

/**
 * The coding-run terminal hook: a review-fix round's coding run that made no change re-reviews
 * the PR once (core/review-fix.ts). Started in the background so the executor's terminal path
 * (and the slot release after it) never waits on the host; idempotent, and never throws.
 * `deps` is read only when a run finishes, after composition returned.
 */
export function reReviewOnCodingRunTerminal(deps: () => ReReviewDeps): (runId: string) => void {
  return (runId) => {
    void Promise.resolve()
      .then(() => reReviewAfterNoChangeFix(runId, deps()))
      .catch((err: unknown) => compositionLog.warn({ err, runId }, "no-change re-review hook failed"));
  };
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
  /** Repository authorization for coding runs; built from the configured review hosts when absent. */
  repoAccess?: RepoAccessGate;
}

/**
 * Builds container execution only when Docker or Kubernetes is explicitly
 * selected, and native sandbox routing whenever a sandbox executor is given.
 */
export function buildConfiguredExecutor(options: ConfiguredExecutorOptions): Executor {
  const env = options.env ?? process.env;
  const providerConfig = options.providerConfig ?? loadProviderConfig(env);
  if (providerConfig.jobs !== "docker" && providerConfig.jobs !== "kubernetes") {
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
    if (config.workerImage !== undefined && !isRegistryDigest(config.workerImage)) {
      throw new Error("CODING_WORKER_IMAGE must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=kubernetes.");
    }
    for (const image of [config.claudeWorkerImage, config.claudeToolRunnerImage]) {
      if (image !== undefined && !isRegistryDigest(image)) {
        throw new Error(
          "CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE must be registry digests (repo@sha256:...) when JOB_LAUNCHER=kubernetes.",
        );
      }
    }
    const claudePython = config.claudeToolRunnerImages["node-python"]?.["3.12"];
    if (claudePython !== undefined && !isRegistryDigest(claudePython)) {
      throw new Error(
        "CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12 must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=kubernetes.",
      );
    }
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
      readyTimeoutMs: kubernetes.readyTimeoutMs,
      enforcementExecTimeoutMs: kubernetes.enforcementExecTimeoutMs,
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
  } else {
    const stateRoot = resolve(config.stateRoot ?? resolve(tmpdir(), "wardby-docker-jobs"));
    jobs = new DockerJobLauncher({
      onServiceState,
      stateRoot,
      workspaceRoot,
      proxyContainer: proxyContainer as string,
      resolveCapability: (runId) => capabilities.get(runId),
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
  const coding = new ContainerExecutor({
    store: new PrismaContainerExecutionStore(options.db, { maxConcurrent: concurrency.maxConcurrent, issueTrackers }),
    jobs,
    vcs,
    sessions,
    capabilities,
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
    repoAccess,
    issueUrl: (provider, key) => (provider === "jira" ? issueTrackers.jira?.issueUrl(key) : undefined),
    registryReport: async (runId) => {
      const rows = await options.db.registryFetch.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
      return summarizeRegistryFetches(rows);
    },
    onCodingRunTerminal: reReviewOnCodingRunTerminal((): ReReviewDeps => ({
      db: options.db,
      executor: composed,
      hosts: reviewHosts,
      repoAccess,
      issueTrackers,
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
