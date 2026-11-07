/**
 * Low-power mode: the control plane scales the coding proxy and native gateway
 * Deployments to zero when idle and wakes them before a run needs them. With
 * the mode off every method is a no-op and no Kubernetes API call is made.
 */
import type { V1Endpoints } from "@kubernetes/client-node";
import type { LowPowerConfig } from "../config/low-power.js";
import { KubernetesForbiddenError, type KubernetesApi } from "../providers/jobs/kubernetes-api.js";
import { logger } from "./logger.js";

const powerLog = logger.child({ module: "power" });

export type PowerTarget = "proxy" | "gateway";
export const LOW_POWER_WAKE_TIMEOUT = "low_power_wake_timeout";
export const LOW_POWER_SCALE_FORBIDDEN = "low_power_scale_forbidden";
export const LOW_POWER_DISABLED = "low_power_disabled";
/**
 * A coding run with MCP tools could not wake the native gateway that serves them: the run fails
 * before its worker launches (category mcp_gateway_unavailable).
 */
export const CODING_MCP_GATEWAY_UNAVAILABLE = "coding_mcp_gateway_unavailable";
/** ISO-8601 time the control plane last scaled the Deployment up from zero. */
export const POWER_WOKE_AT = "wardby.io/power-woke-at";
/**
 * The least time a launcher waits for a woken target: a cold node can take a minute or two to
 * come up. A launcher's own ready timeout above this raises the bound.
 */
export const LOW_POWER_WAKE_FLOOR_MS = 300_000;
/** How long a launcher with this ready timeout lets ensureAwake wait. */
export const wakeTimeoutMs = (readyTimeoutMs: number): number => Math.max(readyTimeoutMs, LOW_POWER_WAKE_FLOOR_MS);
/** sleepIfIdle does real work at most this often. */
const SLEEP_SWEEP_INTERVAL_MS = 60_000;

export interface PowerOptions {
  config: LowPowerConfig;
  /** Required when config.enabled. */
  api?: KubernetesApi;
  namespace: string;
  /** Deployment name per target; each has the same name as its Service. */
  deployments: Record<PowerTarget, string>;
  /** Whether the target has had work since `since` (used by sleepIfIdle). */
  busy?: (target: PowerTarget, since: Date) => Promise<boolean>;
  /** Run ids keeping the target busy right now (active or queued; ignores recent finishes). Needed by sleepNow. */
  blockers?: (target: PowerTarget) => Promise<string[]>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How often ensureAwake polls for a ready endpoint. Default 2000. */
  pollMs?: number;
}

export interface Power {
  readonly enabled: boolean;
  /** Scales the target up from zero if needed and waits for a ready endpoint. */
  ensureAwake(target: PowerTarget, opts: { timeoutMs: number; runId: string }): Promise<void>;
  isAsleep(target: PowerTarget): Promise<boolean>;
  sleepIfIdle(): Promise<void>;
  /** Missing permissions, e.g. "patch deployments/wardby-coding-proxy". */
  checkAccess(): Promise<string[]>;
  /** Each target's state. A target whose Deployment does not exist is left out. Disabled: `{ enabled: false }`, no API call. */
  status(): Promise<PowerStatus>;
  /**
   * Scales each target to zero now, skipping the idle window and woke-at grace,
   * unless it has blockers (then it is reported, untouched). Never stops a run.
   * A target whose Deployment does not exist is neither slept nor blocked.
   */
  sleepNow(targets: PowerTarget[]): Promise<SleepNowResult>;
}

export interface PowerTargetStatus {
  target: PowerTarget;
  replicas: number;
  ready: boolean;
  wokeAt: string | null;
  blockers: string[];
}
export interface PowerStatus {
  enabled: boolean;
  targets?: PowerTargetStatus[];
}
export interface SleepNowResult {
  slept: PowerTarget[];
  blocked: Array<{ target: PowerTarget; runIds: string[] }>;
}

export const DISABLED_POWER: Power = {
  enabled: false,
  async ensureAwake() {},
  async isAsleep() {
    return false;
  },
  async sleepIfIdle() {},
  async checkAccess() {
    return [];
  },
  async status() {
    return { enabled: false };
  },
  async sleepNow() {
    throw new Error(`${LOW_POWER_DISABLED}: WARDBY_LOW_POWER is not 1 on this deployment.`);
  },
};

const ready = (ep?: V1Endpoints) => (ep?.subsets ?? []).some((s) => (s.addresses ?? []).length > 0);

/** Rethrows a Forbidden read or patch as low_power_scale_forbidden; anything else unchanged. */
function scaleError(error: unknown, name: string, access = "patch Deployment"): unknown {
  if (!(error instanceof KubernetesForbiddenError)) return error;
  return new Error(
    `${LOW_POWER_SCALE_FORBIDDEN}: the control plane may not ${access} "${name}"; apply the wardby-power Role (up.sh with WARDBY_LOW_POWER=1).`,
    { cause: error },
  );
}

