/**
 * Fail-closed cluster preflight for JOB_LAUNCHER=kubernetes. Proves the
 * namespace and proxy Service exist, the worker image is a registry digest,
 * and — with a canary pod built from the real run pod and run NetworkPolicy —
 * that DNS, the internet, and the metadata server are unreachable while the
 * proxy is reachable. Any other state, error, or timeout fails the check.
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { KubernetesJobConfig } from "../../config/providers.js";
import type { KubernetesApi } from "./kubernetes-api.js";
import {
  KUBERNETES_ISOLATION_ERROR,
  WORKER_CONTAINER,
  buildRunNetworkPolicy,
  buildRunPod,
  isRegistryDigest,
} from "./kubernetes-isolation.js";
import type { JobSpec } from "./types.js";

export interface KubernetesPreflightOptions {
  api: KubernetesApi;
  config: KubernetesJobConfig;
  workerImage: string; // registry digest
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number; // default 90_000
}

export interface CanaryResult {
  dns: boolean;
  internet: boolean;
  metadata: boolean;
  proxy: boolean;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;
const LOG_TAIL_LINES = 20;
const LOG_LIMIT_BYTES = 4096;
const CANARY_LINE_PREFIX = '{"wardbyCanary":';
const EXPECTED: CanaryResult = { dns: false, internet: false, metadata: false, proxy: true };

/** Runs in the worker image under the run policy; prints exactly one `{"wardbyCanary":{...}}` line. */
export const CANARY_SCRIPT = [
  'const net = require("node:net");',
  'const dns = require("node:dns").promises;',
  "const tcp = (host, port) =>",
  "  new Promise((done) => {",
  "    const socket = net.connect({ host, port, timeout: 3000 });",
  '    socket.once("connect", () => {',
  "      socket.destroy();",
  "      done(true);",
  "    });",
  '    socket.once("timeout", () => {',
  "      socket.destroy();",
  "      done(false);",
  "    });",
  '    socket.once("error", () => done(false));',
  "  });",
  "(async () => {",
  "  const wardbyCanary = {",
  '    dns: await dns.lookup("kubernetes.default.svc.cluster.local").then(',
  "      () => true,",
  "      () => false,",
  "    ),",
  '    internet: await tcp("1.1.1.1", 443),',
  '    metadata: await tcp("169.254.169.254", 80),',
  "    proxy: await tcp(process.env.WARDBY_CANARY_PROXY_IP, 8787),",
  "  };",
  "  console.log(JSON.stringify({ wardbyCanary }));",
  "})();",
].join("\n");

/** A failed check. Carries no cause for canary-output failures so no log text can leave this module. */
class PreflightFailure extends Error {}

function failure(check: string, cause?: unknown): PreflightFailure {
  const message = `${KUBERNETES_ISOLATION_ERROR}:${check}`;
  return cause === undefined ? new PreflightFailure(message) : new PreflightFailure(message, { cause });
}

/** Runs one check; any error that is not already a check failure becomes this check's failure. */
async function runCheck<T>(check: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PreflightFailure) throw error;
    throw failure(check, error);
  }
}

/** Parses only the fixed canary line and requires exactly the four booleans. */
function parseCanary(log: string): CanaryResult | undefined {
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(CANARY_LINE_PREFIX));
  if (lines.length !== 1) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length !== 1) return undefined;
  const result = (parsed as { wardbyCanary?: unknown }).wardbyCanary;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const keys = Object.keys(result).sort();
  if (keys.join(",") !== "dns,internet,metadata,proxy") return undefined;
  const record = result as Record<string, unknown>;
  if (!keys.every((key) => typeof record[key] === "boolean")) return undefined;
  return { dns: record.dns, internet: record.internet, metadata: record.metadata, proxy: record.proxy } as CanaryResult;
}

function canaryPasses(result: CanaryResult | undefined): boolean {
  return (
    result !== undefined &&
    result.dns === EXPECTED.dns &&
    result.internet === EXPECTED.internet &&
    result.metadata === EXPECTED.metadata &&
    result.proxy === EXPECTED.proxy
  );
}

