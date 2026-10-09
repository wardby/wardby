/**
 * Kubernetes objects for one sandbox-mode native run (docs/native-sandbox.md), as pure builders —
 * the launcher creates exactly these and attests what the API server stored against them. One pod
 * per run, with no service-account token, a read-only non-root container holding no credentials,
 * its WorkerInput (capability included) mounted read-only from a per-run Secret, and a
 * NetworkPolicy whose only egress is the native gateway's port. Names carry a hash of the run id,
 * never the id itself.
 */

import { createHash } from "node:crypto";
import type { V1NetworkPolicy, V1Pod, V1Secret } from "@kubernetes/client-node";
import { isRepositoryDigest } from "../providers/jobs/docker-isolation.js";
import {
  conformResources,
  GVISOR_RUNTIME_CLASS,
  platformProfile,
  type KubernetesPlatform,
} from "../providers/jobs/kubernetes-platform.js";
import {
  NATIVE_GATEWAY_DENY_PORT,
  NATIVE_GATEWAY_PORT,
  NATIVE_WORKER_TMP_MB,
  NATIVE_WORKER_UID,
  nativeWarmWorkerName,
  type NativeWorkerLimits,
} from "./docker-isolation.js";

export { nativeWarmWorkerName };
import type { WorkerInput } from "./protocol.js";
import { WARM_INPUT_FILE } from "./warm-delivery.js";

export const NATIVE_RUN_COMPONENT_LABEL = { "wardby.io/component": "native-run" } as const;
export const NATIVE_GATEWAY_POD_LABEL = { "app.kubernetes.io/name": "wardby-native-gateway" } as const;
const MANAGED_BY_LABEL = { "app.kubernetes.io/managed-by": "wardby" } as const;
export const NATIVE_RUN_SHA_LABEL = "wardby.io/run-sha256";
/** The label selector listing every native run pod (the janitor's listing). */
export const NATIVE_RUN_SELECTOR = "wardby.io/component=native-run";

export const NATIVE_WORKER_CONTAINER = "worker";
export const NATIVE_INPUT_MOUNT = "/run/wardby/input";
export const NATIVE_INPUT_KEY = "input.json";
export const NATIVE_INPUT_FILE = `${NATIVE_INPUT_MOUNT}/${NATIVE_INPUT_KEY}`;
/** Room for node's own writes besides /tmp; the root filesystem is read-only. */
const EPHEMERAL_STORAGE_MI = 128;

export interface NativeKubernetesNames {
  runSha: string;
  pod: string;
  policy: string;
  secret: string;
}

export function nativeKubernetesNames(runId: string): NativeKubernetesNames {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(runId)) throw new Error("native_sandbox_invalid_run_id");
  const digest = createHash("sha256").update(runId).digest("hex");
  const base = `wardby-native-${digest.slice(0, 20)}`;
  return { runSha: digest.slice(0, 40), pod: base, policy: base, secret: `${base}-input` };
}

export function nativeRunLabels(runId: string): Record<string, string> {
  return {
    ...MANAGED_BY_LABEL,
    ...NATIVE_RUN_COMPONENT_LABEL,
    [NATIVE_RUN_SHA_LABEL]: nativeKubernetesNames(runId).runSha,
  };
}

export function buildNativeInputSecret(input: WorkerInput, namespace: string): V1Secret {
  const names = nativeKubernetesNames(input.runId);
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: names.secret, namespace, labels: nativeRunLabels(input.runId) },
    type: "Opaque",
    immutable: true,
    stringData: { [NATIVE_INPUT_KEY]: JSON.stringify(input) },
  };
}

export interface NativeRunPodOptions {
  runId: string;
  namespace: string;
  image: string;
  limits: NativeWorkerLimits;
  /** The pod's hard lifetime: the run's session deadline. */
  activeDeadlineSeconds: number;
  runtimeClassName?: string;
  /** The cluster's admission rules the pod must already satisfy (KUBERNETES_PLATFORM). Default: "generic". */
  platform?: KubernetesPlatform;
  /** KUBERNETES_RUN_PRIORITY_CLASS: the class must exist in the cluster, or every create is refused. */
  priorityClassName?: string;
}

