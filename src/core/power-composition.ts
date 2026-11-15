/**
 * Builds the process's single low-power `Power` from the environment. Every
 * composition root (serve, mcp, scheduler) calls this once and hands the same
 * instance to both executors, so wake and sleep agree on state.
 */
import type { PrismaClient } from "#prisma";
import { DEFAULT_NATIVE_GATEWAY_SERVICE, loadKubernetesJobConfig } from "../config/providers.js";
import { loadRendererConfig } from "../config/renderer.js";
import { loadLowPowerConfig } from "../config/low-power.js";
import { ClientNodeKubernetesApi } from "../providers/jobs/kubernetes-client.js";
import { logger } from "./logger.js";
import { createPower, DISABLED_POWER, type Power } from "./power.js";
import { powerBlockers, powerBusy } from "./power-idle.js";

const log = logger.child({ module: "power-composition" });

/** Low-power mode only scales Kubernetes Deployments; with any other job launcher it is ignored. */
const kubernetesJobs = (env: NodeJS.ProcessEnv) => env.JOB_LAUNCHER === "kubernetes";

/**
 * Whether buildPower would return an enabled Power for this environment (WARDBY_LOW_POWER=1 and
 * JOB_LAUNCHER=kubernetes), without building one. Throws on an invalid WARDBY_LOW_POWER.
 */
export function lowPowerActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadLowPowerConfig(env).enabled && kubernetesJobs(env);
}

export function buildPower({ env = process.env, db }: { env?: NodeJS.ProcessEnv; db: PrismaClient }): Power {
  const config = loadLowPowerConfig(env);
  if (!config.enabled) return DISABLED_POWER;
  if (!kubernetesJobs(env)) {
    log.warn("low_power_ignored: WARDBY_LOW_POWER requires JOB_LAUNCHER=kubernetes");
    return DISABLED_POWER;
  }
  const kubernetes = loadKubernetesJobConfig(env);
  const renderer = loadRendererConfig(env);
  return createPower({
    config,
    api: new ClientNodeKubernetesApi({ context: kubernetes.context }),
    namespace: kubernetes.namespace,
    deployments: {
      proxy: kubernetes.proxyService,
      gateway: env.NATIVE_GATEWAY_SERVICE?.trim() || DEFAULT_NATIVE_GATEWAY_SERVICE,
      // A target only when the renderer is configured (WARDBY_RENDERER_URL).
      ...(renderer.url ? { renderer: renderer.deployment } : {}),
    },
    busy: powerBusy(db),
    blockers: (target) => powerBlockers(db, target),
  });
}
