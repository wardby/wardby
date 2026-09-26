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
import { drainCodingQueue } from "../../core/coding-queue.js";
import { logger } from "../../core/logger.js";
import { EnvironmentCredentialResolver } from "../coding-proxy/environment-credentials.js";
import { CodingProxy } from "../coding-proxy/proxy.js";
import { PrismaProxyLedger } from "../coding-proxy/prisma-ledger.js";
import { DockerJobLauncher } from "../jobs/docker.js";
import type { KubernetesApi } from "../jobs/kubernetes-api.js";
import { ClientNodeKubernetesApi } from "../jobs/kubernetes-client.js";
import { isRegistryDigest } from "../jobs/kubernetes-isolation.js";
import { assertPlatformConfig, platformProfile } from "../jobs/kubernetes-platform.js";
import { runKubernetesPreflight } from "../jobs/kubernetes-preflight.js";
import { KubernetesJobLauncher } from "../jobs/kubernetes.js";
import type { WorkspaceJobLauncher } from "../jobs/types.js";
import { buildVcsProvider } from "../vcs/index.js";
import { ContainerExecutor, PrismaContainerExecutionStore, RunCapabilityVault } from "./container.js";
import { PrismaExecutionKindResolver, RoutingExecutor } from "./routing.js";
import type { Executor } from "./types.js";

const compositionLog = logger.child({ module: "executor-composition" });

export interface ConfiguredExecutorOptions {
  native: Executor;
  db: PrismaClient;
  env?: NodeJS.ProcessEnv;
  providerConfig?: ProviderConfig;
  /** Tests only: replaces the kubeconfig-backed client when JOB_LAUNCHER=kubernetes. */
  kubernetesApi?: KubernetesApi;
}

/** Builds container execution only when Docker or Kubernetes is explicitly selected. */
export function buildConfiguredExecutor(options: ConfiguredExecutorOptions): Executor {
  const env = options.env ?? process.env;
  const providerConfig = options.providerConfig ?? loadProviderConfig(env);
  if (providerConfig.jobs !== "docker" && providerConfig.jobs !== "kubernetes") return options.native;

  const github = loadGitHubVcsConfig(env);
  const config = loadContainerExecutorConfig(env);
  if (!config.workerImage) throw new Error(`CODING_WORKER_IMAGE is required when JOB_LAUNCHER=${providerConfig.jobs}.`);
  const proxyContainer = config.proxyContainer;
  if (providerConfig.jobs === "docker" && !proxyContainer) {
    throw new Error("CODING_PROXY_CONTAINER is required when JOB_LAUNCHER=docker.");
  }
  const workspaceRoot = resolve(github.workRoot ?? resolve(tmpdir(), "wardby-vcs"));
  const artifactRoot = resolve(config.artifactRoot ?? resolve(tmpdir(), "wardby-coding-artifacts"));
  const vcs = buildVcsProvider(providerConfig, { ...github, workRoot: workspaceRoot });
  const capabilities = new RunCapabilityVault();
  const sessions = new CodingProxy({
    ledger: new PrismaProxyLedger(options.db),
    credentials: new EnvironmentCredentialResolver(env),
  });
  let jobs: WorkspaceJobLauncher;
  if (providerConfig.jobs === "kubernetes") {
    if (!isRegistryDigest(config.workerImage)) {
      throw new Error("CODING_WORKER_IMAGE must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=kubernetes.");
    }
    const kubernetes = loadKubernetesJobConfig(env);
    // The preflight only runs on the first launch; a configuration that cannot work should
    // fail the process at start-up, not the first coding run an hour later.
    assertPlatformConfig(platformProfile(kubernetes.platform), {
      runtimeClassName: kubernetes.runtimeClassName,
      maxDiskMb: config.maxDiskMb,
    });
    const api = options.kubernetesApi ?? new ClientNodeKubernetesApi({ context: kubernetes.context });
    const workerImage = config.workerImage;
    jobs = new KubernetesJobLauncher({
      api,
      config: kubernetes,
      workspaceRoot,
      resolveCapability: (runId) => capabilities.get(runId),
      readyTimeoutMs: kubernetes.readyTimeoutMs,
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
  const concurrency = loadCodingConcurrencyConfig(env);
  // The release hook needs the composed RoutingExecutor, which only exists
  // after the ContainerExecutor it wraps is built. The closure reads
  // `composed` only when a run finishes, which is after this function returns.
  const coding = new ContainerExecutor({
    store: new PrismaContainerExecutionStore(options.db, { maxConcurrent: concurrency.maxConcurrent }),
    jobs,
    vcs,
    sessions,
    capabilities,
    artifactRoot,
    workerImage: config.workerImage,
    claudeWorkerImage: config.claudeWorkerImage,
    claudeToolRunnerImage: config.claudeToolRunnerImage,
    additionalWorkerImages: config.additionalWorkerImages,
    credentialRef: config.credentialRef,
    anthropicCredentialRef: config.anthropicCredentialRef,
    limits: { cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids, diskMb: config.diskMb },
    maxDiskMb: config.maxDiskMb,
    registryReport: async (runId) => {
      const rows = await options.db.registryFetch.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
      return {
        packages: rows
          .filter((row) => row.outcome === "served" && row.version)
          .map((row) => ({ ecosystem: row.ecosystem, name: row.name, version: row.version! })),
        packageRefusals: rows
          .filter((row) => row.outcome === "refused")
          .map((row) => ({ ecosystem: row.ecosystem, name: row.name, reason: row.reason ?? "refused" })),
      };
    },
    onSlotReleased: () => {
      void drainCodingQueue({
        db: options.db,
        executor: composed,
        maxConcurrent: concurrency.maxConcurrent,
        queueTimeoutSec: concurrency.queueTimeoutSec,
      }).catch((err: unknown) => {
        // Never throws: the next scheduler tick drains again.
        compositionLog.warn({ err }, "coding queue drain after a released slot failed");
      });
    },
  });
  const composed = new RoutingExecutor(new PrismaExecutionKindResolver(options.db), options.native, coding);
  return composed;
}
