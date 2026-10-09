import type { InfraInfo } from "../api/types";
import { initialCluster } from "./state";
import type { ClusterKind, ClusterState, InfraContainer, InfraEdge, InfraPod, KindItems, PolicyRule } from "./types";

// Neutral fixtures for the platform adapter and the Infrastructure tab.

export const RUN_SHA = "0123456789abcdef0123456789abcdef01234567";

/** The run egress policy's one rule: the coding proxy on 8080/TCP (matches the `egress` summary string). */
const PROXY_EGRESS: PolicyRule[] = [
  {
    peers: [{ kind: "pods", podLabels: { "app.kubernetes.io/name": "wardby-coding-proxy" }, namespaceLabels: null }],
    ports: [{ port: 8080, protocol: "TCP" }],
  },
];

const labels = {
  component: { "wardby.io/component": "coding-run" },
  managedBy: { "app.kubernetes.io/managed-by": "wardby" },
};

export const gkeInfo: InfraInfo = {
  launcher: "kubernetes",
  kubernetes: {
    namespace: "wardby",
    platform: "gke-autopilot",
    runtimeClass: "gvisor",
    proxyService: "wardby-coding-proxy",
    runLabel: "wardby.io/run-sha256",
    runLabelHashChars: 40,
    componentLabel: labels.component,
    managedByLabel: labels.managedBy,
  },
  native: null,
};

export const genericInfo: InfraInfo = {
  launcher: "kubernetes",
  kubernetes: { ...gkeInfo.kubernetes!, platform: "generic", runtimeClass: null },
  native: null,
};

export function container(over: Partial<InfraContainer> = {}): InfraContainer {
  return {
    name: "main",
    role: "main",
    image: "registry.example.com/wardby:1",
    state: "running",
    reason: null,
    ready: true,
    restarts: 0,
    requests: { cpu: "500m", memory: "512Mi" },
    limits: { cpu: null, memory: null },
    ...over,
  };
}

export function pod(name: string, over: Partial<InfraPod> = {}): InfraPod {
  return {
    name,
    phase: "Running",
    labels: {},
    owner: null,
    node: "node-1",
    runtimeClass: null,
    serviceAccount: null,
    startedAt: "2026-10-01T10:00:00Z",
    ready: true,
    terminating: false,
    containers: [container()],
    ...over,
  };
}

export function clusterOf(items: { [K in ClusterKind]?: KindItems[K][] }): ClusterState {
  const objects = { ...initialCluster.objects } as unknown as Record<string, Map<string, unknown>>;
  for (const [kind, list] of Object.entries(items)) {
    objects[kind] = new Map((list as { name: string }[]).map((i) => [i.name, i]));
  }
  return {
    ...initialCluster,
    connected: true,
    podsSynced: true,
    objects: objects as ClusterState["objects"],
    kindErrors: {},
  };
}

const gateway: InfraEdge = {
  kind: "gateway",
  name: "wardby-gateway",
  class: "gke-l7-global-external-managed",
  hosts: ["wardby.example.com"],
  annotations: { "networking.gke.io/security-policy": "your-project-armor" },
  redirectOnly: false,
  redirectScheme: null,
  backends: [],
};

export const gkeCluster: ClusterState = clusterOf({
  gateway: [gateway],
  service_account: [
    {
      name: "wardby-app",
      identity: { "iam.gke.io/gcp-service-account": "wardby-app@project.iam.gserviceaccount.com" },
    },
  ],
  pod: [
    pod("wardby-control-plane-6d8f-abcde", {
      owner: { kind: "ReplicaSet", name: "wardby-control-plane-6d8f" },
      serviceAccount: "wardby-app",
      containers: [
        container({ name: "control-plane" }),
        container({
          name: "cloud-sql-proxy",
          role: "sidecar",
          image: "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2",
          requests: { cpu: "100m", memory: "128Mi" },
        }),
      ],
    }),
    pod("wardby-coding-proxy-7c9d-fghij", {
      owner: { kind: "ReplicaSet", name: "wardby-coding-proxy-7c9d" },
      serviceAccount: "wardby-app",
    }),
    pod("wardby-headroom-5b4a-klmno", {
      owner: { kind: "ReplicaSet", name: "wardby-headroom-5b4a" },
      serviceAccount: "wardby-app",
    }),
    pod("wardby-run-abc123", {
      labels: { ...labels.component, "wardby.io/run-sha256": RUN_SHA },
      owner: null,
      runtimeClass: "gvisor",
      containers: [container({ name: "agent", requests: { cpu: "2", memory: "4Gi" } })],
    }),
    pod("wardby-migrate-xyz12", {
      phase: "Succeeded",
      ready: false,
      owner: { kind: "Job", name: "wardby-migrate" },
      containers: [container({ name: "migrate", ready: false, state: "terminated", reason: "Completed" })],
    }),
    pod("unrelated-pod", { containers: [container({ requests: { cpu: "4", memory: "8Gi" } })] }),
  ],
  network_policy: [
    {
      name: "wardby-run-egress",
      podSelector: labels.component,
      policyTypes: ["Egress"],
      selectsAll: false,
      ingressRules: 0,
      ingress: [],
      egressRules: PROXY_EGRESS,
      egress: ["pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP"],
    },
    {
      name: "other",
      podSelector: { app: "other" },
      policyTypes: ["Egress"],
      selectsAll: false,
      ingressRules: 0,
      ingress: [],
      egressRules: [],
      egress: ["anywhere"],
    },
  ],
  secret_store: [{ name: "wardby-store", provider: "gcpsm" }],
  secret: [{ name: "wardby-db" }, { name: "wardby-oauth" }],
});

