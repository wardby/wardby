/**
 * Canonical Kubernetes isolation policy for one Codex coding run, mirroring
 * docker-isolation.ts. Nothing else constructs run pods or policies; the
 * launcher reads every object back and attests it against these builders
 * before the worker is allowed to start (the seeded-marker gate).
 */
import { createHash } from "node:crypto";
import type {
  V1Container,
  V1NetworkPolicy,
  V1Pod,
  V1PodSpec,
  V1Secret,
  V1Toleration,
  V1Volume,
} from "@kubernetes/client-node";
import type { JobSpec } from "./types.js";
import {
  CODING_PROXY_ALIAS,
  CODING_PROXY_PORT,
  CODING_WORKER_GID,
  CODING_WORKER_UID,
  WORKER_STOP_GRACE_SECONDS,
} from "./docker-isolation.js";

export const KUBERNETES_ISOLATION_ERROR = "kubernetes_isolation_unsupported";
export const KUBERNETES_PROVIDER_UNSUPPORTED = "kubernetes_provider_unsupported";
export const KEEPER_CONTAINER = "keeper";
export const WORKER_CONTAINER = "worker";
export const STORAGE_ROOT = "/run/wardby/storage";
export const KEEPER_SEEDED_MARKER = `${STORAGE_ROOT}/input/.seeded`;
export const PROXY_POD_LABEL = { "app.kubernetes.io/name": "wardby-coding-proxy" } as const;
const WORKER_SERVICE_ACCOUNT = "wardby-coding-worker";
const REGISTRY_DIGEST = /^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;

/** The worker waits for the launcher's seeded marker, then runs the image's normal entrypoint. */
const WORKER_GATE = [
  'const fs = require("node:fs");',
  'const marker = "/run/wardby/input/.seeded";',
  "(function wait() {",
  "  if (fs.existsSync(marker)) {",
  '    import("/opt/wardby/coding-worker/main.js").catch(() => { process.exitCode = 1; });',
  "  } else {",
  "    setTimeout(wait, 250);",
  "  }",
  "})();",
].join("\n");

function isolationError(): Error {
  return new Error(KUBERNETES_ISOLATION_ERROR);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface KubernetesRunNames {
  token: string;
  runSha: string;
  pod: string;
  policy: string;
  record: string;
  secret: string;
}

export function kubernetesRunNames(runId: string): KubernetesRunNames {
  if (!RUN_ID.test(runId)) throw isolationError();
  const digest = sha256(runId);
  const token = digest.slice(0, 20);
  const base = `wardby-run-${token}`;
  return { token, runSha: digest.slice(0, 40), pod: base, policy: base, record: base, secret: `${base}-cap` };
}

export function runLabels(runId: string): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "wardby",
    "wardby.io/component": "coding-run",
    "wardby.io/run-sha256": kubernetesRunNames(runId).runSha,
  };
}

export function isRegistryDigest(image: string): boolean {
  return REGISTRY_DIGEST.test(image);
}

function inRange(value: number, min: number, max: number, integer: boolean): boolean {
  return Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
}

/** Kubernetes CPU requests/limits are always whole millicores; a fractional millicore can't be expressed. */
function isWholeMillicores(cpus: number): boolean {
  const millis = cpus * 1000;
  return Math.abs(Math.round(millis) - millis) < 1e-9;
}

export function validateKubernetesSpec(spec: JobSpec): void {
  if (spec.kind !== "coding-agent" || !RUN_ID.test(spec.runId)) throw isolationError();
  if (spec.provider === "claude-code") throw new Error(KUBERNETES_PROVIDER_UNSUPPORTED);
  if (spec.provider !== undefined && spec.provider !== "codex") throw isolationError();
  if (spec.toolImage !== undefined || !isRegistryDigest(spec.image)) throw isolationError();
  const { cpus, memoryMb, pids, diskMb } = spec.limits;
  if (
    !inRange(cpus, 0.1, 32, false) ||
    !isWholeMillicores(cpus) ||
    !inRange(memoryMb, 128, 65_536, true) ||
    !inRange(pids, 16, 4_096, true) ||
    !inRange(diskMb, 64, 32_768, true) ||
    !inRange(spec.timeoutSec, 1, 86_400, true)
  ) {
    throw isolationError();
  }
}

function containerSecurity() {
  return {
    allowPrivilegeEscalation: false,
    privileged: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    capabilities: { drop: ["ALL"] },
  };
}

export interface RunPodOptions {
  namespace: string;
  proxyIp: string;
  runtimeClassName?: string;
}

