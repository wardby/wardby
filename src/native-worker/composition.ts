/**
 * Builds the native sandbox executor from configuration (NATIVE_SANDBOX_*, docs/native-sandbox.md),
 * or nothing when the native sandbox is not configured — sandbox-mode runs then fail closed.
 */

import { loadNativeSandboxConfig } from "../config/providers.js";
import type { NativeRunProviders, RunnerDb } from "../core/runner.js";
import { nativeGatewayUrl } from "./docker-isolation.js";
import { DockerNativeWorkerLauncher } from "./docker-launcher.js";
import { PrismaGatewayLedger, type GatewayLedgerDb } from "./ledger.js";
import { KubernetesNativeWorkerLauncher } from "./kubernetes-launcher.js";
import { ClientNodeKubernetesApi } from "../providers/jobs/kubernetes-client.js";
import type { KubernetesApi } from "../providers/jobs/kubernetes-api.js";
import { SANDBOX_RUN_MAX_SEC } from "../core/runner.js";
import { NativeSandboxExecutor, type ManagedWorkerLauncher } from "./sandbox-executor.js";

export function buildNativeSandboxExecutor(options: {
  db: RunnerDb & GatewayLedgerDb;
  /** Read at call time: the composition root patches `executor` on after wrapping this one. */
  providers: NativeRunProviders;
  env?: NodeJS.ProcessEnv;
  /** Tests only: replaces the launcher. */
  launcher?: ManagedWorkerLauncher;
  /** Tests only: replaces the kubeconfig-backed client for NATIVE_SANDBOX_LAUNCHER=kubernetes. */
  kubernetesApi?: KubernetesApi;
}): NativeSandboxExecutor | undefined {
  const config = loadNativeSandboxConfig(options.env ?? process.env);
  if (!config) return undefined;
  const limits = { cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids };
  const launcher: ManagedWorkerLauncher =
    options.launcher ??
    (config.launcher === "kubernetes"
      ? new KubernetesNativeWorkerLauncher({
          api: options.kubernetesApi ?? new ClientNodeKubernetesApi({ context: config.context }),
          namespace: config.namespace,
          image: config.workerImage,
          limits,
          gatewayService: config.gatewayService,
          runtimeClassName: config.runtimeClassName,
          gatewayUrl: config.gatewayUrl,
          deadlineSeconds: SANDBOX_RUN_MAX_SEC,
          // Isolation proven inside the pod: the gateway may now serve the run.
          onNetworkProven: (runId) => new PrismaGatewayLedger(options.db).markNetworkReadyForRun(runId),
        })
      : new DockerNativeWorkerLauncher({
          image: config.workerImage,
          gatewayContainer: config.gatewayContainer,
          limits,
        }));
  return new NativeSandboxExecutor({
    db: options.db,
    providers: options.providers,
    launcher,
    // Kubernetes resolves the gateway's ClusterIP per launch (resolveGatewayUrl) unless overridden.
    gatewayUrl: config.gatewayUrl ?? nativeGatewayUrl(),
  });
}