export const NATIVE_SANDBOX_PLATFORM_ERROR = "native_sandbox_platform_unsupported";

export function buildNativeRunPod(options: NativeRunPodOptions): V1Pod {
  const names = nativeKubernetesNames(options.runId);
  return buildNativePod(options, {
    name: names.pod,
    labels: nativeRunLabels(options.runId),
    env: [{ name: "NATIVE_WORKER_INPUT_FILE", value: NATIVE_INPUT_FILE }],
    input: { secretName: names.secret },
  });
}

/** The labels of every warm pool pod: still a native-run pod (the gateway admits it), never a run's. */
export const NATIVE_WARM_POOL_LABEL = { "wardby.io/pool": "warm" } as const;
export const NATIVE_WARM_TOKEN_LABEL = "wardby.io/warm-worker";
/** The label selector listing every warm pool pod. */
export const NATIVE_WARM_SELECTOR = "wardby.io/component=native-run,wardby.io/pool=warm";

export function nativeWarmLabels(token: string): Record<string, string> {
  return {
    ...MANAGED_BY_LABEL,
    ...NATIVE_RUN_COMPONENT_LABEL,
    ...NATIVE_WARM_POOL_LABEL,
    [NATIVE_WARM_TOKEN_LABEL]: token,
  };
}

export interface NativeWarmPodOptions extends Omit<NativeRunPodOptions, "runId"> {
  token: string;
  /** NATIVE_WORKER_INPUT_WAIT_MS: how long the worker waits to be claimed before it exits. */
  waitMs: number;
}

/** A warm pool pod (native sandbox phase 6): no input yet; it waits for one delivered by exec. */
export function buildNativeWarmPod(options: NativeWarmPodOptions): V1Pod {
  return buildNativePod(options, {
    name: nativeWarmWorkerName(options.token),
    labels: nativeWarmLabels(options.token),
    env: [
      { name: "NATIVE_WORKER_INPUT_FILE", value: WARM_INPUT_FILE },
      { name: "NATIVE_WORKER_INPUT_WAIT_MS", value: String(Math.floor(options.waitMs)) },
    ],
  });
}

function buildNativePod(
  options: Omit<NativeRunPodOptions, "runId">,
  identity: {
    name: string;
    labels: Record<string, string>;
    env: { name: string; value: string }[];
    input?: { secretName: string };
  },
): V1Pod {
  const { namespace, image, limits } = options;
  if (!isRepositoryDigest(image)) {
    throw new Error("native_sandbox_image_not_pinned: a cluster pulls by registry digest (repo@sha256:...).");
  }
  const profile = platformProfile(options.platform ?? "generic");
  if (profile.requiresGvisor && options.runtimeClassName !== GVISOR_RUNTIME_CLASS) {
    throw new Error(
      `${NATIVE_SANDBOX_PLATFORM_ERROR}: platform ${profile.name} runs native workers only under the ${GVISOR_RUNTIME_CLASS} RuntimeClass.`,
    );
  }
  // Already legal on the platform, so admission rewrites nothing (attestation compares resources).
  // Native pods always declare ephemeral storage, which a generic profile would otherwise drop.
  const conformed = conformResources(profile, {
    cpuMillicores: Math.round(limits.cpus * 1000),
    memoryMib: limits.memoryMb,
    ephemeralStorageMib: EPHEMERAL_STORAGE_MI,
  });
  const resources = { ...conformed.requests, "ephemeral-storage": `${EPHEMERAL_STORAGE_MI}Mi` };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: identity.name, namespace, labels: identity.labels },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: Math.max(1, Math.floor(options.activeDeadlineSeconds)),
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      terminationGracePeriodSeconds: 5,
      ...(options.runtimeClassName ? { runtimeClassName: options.runtimeClassName } : {}),
      ...(options.priorityClassName ? { priorityClassName: options.priorityClassName } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: NATIVE_WORKER_UID,
        runAsGroup: NATIVE_WORKER_UID,
        // Secret files mount root-owned: group ownership lets the non-root worker read its input.
        fsGroup: NATIVE_WORKER_UID,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: NATIVE_WORKER_CONTAINER,
          image,
          imagePullPolicy: "IfNotPresent",
          env: identity.env,
          resources: { requests: { ...resources }, limits: { ...resources } },
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [
            ...(identity.input ? [{ name: "input", mountPath: NATIVE_INPUT_MOUNT, readOnly: true }] : []),
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [
        ...(identity.input
          ? [{ name: "input", secret: { secretName: identity.input.secretName, defaultMode: 0o440 } }]
          : []),
        { name: "tmp", emptyDir: { sizeLimit: `${NATIVE_WORKER_TMP_MB}Mi` } },
      ],
    },
  };
}