async function runCanary(options: KubernetesPreflightOptions, proxyIp: string): Promise<void> {
  const { api, config, workerImage } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const namespace = config.namespace;
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));

  const spec: JobSpec = {
    kind: "coding-agent",
    runId: `preflight-${randomBytes(8).toString("hex")}`,
    provider: "codex",
    image: workerImage,
    inputArtifact: "",
    timeoutSec,
    limits: { cpus: 0.25, memoryMb: 128, pids: 64, diskMb: 64 },
    labels: {},
  };
  const { pod, policy } = await runCheck("canary", async () => {
    const pod = buildRunPod(spec, { namespace, proxyIp, runtimeClassName: config.runtimeClassName });
    const podSpec = pod.spec!;
    const worker = podSpec.containers.find((container) => container.name === WORKER_CONTAINER);
    if (!worker) throw failure("canary");
    worker.env = [{ name: "WARDBY_CANARY_PROXY_IP", value: proxyIp }];
    worker.command = ["node", "-e", CANARY_SCRIPT];
    podSpec.containers = [worker];
    // The canary has no collection window: Kubernetes kills it at the preflight's own deadline.
    podSpec.activeDeadlineSeconds = timeoutSec;
    return { pod, policy: buildRunNetworkPolicy(spec, namespace) };
  });
  const podName = pod.metadata!.name!;
  const policyName = policy.metadata!.name!;

  let outcome: unknown;
  let failed = false;
  try {
    await runCheck("canary", async () => {
      // The policy exists before the pod so the canary never runs unpoliced.
      await api.createNetworkPolicy(namespace, policy);
      await api.createPod(namespace, pod);
      const deadline = now() + timeoutMs;
      for (;;) {
        const current = await api.readPod(namespace, podName);
        if (!current) throw failure("canary");
        const status = current.status?.containerStatuses?.find((entry) => entry.name === WORKER_CONTAINER);
        const terminated = status?.state?.terminated;
        if (terminated) {
          if (terminated.exitCode !== 0) throw failure("canary");
          break;
        }
        if (current.status?.phase === "Failed" || current.status?.phase === "Succeeded") throw failure("canary");
        if (now() >= deadline) throw failure("canary");
        await sleep(POLL_INTERVAL_MS);
      }
      let log: string;
      try {
        log = await api.readLogTail(namespace, podName, WORKER_CONTAINER, LOG_TAIL_LINES, LOG_LIMIT_BYTES);
      } catch {
        throw failure("canary");
      }
      if (!canaryPasses(parseCanary(log))) throw failure("canary");
    });
  } catch (error) {
    failed = true;
    outcome = error;
  } finally {
    const cleanup = await Promise.allSettled([
      api.deletePod(namespace, podName, 0),
      api.deleteNetworkPolicy(namespace, policyName),
    ]);
    // A canary that cannot be cleaned up is an unexpected cluster state: fail closed.
    if (!failed && cleanup.some((result) => result.status === "rejected")) {
      failed = true;
      outcome = failure("canary");
    }
  }
  if (failed) throw outcome;
}

/** Throws kubernetes_isolation_unsupported:<check> on the first failed check; returns the checks that passed. */
export async function kubernetesPreflight(options: KubernetesPreflightOptions): Promise<string[]> {
  const { api, config, workerImage } = options;
  const passed: string[] = [];

  await runCheck("namespace", async () => {
    if (!(await api.readNamespace(config.namespace))) throw failure("namespace");
  });
  passed.push("namespace");

  const proxyIp = await runCheck("proxy-service", async () => {
    const service = await api.readService(config.namespace, config.proxyService);
    const clusterIP = service?.spec?.clusterIP;
    if (!clusterIP || isIP(clusterIP) === 0) throw failure("proxy-service");
    return clusterIP;
  });
  passed.push("proxy-service");

  if (!isRegistryDigest(workerImage)) throw failure("worker-image");
  passed.push("worker-image");

  await runCanary(options, proxyIp);
  passed.push("canary");
  return passed;
}
