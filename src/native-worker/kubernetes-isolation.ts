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
  NATIVE_GATEWAY_DENY_PORT,
  NATIVE_GATEWAY_PORT,
  NATIVE_WORKER_TMP_MB,
  NATIVE_WORKER_UID,
  type NativeWorkerLimits,
} from "./docker-isolation.js";
import type { WorkerInput } from "./protocol.js";

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
}

export function buildNativeRunPod(options: NativeRunPodOptions): V1Pod {
  const { runId, namespace, image, limits } = options;
  if (!isRepositoryDigest(image)) {
    throw new Error("native_sandbox_image_not_pinned: a cluster pulls by registry digest (repo@sha256:...).");
  }
  const names = nativeKubernetesNames(runId);
  const cpu = String(limits.cpus);
  const memory = `${limits.memoryMb}Mi`;
  const ephemeral = `${EPHEMERAL_STORAGE_MI}Mi`;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: names.pod, namespace, labels: nativeRunLabels(runId) },
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
          env: [{ name: "NATIVE_WORKER_INPUT_FILE", value: NATIVE_INPUT_FILE }],
          resources: {
            requests: { cpu, memory, "ephemeral-storage": ephemeral },
            limits: { cpu, memory, "ephemeral-storage": ephemeral },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [
            { name: "input", mountPath: NATIVE_INPUT_MOUNT, readOnly: true },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [
        { name: "input", secret: { secretName: names.secret, defaultMode: 0o440 } },
        { name: "tmp", emptyDir: { sizeLimit: `${NATIVE_WORKER_TMP_MB}Mi` } },
      ],
    },
  };
}

/** Ingress: none. Egress: the native gateway's pods, on the gateway port only. */
export function buildNativeRunNetworkPolicy(runId: string, namespace: string): V1NetworkPolicy {
  const names = nativeKubernetesNames(runId);
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: names.policy, namespace, labels: nativeRunLabels(runId) },
    spec: {
      podSelector: { matchLabels: nativeRunLabels(runId) },
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

/**
 * Run inside the worker container (exec): proves the pod's egress is the gateway port and nothing
 * else — the gateway answers, while its deny port (same address, another port) and an outside
 * address do not. A connection that is refused or times out both count as unreachable.
 */
export function nativeEnforcementProbe(gatewayHost: string, outside = { host: "1.1.1.1", port: 443 }): string[] {
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
    `  if (await reach(${JSON.stringify(outside.host)}, ${outside.port})) process.exit(${NATIVE_PROBE.outsideReachable});`,
    `  process.exit(${NATIVE_PROBE.proven});`,
    "})();",
  ].join("\n");
  return ["node", "-e", script];
}