export function createPower(options: PowerOptions): Power {
  if (!options.config.enabled) return DISABLED_POWER;
  const { api, namespace, deployments } = options;
  if (!api) throw new Error("Low-power mode needs a Kubernetes API client.");
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 2000;
  const { busy, blockers } = options;
  const idleMinutes = options.config.idleMinutes;
  const idleMs = idleMinutes * 60_000;
  // The idle window counts from the later of the Deployment's woke-at stamp and this process's
  // start: a stamp left from before a restart (or none at all) never sleeps a target sooner.
  const startedAt = now().getTime();
  let lastSweep: number | undefined;

  const readDeployment = async (name: string) => {
    try {
      return await api.readDeployment(namespace, name);
    } catch (error) {
      throw scaleError(error, name, "get Deployment");
    }
  };

  const readEndpoints = async (name: string) => {
    try {
      return await api.readEndpoints(namespace, name);
    } catch (error) {
      throw scaleError(error, name, "get Endpoints");
    }
  };

  async function sleepTarget(target: PowerTarget, at: number): Promise<void> {
    if (!api || !busy) return;
    const name = deployments[target];
    const dep = await readDeployment(name);
    if (!dep || (dep.spec?.replicas ?? 1) === 0) return;
    const stamped = Date.parse(dep.metadata?.annotations?.[POWER_WOKE_AT] ?? "");
    const wokeAt = Number.isNaN(stamped) ? startedAt : Math.max(stamped, startedAt);
    if (at - wokeAt < idleMs) return;
    const since = new Date(at - idleMs);
    if (await busy(target, since)) return;
    // A run may have started since the first check; look again right before scaling down.
    if (await busy(target, since)) return;
    await api.patchDeployment(namespace, name, { replicas: 0 });
    powerLog.info({ target }, `power: ${target} slept (idle ${idleMinutes}m)`);
  }

  return {
    enabled: true,

    async ensureAwake(target, { timeoutMs, runId }) {
      const name = deployments[target];
      const dep = await readDeployment(name);
      if (!dep) throw new Error(`${LOW_POWER_WAKE_TIMEOUT}: Deployment "${name}" not found in "${namespace}".`);
      if ((dep.spec?.replicas ?? 1) === 0) {
        try {
          await api.patchDeployment(namespace, name, {
            replicas: 1,
            annotations: { [POWER_WOKE_AT]: now().toISOString() },
          });
        } catch (error) {
          throw scaleError(error, name);
        }
        powerLog.info({ target, runId }, `power: ${target} woke`);
      }
      const deadline = now().getTime() + timeoutMs;
      while (!ready(await readEndpoints(name))) {
        if (now().getTime() >= deadline) {
          throw new Error(
            `${LOW_POWER_WAKE_TIMEOUT}: ${target} "${name}" had no ready endpoint within ${timeoutMs} ms.`,
          );
        }
        await sleep(pollMs);
      }
    },

    async isAsleep(target) {
      return ((await readDeployment(deployments[target]))?.spec?.replicas ?? 1) === 0;
    },

    async sleepIfIdle() {
      const at = now().getTime();
      if (lastSweep !== undefined && at - lastSweep < SLEEP_SWEEP_INTERVAL_MS) return;
      lastSweep = at;
      for (const target of Object.keys(deployments) as PowerTarget[]) {
        try {
          await sleepTarget(target, at);
        } catch (err) {
          powerLog.warn({ err, target }, "power_sleep_failed");
        }
      }
    },

    async status() {
      const targets: PowerTargetStatus[] = [];
      for (const target of Object.keys(deployments) as PowerTarget[]) {
        const name = deployments[target];
        const dep = await readDeployment(name);
        if (!dep) continue;
        targets.push({
          target,
          replicas: dep.spec?.replicas ?? 1,
          ready: ready(await readEndpoints(name)),
          wokeAt: dep.metadata?.annotations?.[POWER_WOKE_AT] ?? null,
          blockers: blockers ? await blockers(target) : [],
        });
      }
      return { enabled: true, targets };
    },

    async sleepNow(targets) {
      // Without a blockers check this could scale a target out from under a run.
      if (!blockers) throw new Error("power: sleepNow needs a blockers check.");
      const result: SleepNowResult = { slept: [], blocked: [] };
      for (const target of targets) {
        const name = deployments[target];
        const dep = await readDeployment(name);
        if (!dep) continue;
        if ((dep.spec?.replicas ?? 1) === 0) {
          result.slept.push(target);
          continue;
        }
        let runIds = await blockers(target);
        // A run may have started since the first check; look again right before scaling down.
        if (runIds.length === 0) runIds = await blockers(target);
        if (runIds.length > 0) {
          result.blocked.push({ target, runIds });
          continue;
        }
        try {
          await api.patchDeployment(namespace, name, { replicas: 0 });
        } catch (error) {
          throw scaleError(error, name);
        }
        powerLog.info({ target }, `power: ${target} slept (forced)`);
        result.slept.push(target);
      }
      return result;
    },

    async checkAccess() {
      const missing: string[] = [];
      for (const name of Object.values(deployments)) {
        for (const verb of ["get", "patch"]) {
          if (!(await api.canI(namespace, verb, "apps", "deployments", name)))
            missing.push(`${verb} deployments/${name}`);
        }
        // ensureAwake and status poll the Service's Endpoints (same name as the Deployment).
        if (!(await api.canI(namespace, "get", "", "endpoints", name))) missing.push(`get endpoints/${name}`);
      }
      return missing;
    },
  };
}
