import { describe as suite, expect, it } from "vitest";
import { describe, parseCpu, parseMemory, platformOf } from "./adapter";
import {
  clusterOf,
  container,
  genericCluster,
  genericInfo,
  gkeCluster,
  gkeInfo,
  kindCluster,
  kindInfo,
  NATIVE_SHA,
  pod,
  sandboxCluster,
  sandboxInfo,
  twoRunsCluster,
} from "./fixtures";
import type { InfraBackendPolicy, InfraEdge, InfraNetworkPolicy } from "./types";

const route = (over: Partial<InfraEdge> = {}): InfraEdge => ({
  kind: "httproute",
  name: "r",
  class: null,
  hosts: ["app.example.com"],
  annotations: {},
  redirectOnly: false,
  redirectScheme: null,
  backends: ["web"],
  ...over,
});
const policy = (over: Partial<InfraBackendPolicy> = {}): InfraBackendPolicy => ({
  name: "p",
  targetKind: "Gateway",
  targetName: "wardby-gateway",
  securityPolicy: "armor-1",
  ...over,
});
const netpol = (over: Partial<InfraNetworkPolicy> = {}): InfraNetworkPolicy => ({
  name: "np",
  podSelector: {},
  policyTypes: ["Ingress", "Egress"],
  selectsAll: true,
  ingressRules: 0,
  ingress: [],
  egressRules: [],
  egress: [],
  ...over,
});