export const genericCluster: ClusterState = clusterOf({
  ingress: [
    {
      kind: "ingress",
      name: "wardby",
      class: "nginx",
      hosts: ["wardby.example.com"],
      annotations: {},
      redirectOnly: false,
      redirectScheme: null,
      backends: [],
    },
  ],
  service_account: [{ name: "wardby", identity: {} }],
  pod: [
    pod("wardby-control-plane-1-aaaaa", {
      owner: { kind: "ReplicaSet", name: "wardby-control-plane-1" },
      serviceAccount: "wardby",
    }),
  ],
});

export const kindInfo: InfraInfo = {
  launcher: "kubernetes",
  kubernetes: { ...gkeInfo.kubernetes!, namespace: "wardby-coding", platform: "generic", runtimeClass: null },
  native: null,
};

// deploy/kind-coding: the control plane runs on the developer's machine; only the proxy and run pods are in-cluster.
export const kindCluster: ClusterState = clusterOf({
  pod: [
    pod("wardby-coding-proxy-7c9d-fghij", {
      owner: { kind: "ReplicaSet", name: "wardby-coding-proxy-7c9d" },
      node: "wardby-coding-control-plane",
    }),
    pod("wardby-run-abc123", {
      labels: { ...labels.component, "wardby.io/run-sha256": RUN_SHA },
      node: "wardby-coding-control-plane",
      containers: [container({ name: "agent" })],
    }),
  ],
  network_policy: [
    {
      name: "default-deny",
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      selectsAll: true,
      ingressRules: 0,
      ingress: [],
      egressRules: [],
      egress: [],
    },
    {
      name: "wardby-run-egress",
      podSelector: labels.component,
      policyTypes: ["Egress"],
      selectsAll: false,
      ingressRules: 0,
      ingress: [],
      egressRules: PROXY_EGRESS,
      egress: ["pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP"],
    },
  ],
});

export const RUN_SHA_2 = "fedcba9876543210fedcba9876543210fedcba98";
const PROXY_RULE = "pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP";

// The server creates one NetworkPolicy per run, selecting that run's pod by its run label.
const runPolicy = (sha: string, egress: string[]) => ({
  name: `wardby-run-${sha.slice(0, 8)}`,
  podSelector: { ...labels.component, "wardby.io/run-sha256": sha },
  policyTypes: ["Egress"],
  selectsAll: false,
  ingressRules: 0,
  ingress: [],
  egressRules: egress.length ? PROXY_EGRESS : [],
  egress,
});

export const twoRunsCluster: ClusterState = clusterOf({
  pod: [
    pod("wardby-run-one", {
      labels: { ...labels.component, "wardby.io/run-sha256": RUN_SHA },
      runtimeClass: "gvisor",
      containers: [container({ name: "agent" })],
    }),
    pod("wardby-run-two", {
      labels: { ...labels.component, "wardby.io/run-sha256": RUN_SHA_2 },
      runtimeClass: "gvisor",
      containers: [container({ name: "agent" })],
    }),
  ],
  network_policy: [runPolicy(RUN_SHA, [PROXY_RULE]), runPolicy(RUN_SHA_2, [PROXY_RULE, "cidr 10.0.0.0/8 :443/TCP"])],
});

const stateOwner = { kind: "ReplicaSet", name: "wardby-control-plane-6d8f" };
// Pods in the states the Map and Table label: terminating, completed and failed.
export const statesCluster = clusterOf({
  pod: [
    pod("wardby-control-plane-new", { owner: stateOwner }),
    pod("wardby-control-plane-old", {
      owner: stateOwner,
      ready: false,
      terminating: true,
      containers: [
        container({ name: "control-plane" }),
        container({ name: "cloud-sql-proxy", ready: false, state: "terminated", reason: "Error" }),
      ],
    }),
    pod("wardby-migrate-1", {
      owner: { kind: "Job", name: "wardby-migrate" },
      phase: "Succeeded",
      ready: false,
      containers: [container({ name: "migrate", ready: false, state: "terminated", reason: "Completed" })],
    }),
    pod("wardby-migrate-2", {
      owner: { kind: "Job", name: "wardby-migrate2" },
      phase: "Failed",
      ready: false,
      containers: [container({ name: "migrate", ready: false, state: "terminated", reason: "Error" })],
    }),
  ],
});

// Sandbox-mode native agents: a cold run pod, a warm pod a run claimed, and an idle warm pod.
export const NATIVE_SHA = "c".repeat(40);
const nativeComponent = { "wardby.io/component": "native-run" };
const warm = (token: string) => ({ ...nativeComponent, "wardby.io/pool": "warm", "wardby.io/warm-worker": token });
export const sandboxCluster = clusterOf({
  pod: [
    pod("wardby-native-aaaa", {
      labels: { ...nativeComponent, "wardby.io/run-sha256": NATIVE_SHA },
      runtimeClass: "gvisor",
      containers: [container({ name: "worker" })],
    }),
    pod("wardby-nwarm-1111", {
      labels: warm("1111"),
      runtimeClass: "gvisor",
      containers: [container({ name: "worker" })],
    }),
    pod("wardby-nwarm-2222", {
      labels: warm("2222"),
      runtimeClass: "gvisor",
      containers: [container({ name: "worker" })],
    }),
  ],
});

export const sandboxInfo: InfraInfo = {
  ...gkeInfo,
  native: {
    launcher: "kubernetes",
    warmPoolSize: 2,
    kubernetes: {
      namespace: "wardby",
      runtimeClass: "gvisor",
      runLabel: "wardby.io/run-sha256",
      componentLabel: nativeComponent,
      warmPoolLabel: { "wardby.io/pool": "warm" },
      warmWorkerLabel: "wardby.io/warm-worker",
    },
  },
};
