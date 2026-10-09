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
import { PooledWorkerLauncher, type WarmWorkerLauncher } from "./warm-pool.js";
import { PrismaWarmPoolLedger, type WarmPoolDb } from "./warm-pool-ledger.js";

export function buildNativeSandboxExecutor(options: {
  db: RunnerDb & GatewayLedgerDb & WarmPoolDb;
  /** Read at call time: the composition root patches `executor` on after wrapping this one. */
  providers: NativeRunProviders;
  env?: NodeJS.ProcessEnv;
  /** Tests only: replaces the launcher. */
  launcher?: ManagedWorkerLauncher & Partial<WarmWorkerLauncher>;
  /** Tests only: replaces the kubeconfig-backed client for NATIVE_SANDBOX_LAUNCHER=kubernetes. */
  kubernetesApi?: KubernetesApi;
}): NativeSandboxExecutor | undefined {
  const config = loadNativeSandboxConfig(options.env ?? process.env);
  if (!config) return undefined;
  const limits = { cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids };
  const markReady = (runId: string) => new PrismaGatewayLedger(options.db).markNetworkReadyForRun(runId);
  const cold: ManagedWorkerLauncher & Partial<WarmWorkerLauncher> =
    options.launcher ??
    (config.launcher === "kubernetes"
      ? new KubernetesNativeWorkerLauncher({
          api: options.kubernetesApi ?? new ClientNodeKubernetesApi({ context: config.context }),
          namespace: config.namespace,
          image: config.workerImage,
          limits,
          gatewayService: config.gatewayService,
          runtimeClassName: config.runtimeClassName,
          platform: config.platform,
          priorityClassName: config.priorityClassName,
          readyTimeoutMs: config.readyTimeoutMs,
          enforcementTimeoutMs: config.enforcementTimeoutMs,
          gatewayUrl: config.gatewayUrl,
          deadlineSeconds: SANDBOX_RUN_MAX_SEC,
          // Isolation proven inside the pod: the gateway may now serve the run.
          onNetworkProven: markReady,
        })
      : new DockerNativeWorkerLauncher({
          image: config.workerImage,
          gatewayContainer: config.gatewayContainer,
          limits,
        }));
  // The pool also starts with size 0 when the launcher can run one: its first tick removes workers
  // left from an earlier configuration, and nothing runs after that.
  const launcher: ManagedWorkerLauncher = isWarmCapable(cold)
    ? new PooledWorkerLauncher({
        ledger: new PrismaWarmPoolLedger(options.db),
        launcher: cold,
        size: config.warmPoolSize,
        maxAgeMs: config.warmMaxAgeMs,
        warmTimeoutMs:
          config.launcher === "kubernetes"
            ? (config.readyTimeoutMs ?? 120_000) + (config.enforcementTimeoutMs ?? 30_000)
            : 120_000,
        onDelivered: markReady,
      })
    : cold;
  return new NativeSandboxExecutor({
    db: options.db,
    providers: options.providers,
    launcher,
    // Kubernetes resolves the gateway's ClusterIP per launch (resolveGatewayUrl) unless overridden.
    gatewayUrl: config.gatewayUrl ?? nativeGatewayUrl(),
    maxConcurrent: config.maxConcurrent,
  });
}

function isWarmCapable(
  launcher: ManagedWorkerLauncher & Partial<WarmWorkerLauncher>,
): launcher is ManagedWorkerLauncher & WarmWorkerLauncher {
  return typeof launcher.startWarm === "function" && typeof launcher.deliver === "function";
}