suite("describe", () => {
  it("labels a GKE footprint", () => {
    const m = describe(gkeCluster, gkeInfo);
    expect(m.platform).toBe("gke");
    // The request path: Gateway, then Cloud Armor as its own step, then the routes.
    expect(m.edge[0]).toMatchObject({ label: "Gateway", detail: expect.arrayContaining(["TLS"]) });
    expect(m.edge[1]).toMatchObject({ label: "Cloud Armor" });
    expect(m.dataStores[0]).toMatchObject({ label: "Cloud SQL" });
    expect(m.secrets.source).toBe("Secret Manager");
    expect(m.groups.alwaysOn.map((p) => p.title)).toEqual(["control-plane", "coding-proxy", "headroom"]);
    expect(m.groups.alwaysOn[0].identity).toBe("GSA wardby-app@project.iam.gserviceaccount.com");
    expect(m.groups.codingRuns[0]).toMatchObject({
      runtime: "gVisor",
      runSha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(m.groups.jobs.map((p) => p.title)).toEqual(["wardby-migrate"]);
    expect(m.isolation.egressRules).toEqual(["pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP"]);
    expect(m.isolation.sandbox).toBe("gVisor");
  });

  it("falls back to plain names on an unknown cluster", () => {
    const m = describe(genericCluster, genericInfo);
    expect(m.platform).toBe("generic");
    expect(m.edge[0]).toMatchObject({ label: "Ingress", hosts: ["wardby.example.com"] });
    expect(m.dataStores[0]).toMatchObject({ label: "Postgres (external)" });
    expect(m.groups.alwaysOn[0].identity).toBe("SA wardby");
    expect(m.secrets.source).toBeNull();
  });

  it("uses a Service's edge for generic LoadBalancer edges", () => {
    const c = clusterOf({
      service: [
        {
          name: "lb",
          serviceType: "LoadBalancer",
          ports: ["80/TCP"],
          edge: {
            kind: "loadbalancer",
            name: "lb",
            class: null,
            hosts: ["203.0.113.1"],
            annotations: {},
            redirectOnly: false,
            redirectScheme: null,
            backends: [],
          },
        },
        { name: "internal", serviceType: "ClusterIP", ports: [], edge: null },
      ],
    });
    const m = describe(c, genericInfo);
    expect(m.edge).toHaveLength(1);
    expect(m.edge[0]).toMatchObject({ label: "Load Balancer", hosts: ["203.0.113.1"] });
  });

  it("hides secret names when secrets are forbidden", () => {
    const c = {
      ...gkeCluster,
      kindErrors: { secret: { kind: "forbidden", resource: "secrets" } },
    } as typeof gkeCluster;
    expect(describe(c, gkeInfo).secrets).toMatchObject({ names: null, forbidden: true });
    expect(describe(gkeCluster, gkeInfo).secrets).toMatchObject({
      names: ["wardby-db", "wardby-oauth"],
      forbidden: false,
    });
  });

  it("does not call another secrets error 'no access'", () => {
    const c = {
      ...gkeCluster,
      kindErrors: { secret: { kind: "unreachable", message: "connection refused" } },
    } as typeof gkeCluster;
    expect(describe(c, gkeInfo).secrets).toMatchObject({ names: null, forbidden: false });
  });

  it("lists each egress rule once across per-run NetworkPolicies", () => {
    const m = describe(twoRunsCluster, gkeInfo);
    expect(m.isolation.egressRules).toEqual([
      "pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP",
      "cidr 10.0.0.0/8 :443/TCP",
    ]);
  });

  it("gives each pod only the egress of the policies that select it", () => {
    const [one, two] = describe(twoRunsCluster, gkeInfo).groups.codingRuns;
    expect(one.egress).toEqual(["pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP"]);
    expect(two.egress).toEqual([
      "pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP",
      "cidr 10.0.0.0/8 :443/TCP",
    ]);
    // A shared component-wide policy selects every run pod; another app's policy selects none.
    const shared = describe(gkeCluster, gkeInfo);
    expect(shared.groups.codingRuns[0].egress).toEqual(["pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP"]);
    expect(shared.groups.alwaysOn[0].egress).toEqual([]);
  });

  it("omits pods outside wardby's footprint", () => {
    const m = describe(gkeCluster, gkeInfo);
    const all = [...m.groups.alwaysOn, ...m.groups.codingRuns, ...m.groups.jobs].map((p) => p.name);
    expect(all).not.toContain("unrelated-pod");
    expect(m.totals.pods).toBe(5);
  });

  it("totals requests", () => {
    const c = clusterOf({
      pod: [
        pod("wardby-control-plane-1-a", {
          owner: { kind: "ReplicaSet", name: "wardby-control-plane-1" },
          containers: [
            container({ requests: { cpu: "500m", memory: "512Mi" } }),
            container({ name: "x", role: "init", requests: { cpu: "1", memory: "1Gi" } }),
          ],
        }),
        pod("wardby-run-1", {
          labels: { "wardby.io/component": "coding-run" },
          containers: [container({ requests: { cpu: "2", memory: "4Gi" } })],
        }),
      ],
    });
    const m = describe(c, genericInfo);
    // Like kubectl's READY, the one-shot init container counts toward neither readiness nor requests.
    expect(m.totals).toMatchObject({ pods: 2, codingRuns: 1, readyContainers: 2, cpuMillis: 2500, memoryMiB: 4608 });
  });

  it("platformOf never returns eks", () => {
    expect(platformOf(gkeInfo, gkeCluster)).toBe("gke");
    expect(platformOf(genericInfo, genericCluster)).toBe("generic");
  });

  it("detects gke-autopilot by platform without the SA annotation", () => {
    expect(platformOf(gkeInfo, genericCluster)).toBe("gke");
  });

  it("detects GKE by the SA annotation when platform is generic", () => {
    expect(platformOf(genericInfo, gkeCluster)).toBe("gke");
  });
});

suite("quantities", () => {
  it("parses cpu", () => {
    expect(parseCpu("500m")).toBe(500);
    expect(parseCpu("2")).toBe(2000);
    expect(parseCpu("0.5")).toBe(500);
    expect(parseCpu(null)).toBe(0);
  });
  it("parses memory to MiB", () => {
    expect(parseMemory("512Mi")).toBe(512);
    expect(parseMemory("4Gi")).toBe(4096);
    expect(parseMemory("1G")).toBeCloseTo(953.674, 2);
    expect(parseMemory("1048576")).toBe(1);
    expect(parseMemory("1024Ki")).toBe(1);
    expect(parseMemory(null)).toBe(0);
  });
});

suite("kind and out-of-cluster control planes", () => {
  it("labels a kind cluster with the control plane outside it", () => {
    const m = describe(kindCluster, kindInfo, {
      serverUrl: "http://127.0.0.1:18080/mcp",
      context: "kind-wardby-coding",
    });
    expect(m.platform).toBe("kind");
    expect(m.controlPlane).toEqual({ inCluster: false, location: "127.0.0.1:18080" });
    expect(m.edge).toEqual([]);
    expect(m.groups.alwaysOn.map((p) => p.title)).toEqual(["coding-proxy"]);
    expect(m.groups.codingRuns[0].runtime).toBe("none (container runtime)");
    expect(m.dataStores[0].label).toBe("Postgres (external)");
  });

  it("detects kind from the context name or node names", () => {
    expect(platformOf(genericInfo, kindCluster, { context: "kind-dev" })).toBe("kind");
    expect(platformOf(genericInfo, kindCluster, {})).toBe("kind");
    expect(platformOf(genericInfo, genericCluster, { context: "prod" })).toBe("generic");
  });

  it("keeps the control plane in-cluster on GKE", () => {
    expect(describe(gkeCluster, gkeInfo).controlPlane).toEqual({ inCluster: true });
  });

  it("reports an outside control plane on any platform", () => {
    const m = describe(clusterOf({}), genericInfo, {
      serverUrl: "https://wardby.internal:8443/x",
    });
    expect(m.controlPlane).toEqual({ inCluster: false, location: "wardby.internal:8443" });
  });

  it("does not call mismatched node names kind", () => {
    const withNodes = (...nodes: string[]) => clusterOf({ pod: nodes.map((n, i) => pod(`p${i}`, { node: n })) });
    expect(platformOf(genericInfo, withNodes("prod-worker1"), {})).toBe("generic");
    expect(platformOf(genericInfo, withNodes("k8s-control-plane", "node-a", "node-b"), {})).toBe("generic");
    expect(platformOf(genericInfo, withNodes("a-control-plane", "b-worker"), {})).toBe("generic");
    expect(platformOf(genericInfo, withNodes("dev-control-plane", "dev-worker", "dev-worker2"), {})).toBe("kind");
  });

  it("never reports kind on a gke-autopilot server", () => {
    expect(platformOf(gkeInfo, kindCluster, { context: "kind-x" })).toBe("gke");
  });

  it("treats a kind- context as decisive on a generic server", () => {
    expect(platformOf(genericInfo, genericCluster, { context: "kind-x" })).toBe("kind");
  });

  it("marks sandboxed pods and labels an unsandboxed coding run", () => {
    expect(describe(gkeCluster, gkeInfo).groups.codingRuns[0].sandboxed).toBe(true);
    const run = describe(kindCluster, kindInfo).groups.codingRuns[0];
    expect(run.sandboxed).toBe(false);
    expect(run.runtime).toBe("none (container runtime)");
  });

  it("handles a missing, invalid and IPv6 server URL", () => {
    const loc = (serverUrl?: string) => describe(kindCluster, kindInfo, { serverUrl }).controlPlane;
    expect(loc()).toEqual({ inCluster: false, location: null });
    expect(loc("not a url")).toEqual({ inCluster: false, location: null });
    expect(loc("http://[::1]:18080/mcp")).toEqual({ inCluster: false, location: "[::1]:18080" });
  });

  it("keeps the control plane in-cluster until pods have synced", () => {
    const unsynced = { ...kindCluster, podsSynced: false };
    expect(describe(unsynced, kindInfo, { serverUrl: "http://127.0.0.1:1/" }).controlPlane).toEqual({
      inCluster: true,
    });
  });

  it("shows an HTTPRoute's hostnames, and names a redirect-only route", () => {
    const c = clusterOf({
      http_route: [
        route({ name: "main" }),
        route({ name: "redirect", redirectOnly: true, redirectScheme: "https", backends: [] }),
        route({ name: "other-redirect", redirectOnly: true, redirectScheme: "http", backends: [] }),
      ],
    });
    const edges = describe(c, genericInfo).edge;
    expect(edges.map((e) => e.detail)).toEqual([["app.example.com"], ["HTTP → HTTPS redirect"], ["Redirect"]]);
    expect(edges.every((e) => e.label === "HTTPRoute")).toBe(true);
  });

  it("adds Cloud Armor from a GCPBackendPolicy targeting the Gateway (GKE only)", () => {
    const gw = { ...gkeCluster.objects.gateway.get("wardby-gateway")!, annotations: {} };
    const c = clusterOf({ gateway: [gw], backend_policy: [policy()] });
    expect(describe(c, gkeInfo).edge.map((e) => [e.label, e.detail])).toEqual([
      ["Gateway", ["TLS"]],
      ["Cloud Armor", ["armor-1"]],
    ]);
    // A policy without a securityPolicy, or aimed at another target, adds nothing.
    const none = clusterOf({
      gateway: [gw],
      backend_policy: [policy({ securityPolicy: null }), policy({ name: "q", targetName: "elsewhere" })],
    });
    expect(describe(none, gkeInfo).edge.map((e) => e.label)).toEqual(["Gateway"]);
    // Other platforms ignore the CRD.
    expect(describe(c, genericInfo).edge[0].detail).toEqual([]);
  });

  it("folds a redirect-only route into the entry and orders the path entry → protection → routes", () => {
    const gw = { ...gkeCluster.objects.gateway.get("wardby-gateway")!, annotations: {} };
    const c = clusterOf({
      gateway: [gw],
      http_route: [route({ name: "main" }), route({ name: "redir", redirectOnly: true, redirectScheme: "https" })],
      backend_policy: [policy({ targetKind: "Service", targetName: "web" })],
    });
    expect(describe(c, gkeInfo).edge.map((e) => [e.label, e.detail])).toEqual([
      ["Gateway", ["TLS", "HTTP → HTTPS redirect"]],
      ["Cloud Armor", ["armor-1"]],
      ["HTTPRoute", ["app.example.com"]],
    ]);
  });

  it("adds Cloud Armor to the HTTPRoute behind a Service that a policy targets", () => {
    const c = clusterOf({
      http_route: [route({ name: "main" }), route({ name: "other", backends: ["api"] })],
      backend_policy: [policy({ targetKind: "Service", targetName: "web" })],
    });
    // Cloud Armor is a step in front of the routes, not a detail on one.
    expect(describe(c, gkeInfo).edge.map((e) => [e.label, e.detail])).toEqual([
      ["Cloud Armor", ["armor-1"]],
      ["HTTPRoute", ["app.example.com"]],
      ["HTTPRoute", ["app.example.com"]],
    ]);
  });

  it("labels completed, failed and terminating pods", () => {
    const owner = { kind: "ReplicaSet", name: "wardby-control-plane-1" };
    const c = clusterOf({
      pod: [
        pod("wardby-control-plane-1-a", { owner, terminating: true, ready: false }),
        pod("wardby-migrate-1", { owner: { kind: "Job", name: "wardby-migrate" }, phase: "Succeeded", ready: false }),
        pod("wardby-migrate-2", { owner: { kind: "Job", name: "wardby-migrate2" }, phase: "Failed", ready: false }),
      ],
    });
    const m = describe(c, genericInfo);
    expect(m.groups.alwaysOn[0]).toMatchObject({ status: "Terminating", terminating: true });
    expect(m.groups.jobs.map((p) => [p.status, p.phase])).toEqual([
      ["Completed", "Succeeded"],
      ["Failed", "Failed"],
    ]);
  });

  it("summarizes NetworkPolicies and detects a default deny", () => {
    const iso = (policies: InfraNetworkPolicy[]) =>
      describe(clusterOf({ network_policy: policies }), genericInfo).isolation.policies;
    expect(iso([])).toMatchObject({ count: 0, defaultDeny: false, list: [] });
    expect(iso([netpol()])).toMatchObject({ count: 1, defaultDeny: true });
    const two = iso([netpol(), netpol({ name: "b", selectsAll: false, podSelector: { a: "b" } })]);
    expect(two).toMatchObject({ count: 2, defaultDeny: true });
    // One line per policy: what it selects and what it allows.
    expect(two.list[0]).toMatchObject({ selects: "all pods", rules: ["denies all"] });
    expect(two.list[1]).toMatchObject({ name: "b", selects: "a=b" });
    // An empty selector that allows something is not a deny; neither is a labelled selector.
    expect(iso([netpol({ ingressRules: 1 })]).defaultDeny).toBe(false);
    expect(iso([netpol({ egress: ["any"] })]).defaultDeny).toBe(false);
    expect(iso([netpol({ selectsAll: false, podSelector: { a: "b" } })]).defaultDeny).toBe(false);
    // Unspecified policyTypes default to Ingress (plus Egress when it has egress rules).
    expect(iso([netpol({ policyTypes: [] })]).defaultDeny).toBe(true);
    expect(iso([netpol({ policyTypes: ["Egress"], ingressRules: 2 })]).defaultDeny).toBe(true);
  });

  it("lists the NetworkPolicies that select a pod, including select-all ones", () => {
    const m = describe(kindCluster, kindInfo);
    expect(m.groups.codingRuns[0].policies).toEqual(["default-deny", "wardby-run-egress"]);
    expect(m.groups.alwaysOn[0].policies).toEqual(["default-deny"]);
  });

  suite("pod console links", () => {
    it("links each pod to the Google Cloud console from a gcloud-style GKE context", () => {
      const m = describe(gkeCluster, gkeInfo, { context: "gke_my-proj_us-central1_my-cluster" });
      const run = m.groups.codingRuns[0];
      expect(run.console?.url).toBe(
        `https://console.cloud.google.com/kubernetes/pod/us-central1/my-cluster/${gkeInfo.kubernetes!.namespace}/${run.name}/details?project=my-proj`,
      );
    });

    it("has no link for a renamed context or a non-GKE platform", () => {
      expect(describe(gkeCluster, gkeInfo, { context: "prod" }).groups.alwaysOn[0].console).toBeNull();
      expect(describe(kindCluster, kindInfo, { context: "kind-dev" }).groups.alwaysOn[0].console).toBeNull();
    });
  });
});

suite("agent sandboxes", () => {
  it("groups sandbox run pods apart from coding runs, with the run's sha", () => {
    const m = describe(sandboxCluster, sandboxInfo);
    expect(m.groups.codingRuns).toEqual([]);
    expect(m.groups.agentSandboxes.map((p) => [p.name, p.group, p.runSha, p.warm])).toEqual([
      ["wardby-native-aaaa", "agent_sandbox", NATIVE_SHA, false],
    ]);
    expect(m.groups.agentSandboxes[0].runtime).toBe("gVisor");
    expect(m.groups.warmPool.map((p) => p.name)).toEqual(["wardby-nwarm-1111", "wardby-nwarm-2222"]);
    expect(m.agentSandbox).toEqual({ warmPoolSize: 2, elsewhere: null });
    expect(m.totals).toMatchObject({ pods: 3, agentSandboxes: 1 });
  });

  it("moves a claimed warm pod into the sandboxes, linked by run id", () => {
    const m = describe(sandboxCluster, sandboxInfo, { warmRuns: new Map([["wardby-nwarm-2222", "run-7"]]) });
    expect(m.groups.agentSandboxes.map((p) => [p.name, p.runId, p.warm])).toEqual([
      ["wardby-native-aaaa", null, false],
      ["wardby-nwarm-2222", "run-7", true],
    ]);
    expect(m.groups.warmPool.map((p) => p.name)).toEqual(["wardby-nwarm-1111"]);
  });

  it("says when sandboxes run in a namespace this view doesn't watch", () => {
    const info = {
      ...sandboxInfo,
      native: {
        ...sandboxInfo.native!,
        kubernetes: { ...sandboxInfo.native!.kubernetes!, namespace: "wardby-native" },
      },
    };
    expect(describe(clusterOf({}), info).agentSandbox).toEqual({ warmPoolSize: 2, elsewhere: "wardby-native" });
  });

  it("finds sandbox pods from an older server that doesn't describe them", () => {
    const m = describe(sandboxCluster, { ...gkeInfo, native: undefined } as unknown as typeof gkeInfo);
    expect(m.groups.agentSandboxes).toHaveLength(1);
    expect(m.agentSandbox).toEqual({ warmPoolSize: null, elsewhere: null });
  });

  it("has no sandbox section when there are none", () => {
    expect(describe(clusterOf({}), gkeInfo).agentSandbox).toBeNull();
  });
});
