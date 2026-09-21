import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import {
  loadContainerExecutorConfig,
  loadGitHubVcsConfig,
  loadProviderConfig,
  type ProviderConfig,
} from "../../config/providers.js";
import { EnvironmentCredentialResolver } from "../coding-proxy/environment-credentials.js";
import { CodingProxy } from "../coding-proxy/proxy.js";
import { PrismaProxyLedger } from "../coding-proxy/prisma-ledger.js";
import { DockerJobLauncher } from "../jobs/docker.js";
import { buildVcsProvider } from "../vcs/index.js";
import { ContainerExecutor, PrismaContainerExecutionStore, RunCapabilityVault } from "./container.js";
import { PrismaExecutionKindResolver, RoutingExecutor } from "./routing.js";
import type { Executor } from "./types.js";

export interface ConfiguredExecutorOptions {
  native: Executor;
  db: PrismaClient;
  env?: NodeJS.ProcessEnv;
  providerConfig?: ProviderConfig;
}

/** Builds container execution only when Docker is explicitly selected. */
export function buildConfiguredExecutor(options: ConfiguredExecutorOptions): Executor {
  const env = options.env ?? process.env;
  const providerConfig = options.providerConfig ?? loadProviderConfig(env);
  if (providerConfig.jobs !== "docker") return options.native;

  const github = loadGitHubVcsConfig(env);
  const config = loadContainerExecutorConfig(env);
  if (!config.workerImage) throw new Error("CODING_WORKER_IMAGE is required when JOB_LAUNCHER=docker.");
  if (!config.proxyContainer) throw new Error("CODING_PROXY_CONTAINER is required when JOB_LAUNCHER=docker.");
  const workspaceRoot = resolve(github.workRoot ?? resolve(tmpdir(), "wardby-vcs"));
  const stateRoot = resolve(config.stateRoot ?? resolve(tmpdir(), "wardby-docker-jobs"));
  const artifactRoot = resolve(config.artifactRoot ?? resolve(tmpdir(), "wardby-coding-artifacts"));
  const vcs = buildVcsProvider(providerConfig, { ...github, workRoot: workspaceRoot });
  const capabilities = new RunCapabilityVault();
  const sessions = new CodingProxy({
    ledger: new PrismaProxyLedger(options.db),
    credentials: new EnvironmentCredentialResolver(env),
  });
  const jobs = new DockerJobLauncher({
    stateRoot,
    workspaceRoot,
    proxyContainer: config.proxyContainer,
    resolveCapability: (runId) => capabilities.get(runId),
    isRunActive: async (runId, handle) => {
      const coding = await options.db.codingRun.findUnique({
        where: { runId },
        include: { run: { select: { status: true } } },
      });
      return coding?.run.status === "running" && coding.jobBackend === handle.backend && coding.jobHandle === handle.id;
    },
  });
  const coding = new ContainerExecutor({
    store: new PrismaContainerExecutionStore(options.db),
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
  });
  return new RoutingExecutor(new PrismaExecutionKindResolver(options.db), options.native, coding);
}