/** Ingress: none. Egress: the native gateway's pods, on the gateway port only. */
export function buildNativeRunNetworkPolicy(runId: string, namespace: string): V1NetworkPolicy {
  return buildNativePolicy(nativeKubernetesNames(runId).policy, namespace, nativeRunLabels(runId));
}

/** A warm pool pod's policy: the same egress, selecting the pod by its token. */
export function buildNativeWarmNetworkPolicy(token: string, namespace: string): V1NetworkPolicy {
  return buildNativePolicy(nativeWarmWorkerName(token), namespace, nativeWarmLabels(token));
}

function buildNativePolicy(name: string, namespace: string, labels: Record<string, string>): V1NetworkPolicy {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace, labels },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { ...NATIVE_GATEWAY_POD_LABEL } } }],
          ports: [{ protocol: "TCP", port: NATIVE_GATEWAY_PORT }],
        },
      ],
    },
  };
}

/** Exit codes of the in-pod enforcement probe. */
export const NATIVE_PROBE = { proven: 0, gatewayUnreachable: 3, denyReachable: 4, outsideReachable: 5 } as const;

/** Addresses a worker must not reach: the internet, and the cloud metadata server (node and workload credentials). */
export const NATIVE_PROBE_OUTSIDE: readonly { host: string; port: number }[] = [
  { host: "1.1.1.1", port: 443 },
  { host: "169.254.169.254", port: 80 },
];

/**
 * Run inside the worker container (exec): proves the pod's egress is the gateway port and nothing
 * else — the gateway answers, while its deny port (same address, another port) and every outside
 * address do not. A connection that is refused or times out both count as unreachable.
 */
export function nativeEnforcementProbe(
  gatewayHost: string,
  outside: readonly { host: string; port: number }[] = NATIVE_PROBE_OUTSIDE,
): string[] {
  const script = [
    'const net = require("node:net");',
    "const reach = (host, port) => new Promise((done) => {",
    "  const s = net.connect({ host, port, timeout: 3000 });",
    "  s.once('connect', () => { s.destroy(); done(true); });",
    "  s.once('error', () => done(false));",
    "  s.once('timeout', () => { s.destroy(); done(false); });",
    "});",
    "(async () => {",
    `  if (!(await reach(${JSON.stringify(gatewayHost)}, ${NATIVE_GATEWAY_PORT}))) process.exit(${NATIVE_PROBE.gatewayUnreachable});`,
    `  if (await reach(${JSON.stringify(gatewayHost)}, ${NATIVE_GATEWAY_DENY_PORT})) process.exit(${NATIVE_PROBE.denyReachable});`,
    ...outside.map(
      (o) => `  if (await reach(${JSON.stringify(o.host)}, ${o.port})) process.exit(${NATIVE_PROBE.outsideReachable});`,
    ),
    `  process.exit(${NATIVE_PROBE.proven});`,
    "})();",
  ].join("\n");
  return ["node", "-e", script];
}
