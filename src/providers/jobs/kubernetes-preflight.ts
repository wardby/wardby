/**
 * Fail-closed cluster preflight for JOB_LAUNCHER=kubernetes. Proves the
 * namespace exists, the proxy Service is a usable enforcement witness (both
 * ports exposed with a ready backend), the worker image is a registry digest,
 * and — with a canary pod built from the real run pod and run NetworkPolicy —
 * that DNS, the internet, the metadata server and **the proxy's deny port**
 * are unreachable while the proxy itself is reachable. Any other state, error,
 * or timeout fails the check; the whole preflight, cleanup included, is bounded.
 */
import { randomBytes } from "node:crypto";
import type { KubernetesJobConfig } from "../../config/providers.js";
import { CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "./docker-isolation.js";
import type { KubernetesApi } from "./kubernetes-api.js";
import {
  KUBERNETES_ISOLATION_ERROR,
  WORKER_CONTAINER,
  buildRunNetworkPolicy,
  buildRunPod,
  isRegistryDigest,
} from "./kubernetes-isolation.js";
import { readProxyWitness } from "./kubernetes-witness.js";
import type { JobSpec } from "./types.js";

export interface KubernetesPreflightOptions {
  api: KubernetesApi;
  config: KubernetesJobConfig;
  workerImage: string; // registry digest
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number; // default 90_000; bounds the whole preflight
  cleanupTimeoutMs?: number; // default 15_000; bounds each canary delete
}

export interface CanaryResult {
  dns: boolean;
  /** The proxy's deny port: reachable means the run policy is not being enforced. */
  proxyDeny: boolean;
  internet: boolean;
  metadata: boolean;
  proxy: boolean;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;
const LOG_TAIL_LINES = 20;
const LOG_LIMIT_BYTES = 4096;
const CANARY_LINE_PREFIX = '{"wardbyCanary":';
const EXPECTED: CanaryResult = { dns: false, proxyDeny: false, internet: false, metadata: false, proxy: true };
const CANARY_KEYS = Object.keys(EXPECTED).sort();

/**
 * Runs in the worker image under the run policy; prints exactly one `{"wardbyCanary":{...}}` line.
 * `dns` checks in-pod resolution; `proxyDeny` checks the policy itself — a TCP connect to the *same*
 * proxy pod on a port no run policy permits, which a namespace-wide allow-all policy would reopen.
 * Probing one destination on two ports is what makes the result decisive: `proxy` true with
 * `proxyDeny` false can only mean a policy is enforced and port-scoped.
 * CNIs program a new pod's policy a few seconds after it starts, so the script first waits (up to
 * 20 s) for the deny-port connect to be blocked; if it never is, `proxyDeny` reports true.
 */
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
  "const settle = async () => {",
  "  const until = Date.now() + 20000;",
  "  while (Date.now() < until) {",
  `    if (!(await tcp(process.env.WARDBY_CANARY_PROXY_IP, ${CODING_PROXY_DENY_PORT}))) return;`,
  "    await new Promise((wake) => setTimeout(wake, 500));",
  "  }",
  "};",
  "(async () => {",
  "  await settle();",
  "  const wardbyCanary = {",
  '    dns: await dns.lookup("kubernetes.default.svc.cluster.local").then(',
  "      () => true,",
  "      () => false,",
  "    ),",
  `    proxyDeny: await tcp(process.env.WARDBY_CANARY_PROXY_IP, ${CODING_PROXY_DENY_PORT}),`,
  '    internet: await tcp("1.1.1.1", 443),',
  '    metadata: await tcp("169.254.169.254", 80),',
  `    proxy: await tcp(process.env.WARDBY_CANARY_PROXY_IP, ${CODING_PROXY_PORT}),`,
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

/** Resolves with the action's result, or rejects with `onTimeout()` after `ms`. Never leaves a timer behind. */
async function within<T>(action: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([action, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Parses only the fixed canary line and requires exactly the five booleans. */
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
  if (keys.join(",") !== CANARY_KEYS.join(",")) return undefined;
  const record = result as Record<string, unknown>;
  if (!keys.every((key) => typeof record[key] === "boolean")) return undefined;
  return record as unknown as CanaryResult;
}

function canaryPasses(result: CanaryResult | undefined): boolean {
  return (
    result !== undefined &&
    result.dns === EXPECTED.dns &&
    result.proxyDeny === EXPECTED.proxyDeny &&
    result.internet === EXPECTED.internet &&
    result.metadata === EXPECTED.metadata &&
    result.proxy === EXPECTED.proxy
  );
}

/**
 * What the canary created, shared between the (possibly abandoned) canary
 * task and the preflight's cleanup. Once `finished` is set no new object is
 * created; a create still in flight at that point owns its own cleanup.
 */
interface CanaryState {
  namespace: string;
  podName?: string;
  policyName?: string;
  createInFlight: boolean;
  finished: boolean;
}

/** Deletes the pod (grace 0), and only then its policy, so the canary never runs unpoliced. */
async function deleteCanary(api: KubernetesApi, state: CanaryState, cleanupTimeoutMs: number): Promise<void> {
  const timedOut = () => new Error("canary_cleanup_timeout");
  if (state.podName) await within(api.deletePod(state.namespace, state.podName, 0), cleanupTimeoutMs, timedOut);
  if (state.policyName) {
    await within(api.deleteNetworkPolicy(state.namespace, state.policyName), cleanupTimeoutMs, timedOut);
  }
}

/** Issues one create; a create that settles after the preflight finished removes what it made. */
async function tracked<T>(state: CanaryState, create: () => Promise<T>, lateCleanup: () => Promise<void>): Promise<T> {
  if (state.finished) throw failure("timeout");
  state.createInFlight = true;
  try {
    return await create();
  } finally {
    state.createInFlight = false;
    if (state.finished) await lateCleanup().catch(() => undefined);
  }
}

async function runCanary(
  options: KubernetesPreflightOptions,
  state: CanaryState,
  proxyIp: string,
  timeoutMs: number,
  cleanupTimeoutMs: number,
): Promise<void> {
  const { api, config, workerImage } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
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
  const lateCleanup = () => deleteCanary(api, state, cleanupTimeoutMs);

  await runCheck("canary", async () => {
    // The policy exists before the pod so the canary never runs unpoliced.
    state.policyName = policyName;
    await tracked(state, () => api.createNetworkPolicy(namespace, policy), lateCleanup);
    state.podName = podName;
    await tracked(state, () => api.createPod(namespace, pod), lateCleanup);
    const deadline = now() + timeoutMs;
    for (;;) {
      if (state.finished) throw failure("timeout");
      const current = await api.readPod(namespace, podName);
      if (!current) throw failure("canary");
      const status = current.status?.containerStatuses?.find((entry) => entry.name === WORKER_CONTAINER);
      const terminated = status?.state?.terminated;
      if (terminated) {
        if (terminated.exitCode !== 0) throw failure("canary");
        break;
      }
      if (current.status?.phase === "Failed" || current.status?.phase === "Succeeded") throw failure("canary");
      if (now() >= deadline) throw failure("timeout");
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
}

async function runChecks(
  options: KubernetesPreflightOptions,
  state: CanaryState,
  passed: string[],
  timeoutMs: number,
  cleanupTimeoutMs: number,
): Promise<string> {
  const { api, config, workerImage } = options;

  await runCheck("namespace", async () => {
    if (!(await api.readNamespace(config.namespace))) throw failure("namespace");
  });
  passed.push("namespace");

  const proxyIp = await runCheck("proxy-service", async () => {
    const witness = await readProxyWitness(api, config.namespace, config.proxyService);
    return witness.clusterIp;
  });
  passed.push("proxy-service");

  if (!isRegistryDigest(workerImage)) throw failure("worker-image");
  passed.push("worker-image");

  await runCanary(options, state, proxyIp, timeoutMs, cleanupTimeoutMs);
  passed.push("canary");
  return proxyIp;
}

export interface KubernetesPreflightResult {
  checks: string[];
  /** The validated proxy Service ClusterIP; the launcher probes both of its ports to wait for each run's policy. */
  proxyIp: string;
}

/** Throws kubernetes_isolation_unsupported:<check> on the first failed check; returns the checks that passed. */
export async function kubernetesPreflight(options: KubernetesPreflightOptions): Promise<string[]> {
  return (await runKubernetesPreflight(options)).checks;
}

/**
 * Throws kubernetes_isolation_unsupported:<check> on the first failed check
 * (`:timeout` when the whole preflight exceeds `timeoutMs`); returns the checks that passed and
 * the proxy ClusterIP it validated.
 */
export async function runKubernetesPreflight(options: KubernetesPreflightOptions): Promise<KubernetesPreflightResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const state: CanaryState = { namespace: options.config.namespace, createInFlight: false, finished: false };
  const passed: string[] = [];

  let outcome: unknown;
  let failed = false;
  let proxyIp = "";
  try {
    proxyIp = await within(runChecks(options, state, passed, timeoutMs, cleanupTimeoutMs), timeoutMs, () =>
      failure("timeout"),
    );
  } catch (error) {
    failed = true;
    outcome = error;
  } finally {
    state.finished = true;
    // A create still in flight owns cleanup (see `tracked`); otherwise delete what exists now.
    if (!state.createInFlight) {
      try {
        await deleteCanary(options.api, state, cleanupTimeoutMs);
      } catch {
        // A canary that cannot be cleaned up is an unexpected cluster state: fail closed.
        if (!failed) {
          failed = true;
          outcome = failure("canary");
        }
      }
    }
  }
  if (failed) throw outcome;
  return { checks: passed, proxyIp };
}

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n", 1)[0].trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine || "unknown error";
}

/**
 * One operator-facing line for a failed preflight: the check code, plus the
 * short message of a cause only where the preflight attached one (API errors;
 * never canary output). Anything else (e.g. a kubeconfig load error) is shown briefly.
 */
export function describePreflightFailure(error: unknown): string {
  if (!(error instanceof PreflightFailure)) return shortMessage(error);
  return error.cause === undefined ? error.message : `${error.message} (${shortMessage(error.cause)})`;
}