export function buildRunPod(spec: JobSpec, options: RunPodOptions): V1Pod {
  validateKubernetesSpec(spec);
  const names = kubernetesRunNames(spec.runId);
  const scratchMb = Math.max(16, Math.min(64, Math.floor(spec.limits.memoryMb / 8)));
  const keeper: V1Container = {
    name: KEEPER_CONTAINER,
    image: spec.image,
    command: ["node", "/opt/wardby/coding-worker/keeper.js"],
    securityContext: containerSecurity(),
    resources: { requests: { cpu: "250m", memory: "128Mi" }, limits: { cpu: "250m", memory: "128Mi" } },
    volumeMounts: [{ name: "storage", mountPath: STORAGE_ROOT }],
    readinessProbe: { exec: { command: ["test", "-d", `${STORAGE_ROOT}/output`] }, periodSeconds: 1 },
  };
  const worker: V1Container = {
    name: WORKER_CONTAINER,
    image: spec.image,
    command: ["node", "-e", WORKER_GATE],
    env: [
      { name: "WARDBY_PROXY_URL", value: `http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}` },
      { name: "WARDBY_RUN_CAPABILITY", valueFrom: { secretKeyRef: { name: names.secret, key: "capability" } } },
    ],
    securityContext: containerSecurity(),
    resources: {
      requests: { cpu: String(spec.limits.cpus), memory: `${spec.limits.memoryMb}Mi` },
      limits: { cpu: String(spec.limits.cpus), memory: `${spec.limits.memoryMb}Mi` },
    },
    volumeMounts: [
      { name: "storage", mountPath: "/workspace", subPath: "workspace" },
      { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
      { name: "storage", mountPath: "/run/wardby/output", subPath: "output" },
      { name: "tmp", mountPath: "/tmp" },
      { name: "home", mountPath: "/home/wardby" },
    ],
  };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: names.pod,
      namespace: options.namespace,
      labels: runLabels(spec.runId),
      annotations: { "wardby.io/run-id": spec.runId },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      serviceAccountName: WORKER_SERVICE_ACCOUNT,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      activeDeadlineSeconds: spec.timeoutSec,
      terminationGracePeriodSeconds: WORKER_STOP_GRACE_SECONDS,
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      hostAliases: [{ ip: options.proxyIp, hostnames: [CODING_PROXY_ALIAS] }],
      ...(options.runtimeClassName ? { runtimeClassName: options.runtimeClassName } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: CODING_WORKER_UID,
        runAsGroup: CODING_WORKER_GID,
        fsGroup: CODING_WORKER_GID,
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [
        { name: "storage", emptyDir: { sizeLimit: `${spec.limits.diskMb}Mi` } },
        { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: `${scratchMb}Mi` } },
        { name: "home", emptyDir: { medium: "Memory", sizeLimit: `${scratchMb}Mi` } },
      ],
      containers: [keeper, worker],
    },
  };
}

export function buildRunNetworkPolicy(spec: JobSpec, namespace: string): V1NetworkPolicy {
  const names = kubernetesRunNames(spec.runId);
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: names.policy, namespace, labels: runLabels(spec.runId) },
    spec: {
      podSelector: { matchLabels: runLabels(spec.runId) },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { ...PROXY_POD_LABEL } } }],
          ports: [{ protocol: "TCP", port: CODING_PROXY_PORT }],
        },
      ],
    },
  };
}

export function buildCapabilitySecret(spec: JobSpec, namespace: string, capability: string): V1Secret {
  const names = kubernetesRunNames(spec.runId);
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: { name: names.secret, namespace, labels: runLabels(spec.runId) },
    stringData: { capability },
  };
}

/**
 * Deny-by-default attestation. Rather than allowlisting the fields we expect
 * to see (which silently accepts anything the allowlist forgot — lifecycle
 * hooks, probes that reach the node's link-local metadata endpoint,
 * seLinuxOptions/appArmorProfile/procMount escapes, extra tolerations,
 * stray annotations, ...), we deep-compare the *entire* spec, labels, and
 * annotations, and only normalize the exact fields the Kubernetes API
 * server itself is known to default or reorder on read-back. Every other
 * field — every security-relevant one included — must match exactly.
 */

/** CPU quantities are always whole millicores; normalize "1", "1.0", and "1000m" to the same string. */
function cpuMillicores(value: unknown): string {
  const text = String(value).trim();
  const milli = /^([0-9]*\.?[0-9]+)m$/.exec(text);
  if (milli) return `${Math.round(Number(milli[1]))}m`;
  const plain = /^([0-9]*\.?[0-9]+)$/.exec(text);
  if (plain) return `${Math.round(Number(plain[1]) * 1000)}m`;
  return text;
}

const MEMORY_BINARY_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};
const MEMORY_DECIMAL_UNITS: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** Memory quantities can use binary or decimal suffixes; normalize every form to a byte count. */
function memoryBytes(value: unknown): string {
  const text = String(value).trim();
  const match = /^([0-9]*\.?[0-9]+)(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/.exec(text);
  if (!match) return text;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit && unit in MEMORY_BINARY_UNITS) return String(Math.round(amount * MEMORY_BINARY_UNITS[unit]));
  if (unit && unit in MEMORY_DECIMAL_UNITS) return String(Math.round(amount * MEMORY_DECIMAL_UNITS[unit]));
  return String(Math.round(amount));
}

