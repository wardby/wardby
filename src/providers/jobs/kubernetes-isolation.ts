/**
 * Canonical Kubernetes isolation policy for one Codex coding run, mirroring
 * docker-isolation.ts. Nothing else constructs run pods or policies; the
 * launcher reads every object back and attests it against these builders
 * before the worker is allowed to start (the seeded-marker gate).
 */
import { createHash } from "node:crypto";
import type { V1Container, V1NetworkPolicy, V1Pod, V1Secret } from "@kubernetes/client-node";
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

export function validateKubernetesSpec(spec: JobSpec): void {
  if (spec.kind !== "coding-agent" || !RUN_ID.test(spec.runId)) throw isolationError();
  if (spec.provider === "claude-code") throw new Error(KUBERNETES_PROVIDER_UNSUPPORTED);
  if (spec.provider !== undefined && spec.provider !== "codex") throw isolationError();
  if (spec.toolImage !== undefined || !isRegistryDigest(spec.image)) throw isolationError();
  const { cpus, memoryMb, pids, diskMb } = spec.limits;
  if (
    !inRange(cpus, 0.1, 32, false) ||
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

/** Canonical CPU (millicores) and memory (bytes) so "1" == "1000m" and "2048Mi" == "2Gi". */
function quantity(value: unknown): string {
  const text = String(value);
  const match = /^([0-9.]+)(m|Ki|Mi|Gi|Ti)?$/.exec(text);
  if (!match) return text;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "m") return `${amount}m`;
  if (unit === undefined && text.includes(".")) return `${amount * 1000}m`;
  const factor = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 } as const;
  if (unit) return String(amount * factor[unit as keyof typeof factor]);
  return /^\d+$/.test(text) && Number(text) < 1024 ? `${amount * 1000}m` : text;
}

function resources(r: V1Container["resources"]) {
  const pick = (m?: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(m ?? {})
        .map(([k, v]): [string, string] => [k, quantity(v)])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return { requests: pick(r?.requests), limits: pick(r?.limits) };
}

/** The security-relevant view of a container; API-defaulted fields are deliberately excluded. */
function containerProjection(c: V1Container) {
  return {
    name: c.name,
    image: c.image,
    command: c.command ?? null,
    args: c.args ?? null,
    env: c.env ?? [],
    envFrom: c.envFrom ?? [],
    ports: c.ports ?? [],
    securityContext: {
      allowPrivilegeEscalation: c.securityContext?.allowPrivilegeEscalation ?? null,
      privileged: c.securityContext?.privileged ?? null,
      readOnlyRootFilesystem: c.securityContext?.readOnlyRootFilesystem ?? null,
      runAsNonRoot: c.securityContext?.runAsNonRoot ?? null,
      capabilities: {
        drop: c.securityContext?.capabilities?.drop ?? [],
        add: c.securityContext?.capabilities?.add ?? [],
      },
      runAsUser: c.securityContext?.runAsUser ?? null,
      seccompProfile: c.securityContext?.seccompProfile ?? null,
    },
    resources: resources(c.resources),
    volumeMounts: (c.volumeMounts ?? []).map((m) => ({
      name: m.name,
      mountPath: m.mountPath,
      subPath: m.subPath ?? null,
      readOnly: m.readOnly ?? false,
    })),
  };
}

function podProjection(p: V1Pod) {
  const s = p.spec;
  if (!s) throw isolationError();
  return {
    labels: p.metadata?.labels ?? {},
    restartPolicy: s.restartPolicy,
    automountServiceAccountToken: s.automountServiceAccountToken ?? true,
    serviceAccountName: s.serviceAccountName,
    enableServiceLinks: s.enableServiceLinks ?? true,
    hostNetwork: s.hostNetwork ?? false,
    hostPID: s.hostPID ?? false,
    hostIPC: s.hostIPC ?? false,
    shareProcessNamespace: s.shareProcessNamespace ?? false,
    activeDeadlineSeconds: s.activeDeadlineSeconds ?? null,
    dnsPolicy: s.dnsPolicy,
    dnsConfig: s.dnsConfig ?? null,
    hostAliases: s.hostAliases ?? [],
    runtimeClassName: s.runtimeClassName ?? null,
    securityContext: {
      runAsNonRoot: s.securityContext?.runAsNonRoot ?? null,
      runAsUser: s.securityContext?.runAsUser ?? null,
      runAsGroup: s.securityContext?.runAsGroup ?? null,
      fsGroup: s.securityContext?.fsGroup ?? null,
      seccompProfile: s.securityContext?.seccompProfile ?? null,
      sysctls: s.securityContext?.sysctls ?? [],
    },
    volumes: (s.volumes ?? []).map((v) => {
      const { name, emptyDir, ...other } = v;
      return {
        name,
        emptyDir: emptyDir ? { medium: emptyDir.medium ?? "", sizeLimit: quantity(emptyDir.sizeLimit) } : null,
        other: Object.keys(other).sort(),
      };
    }),
    initContainers: (s.initContainers ?? []).map(containerProjection),
    ephemeralContainers: (s.ephemeralContainers ?? []).length,
    containers: s.containers.map(containerProjection),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function assertRunPodMatches(actual: V1Pod, expected: V1Pod): void {
  if (!sameJson(podProjection(actual), podProjection(expected))) throw isolationError();
}

export function assertRunNetworkPolicyMatches(actual: V1NetworkPolicy, expected: V1NetworkPolicy): void {
  const view = (p: V1NetworkPolicy) => ({
    podSelector: p.spec?.podSelector ?? null,
    policyTypes: p.spec?.policyTypes ?? [],
    ingress: p.spec?.ingress ?? [],
    egress: p.spec?.egress ?? [],
  });
  if (!sameJson(view(actual), view(expected))) throw isolationError();
}
