import { describe as suite, expect, it } from "vitest";
import { describe, joinNatural, podsName } from "./adapter";
import { clusterOf, genericInfo, gkeInfo } from "./fixtures";
import type { InfraNetworkPolicy, PolicyPeer, PolicyPort, PolicyRule } from "./types";

const tcp = (...ns: number[]): PolicyPort[] => ns.map((port) => ({ port, protocol: "TCP" }));
const both = (n: number): PolicyPort[] => [
  { port: n, protocol: "UDP" },
  { port: n, protocol: "TCP" },
];
const pods = (labels: Record<string, string>, ns: Record<string, string> | null = null): PolicyPeer => ({
  kind: "pods",
  podLabels: labels,
  namespaceLabels: ns,
});
const ip = (cidr: string): PolicyPeer => ({ kind: "ip", cidr, except: [] });
const rule = (peers: PolicyPeer[], ports: PolicyPort[] = []): PolicyRule => ({ peers, ports });

const name = (x: string) => ({ "app.kubernetes.io/name": `wardby-${x}` });
const KUBE_DNS = pods({ "k8s-app": "kube-dns" }, { "kubernetes.io/metadata.name": "kube-system" });
const DNS = rule([KUBE_DNS], both(53));
const DB = rule([ip("10.23.0.3/32")], tcp(3307));
const METADATA = rule([ip("169.254.169.254/32"), ip("169.254.169.252/32")], tcp(80, 988));
const INTERNET = rule([ip("0.0.0.0/0")], tcp(443));

const netpol = (over: Partial<InfraNetworkPolicy>): InfraNetworkPolicy => ({
  name: "np",
  podSelector: {},
  policyTypes: ["Ingress", "Egress"],
  selectsAll: false,
  ingressRules: over.ingress?.length ?? 0,
  ingress: [],
  egressRules: [],
  egress: [],
  ...over,
});

const policies: InfraNetworkPolicy[] = [
  netpol({ name: "default-deny-all", selectsAll: true }),
  netpol({
    name: "wardby-coding-proxy",
    podSelector: name("coding-proxy"),
    ingress: [rule([pods({ "wardby.io/component": "coding-run" })], tcp(8787, 8788))],
    egressRules: [DNS, INTERNET],
  }),
  netpol({
    name: "wardby-coding-proxy-database",
    podSelector: name("coding-proxy"),
    policyTypes: ["Egress"],
    egressRules: [DB, METADATA],
  }),
  netpol({
    name: "wardby-coding-proxy-dns",
    podSelector: name("coding-proxy"),
    policyTypes: ["Egress"],
    egressRules: [rule([ip("169.254.20.10/32"), ip("169.254.169.254/32")], both(53)), DNS],
  }),
  netpol({
    name: "wardby-control-plane",
    podSelector: name("control-plane"),
    egressRules: [DNS, DB, METADATA, INTERNET],
  }),
  netpol({
    name: "wardby-control-plane-lb",
    podSelector: name("control-plane"),
    policyTypes: ["Ingress"],
    ingress: [rule([ip("130.211.0.0/22"), ip("35.191.0.0/16")], tcp(8080))],
  }),
  netpol({
    name: "wardby-migrate",
    podSelector: name("migrate"),
    egressRules: [DNS, DB, METADATA, INTERNET],
  }),
];

const intents = (list: InfraNetworkPolicy[], info = gkeInfo) =>
  Object.fromEntries(
    describe(clusterOf({ network_policy: list }), info).isolation.policies.list.map((p) => [p.name, p.intent]),
  );
const intentOf = (np: InfraNetworkPolicy, info = gkeInfo) => intents([np], info)[np.name];