interface DefaultToleration {
  key: string;
  operator: string;
  effect: string;
  tolerationSeconds: number;
}

/** The two node-health tolerations every pod gets by admission-time default; anything else must match exactly. */
const DEFAULT_TOLERATIONS: readonly DefaultToleration[] = [
  { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
  { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
];

function isDefaultToleration(t: V1Toleration): boolean {
  return DEFAULT_TOLERATIONS.some(
    (d) =>
      t.key === d.key &&
      t.operator === d.operator &&
      t.effect === d.effect &&
      t.tolerationSeconds === d.tolerationSeconds,
  );
}

function normalizeResources(r?: V1Container["resources"]): void {
  if (!r) return;
  if (r.requests) {
    if (r.requests.cpu !== undefined) r.requests.cpu = cpuMillicores(r.requests.cpu);
    if (r.requests.memory !== undefined) r.requests.memory = memoryBytes(r.requests.memory);
  }
  if (r.limits) {
    if (r.limits.cpu !== undefined) r.limits.cpu = cpuMillicores(r.limits.cpu);
    if (r.limits.memory !== undefined) r.limits.memory = memoryBytes(r.limits.memory);
  }
}

function normalizeProbe(p?: V1Container["readinessProbe"]): void {
  if (!p) return;
  p.timeoutSeconds ??= 1;
  p.successThreshold ??= 1;
  p.failureThreshold ??= 3;
  p.periodSeconds ??= 10;
}

function normalizeContainer(c: V1Container): void {
  delete c.terminationMessagePath;
  delete c.terminationMessagePolicy;
  delete c.imagePullPolicy;
  normalizeResources(c.resources);
  normalizeProbe(c.readinessProbe);
  normalizeProbe(c.livenessProbe);
  normalizeProbe(c.startupProbe);
  for (const mount of c.volumeMounts ?? []) {
    if (mount.mountPropagation === "None") delete mount.mountPropagation;
  }
}

function normalizeVolume(v: V1Volume): void {
  if (v.emptyDir) {
    if (v.emptyDir.medium === "") delete v.emptyDir.medium;
    if (v.emptyDir.sizeLimit !== undefined) v.emptyDir.sizeLimit = memoryBytes(v.emptyDir.sizeLimit);
  }
}

/**
 * Applies only the normalizations the Kubernetes API server itself performs
 * (defaulting or aliasing fields on write/read). Everything else in the
 * spec — including every security-relevant field — is left untouched so
 * the caller's deep-equality check sees it.
 */
function normalizeSpec(spec: V1PodSpec): void {
  delete spec.schedulerName;
  delete spec.nodeName;
  delete spec.priority;
  delete spec.preemptionPolicy;
  if (spec.serviceAccount !== undefined) {
    if (spec.serviceAccount !== spec.serviceAccountName) throw isolationError();
    delete spec.serviceAccount;
  }
  if (spec.tolerations) {
    const remaining = spec.tolerations.filter((t) => !isDefaultToleration(t));
    if (remaining.length === 0) delete spec.tolerations;
    else spec.tolerations = remaining;
  }
  for (const container of spec.containers) normalizeContainer(container);
  for (const container of spec.initContainers ?? []) normalizeContainer(container);
  for (const volume of spec.volumes ?? []) normalizeVolume(volume);
}

function normalizePod(pod: V1Pod): {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  spec: V1PodSpec;
} {
  if (!pod.spec) throw isolationError();
  const spec = structuredClone(pod.spec);
  normalizeSpec(spec);
  return {
    labels: pod.metadata?.labels ?? {},
    annotations: pod.metadata?.annotations ?? {},
    spec,
  };
}

/** Recursively sorts object keys and drops `undefined` values so key order and API-omitted fields never matter; array order is preserved. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([key, v]): [string, unknown] => [key, canonical(v)])
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

export function assertRunPodMatches(actual: V1Pod, expected: V1Pod): void {
  const a = canonical(normalizePod(actual));
  const e = canonical(normalizePod(expected));
  if (JSON.stringify(a) !== JSON.stringify(e)) throw isolationError();
}

export function assertRunNetworkPolicyMatches(actual: V1NetworkPolicy, expected: V1NetworkPolicy): void {
  const view = (p: V1NetworkPolicy) => ({ labels: p.metadata?.labels ?? {}, spec: p.spec ?? {} });
  if (JSON.stringify(canonical(view(actual))) !== JSON.stringify(canonical(view(expected)))) throw isolationError();
}
