import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import {
  loadContainerExecutorConfig,
  loadGitHubVcsConfig,
  loadProviderConfig,
  type ProviderConfig,
} from "../../config/providers.js";
import { CodingProxy } from "../coding-proxy/proxy.js";
import { PrismaProxyLedger } from "../coding-proxy/prisma-ledger.js";
import type { CredentialResolver } from "../coding-proxy/types.js";
import { DockerJobLauncher } from "../jobs/docker.js";
import { buildVcsProvider } from "../vcs/index.js";
import { ContainerExecutor, PrismaContainerExecutionStore, RunCapabilityVault } from "./container.js";
import { PrismaExecutionKindResolver, RoutingExecutor } from "./routing.js";
import type { Executor } from "./types.js";

class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async resolve(reference: string): Promise<string> {
    const match = /^env:([A-Z][A-Z0-9_]{0,127})$/.exec(reference);
    if (!match) throw new Error("coding_credential_reference_invalid");
    const value = this.env[match[1]];
    if (!value) throw new Error("coding_credential_unavailable");
    return value;
  }
}

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
  const workspaceRoot = resolve(github.workRoot ?? resolve(tmpdir(), "reevo-vcs"));
  const stateRoot = resolve(config.stateRoot ?? resolve(tmpdir(), "reevo-docker-jobs"));
  const artifactRoot = resolve(config.artifactRoot ?? resolve(tmpdir(), "reevo-coding-artifacts"));
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
    credentialRef: config.credentialRef,
    limits: { cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids, diskMb: config.diskMb },
  });
  return new RoutingExecutor(new PrismaExecutionKindResolver(options.db), options.native, coding);
}