suite("NetworkPolicy intent sentences", () => {
  it("phrases the GKE deployment's policies", () => {
    expect(intents(policies)).toEqual({
      "default-deny-all": "Blocks all traffic to and from every pod, unless another policy allows it.",
      "wardby-coding-proxy":
        "Only coding runs can connect to the coding proxy, on ports 8787 and 8788. The coding proxy can look up DNS names and reach the internet over HTTPS.",
      "wardby-coding-proxy-database":
        "The coding proxy can reach Cloud SQL (10.23.0.3:3307) and the GKE metadata server.",
      "wardby-coding-proxy-dns": "The coding proxy can look up DNS names.",
      "wardby-control-plane":
        "Nothing can connect to the control plane (other policies may allow it). The control plane can look up DNS names and reach Cloud SQL (10.23.0.3:3307), the GKE metadata server and the internet over HTTPS.",
      "wardby-control-plane-lb": "Only Google's load balancer can connect to the control plane, on port 8080.",
      "wardby-migrate":
        "Nothing can connect to migrations. Migrations can look up DNS names and reach Cloud SQL (10.23.0.3:3307), the GKE metadata server and the internet over HTTPS.",
    });
  });

  it("only mentions other policies when one allows that direction for the same pods", () => {
    const lone = netpol({ name: "cp", podSelector: name("control-plane"), egressRules: [DNS] });
    expect(intentOf(lone)).toMatch(/^Nothing can connect to the control plane\. /);
    const elsewhere = netpol({
      name: "other",
      podSelector: name("headroom"),
      policyTypes: ["Ingress"],
      ingress: [rule([{ kind: "any" }])],
    });
    expect(intents([lone, elsewhere]).cp).toMatch(/^Nothing can connect to the control plane\. /);
  });

  it("says a declared direction with no rules reaches nothing", () => {
    const np = netpol({ name: "x", podSelector: name("coding-proxy"), policyTypes: ["Egress"] });
    expect(intentOf(np)).toBe("The coding proxy can't reach anything.");
    const allowing = netpol({
      name: "y",
      podSelector: name("coding-proxy"),
      policyTypes: ["Egress"],
      egressRules: [DNS],
    });
    expect(intents([np, allowing]).x).toBe("The coding proxy can't reach anything (other policies may allow it).");
  });

  it("handles an empty-selector policy that blocks only one direction", () => {
    expect(intentOf(netpol({ name: "i", selectsAll: true, policyTypes: ["Ingress"] }))).toBe(
      "Blocks all incoming traffic to every pod, unless another policy allows it.",
    );
    expect(intentOf(netpol({ name: "e", selectsAll: true, policyTypes: ["Egress"] }))).toBe(
      "Blocks all outgoing traffic from every pod, unless another policy allows it.",
    );
  });

  it("defaults the declared directions when policyTypes is empty", () => {
    const np = netpol({ name: "d", podSelector: name("coding-proxy"), policyTypes: [], egressRules: [DNS] });
    expect(intentOf(np)).toBe("Nothing can connect to the coding proxy. The coding proxy can look up DNS names.");
  });

  it("renders anyone and any destination", () => {
    const np = netpol({
      name: "a",
      podSelector: name("control-plane"),
      ingress: [rule([{ kind: "any" }], tcp(8080))],
      egressRules: [rule([{ kind: "any" }])],
    });
    expect(intentOf(np)).toBe(
      "Anyone can connect to the control plane, on port 8080. The control plane can reach anywhere.",
    );
  });

  it("renders unrecognised peers literally", () => {
    const np = netpol({
      name: "l",
      podSelector: name("control-plane"),
      policyTypes: ["Egress"],
      egressRules: [
        rule([ip("10.1.2.3/32")], tcp(9000)),
        rule([{ kind: "ip", cidr: "10.2.0.0/16", except: ["10.2.1.0/24"] }]),
        rule([pods({ app: "db" }, { team: "data" })], [{ port: "pg", protocol: "TCP" }]),
      ],
    });
    expect(intentOf(np)).toBe(
      "The control plane can reach 10.1.2.3/32 on TCP 9000, 10.2.0.0/16 (except 10.2.1.0/24) and app=db in namespace team=data on TCP pg.",
    );
  });

  it("names other internet ports and any peer on port 53", () => {
    const np = netpol({
      name: "n",
      podSelector: name("headroom"),
      policyTypes: ["Egress"],
      egressRules: [
        rule([ip("0.0.0.0/0")], [...tcp(443), ...tcp(8443), { port: 123, protocol: "UDP" }]),
        rule([ip("1.1.1.1/32")], both(53)),
      ],
    });
    expect(intentOf(np)).toBe(
      "The headroom can look up DNS names and reach the internet over HTTPS and the internet on port 8443 and UDP port 123.",
    );
    expect(
      intentOf(
        netpol({
          name: "m",
          podSelector: name("headroom"),
          policyTypes: ["Egress"],
          egressRules: [rule([ip("0.0.0.0/0")])],
        }),
      ),
    ).toBe("The headroom can reach the internet.");
  });

  it("explains multi-rule ingress, with ports per source", () => {
    const np = netpol({
      name: "m",
      podSelector: name("control-plane"),
      policyTypes: ["Ingress"],
      ingress: [
        rule([pods({ "wardby.io/component": "coding-run" })], tcp(8080)),
        rule([pods({ app: "metrics" })], [{ port: 9090, protocol: "UDP" }]),
      ],
    });
    expect(intentOf(np)).toBe(
      "Only coding runs (on port 8080) and app=metrics (on UDP port 9090) can connect to the control plane.",
    );
  });

  it("does not use cloud-specific names off GKE", () => {
    const sentences = intents(policies, genericInfo);
    expect(sentences["wardby-control-plane-lb"]).toBe(
      "Only 130.211.0.0/22 and 35.191.0.0/16 can connect to the control plane, on port 8080.",
    );
    expect(sentences["wardby-coding-proxy-database"]).toBe(
      "The coding proxy can reach 10.23.0.3/32 on TCP 3307 and 169.254.169.254/32 and 169.254.169.252/32 on TCP 80 and 988.",
    );
    expect(sentences["wardby-coding-proxy-dns"]).toBe("The coding proxy can look up DNS names.");
  });
});

suite("phrasing helpers", () => {
  it("joins in natural English and dedupes", () => {
    expect(joinNatural([])).toBe("");
    expect(joinNatural(["a"])).toBe("a");
    expect(joinNatural(["a", "b", "a"])).toBe("a and b");
    expect(joinNatural(["a", "b", "c"])).toBe("a, b and c");
  });

  it("names pods from their selector", () => {
    expect(podsName({})).toBe("every pod");
    expect(podsName(name("coding-proxy"))).toBe("the coding proxy");
    expect(podsName({ "wardby.io/component": "coding-run" })).toBe("coding runs");
    expect(podsName({ "wardby.io/component": "native-run" })).toBe("agent sandboxes");
    expect(podsName({ "wardby.io/component": "native-run", "wardby.io/pool": "warm" })).toBe("the warm pool");
    expect(podsName({ "wardby.io/component": "other" })).toBe("wardby.io/component=other");
    expect(podsName({ app: "x", tier: "y" })).toBe("app=x, tier=y");
  });
});
