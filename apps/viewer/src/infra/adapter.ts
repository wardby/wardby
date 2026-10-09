import type { InfraInfo } from "../api/types";
import type {
  ClusterKind,
  ClusterState,
  InfraBackendPolicy,
  InfraContainer,
  InfraEdge,
  InfraNetworkPolicy,
  InfraPod,
  InfraSecretStore,
  InfraServiceAccount,
  KindItem,
  PolicyPeer,
  PolicyPort,
  PolicyRule,
} from "./types";

/** Like kubectl's READY: one-shot init containers are setup steps, not part of the count. */
export function countsTowardReady(c: { role: string }): boolean {
  return c.role !== "init";
}

export type Platform = "gke" | "eks" | "kind" | "generic";

export interface DescribeOpts {
  serverUrl?: string;
  context?: string | null;
  /** Warm pool workers runs have claimed: worker (pod) name -> run id, from the runs' `warmWorkerName`. */
  warmRuns?: ReadonlyMap<string, string>;
}
export interface EdgeView {
  label: string;
  detail: string[];
  hosts: string[];
  /** Where it sits on the request path: the public entry (Gateway, Ingress, LB) or a route behind it. */
  role?: "entry" | "route";
  /** A redirect-only route's effect, shown on the entry instead of as a path step. */
  redirect?: string;
  /** A protection layer in front of the backends (GKE: Cloud Armor); becomes its own path step. */
  protection?: { label: string; names: string[] };
}
export interface PodView {
  name: string;
  group: "always_on" | "coding_run" | "agent_sandbox" | "job";
  title: string;
  /** What to show for the pod: Terminating, Completed, a container problem, or its phase. */
  status: string;
  phase: string;
  terminating: boolean;
  ready: boolean;
  /** Runtime class label; for a coding run without a sandbox, "none (container runtime)". */
  runtime: string | null;
  /** The pod runs in a sandbox runtime class (gVisor, Kata, ...). */
  sandboxed: boolean;
  node: string | null;
  identity: string | null;
  containers: InfraContainer[];
  runSha: string | null;
  /** The run, when known directly: a warm pool pod a run claimed carries no run label. */
  runId: string | null;
  /** A native-agent warm pool pod (idle until a run claims it). */
  warm: boolean;
  /** The pod's page in the cloud console, when the platform has one. */
  console: { url: string; label: string } | null;
  /** Egress rules of the NetworkPolicies that select this pod. */
  egress: string[];
  /** Names of the NetworkPolicies that select this pod. */
  policies: string[];
  /** What each of those policies means, in plain English. */
  policyIntents: { name: string; intent: string }[];
  requests: { cpuMillis: number; memoryMiB: number };
  startedAt: string | null;
}
export interface PolicyView {
  name: string;
  /** "all pods" or the pod selector as k=v pairs. */
  selects: string;
  /** e.g. "denies all", "ingress: 2 rules", "egress: <rule>, …". */
  rules: string[];
  /** Plain-English sentences saying what the policy allows or blocks. */
  intent: string;
}
export interface DataStoreView {
  label: string;
  detail: string[];
}
export interface InfraModel {
  platform: Platform;
  controlPlane: { inCluster: true } | { inCluster: false; location: string | null };
  edge: EdgeView[];
  groups: {
    alwaysOn: PodView[];
    codingRuns: PodView[];
    /** Sandbox-mode native agent runs, including warm pool pods a run has claimed. */
    agentSandboxes: PodView[];
    /** Idle warm pool pods. */
    warmPool: PodView[];
    jobs: PodView[];
  };
  /** Sandbox-mode native agents; null when the server runs none on Kubernetes. */
  agentSandbox: {
    /** Configured warm pool size; null when the server doesn't say. */
    warmPoolSize: number | null;
    /** The namespace sandboxes run in, when it isn't the one this view watches. */
    elsewhere: string | null;
  } | null;
  isolation: {
    egressRules: string[];
    sandbox: string | null;
    /** Every NetworkPolicy in the namespace; `defaultDeny` when one selects all pods and allows nothing. */
    policies: { count: number; defaultDeny: boolean; list: PolicyView[] };
  };
  dataStores: DataStoreView[];
  /** `names` is null when they can't be read; `forbidden` says that is for lack of access. */
  secrets: { source: string | null; names: string[] | null; forbidden: boolean };
  totals: {
    pods: number;
    codingRuns: number;
    agentSandboxes: number;
    readyContainers: number;
    cpuMillis: number;
    memoryMiB: number;
  };
}

/** Kubernetes CPU quantity ("500m", "2", "0.5") to millicores. */
export function parseCpu(q: string | null | undefined): number {
  if (!q) return 0;
  const m = /^([0-9.]+)(m?)$/.exec(q.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.round(m[2] ? n : n * 1000) : 0;
}

const MEM_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  "": 1,
};

/** Kubernetes memory quantity ("512Mi", "4Gi", "1G", bytes) to MiB. */
export function parseMemory(q: string | null | undefined): number {
  if (!q) return 0;
  const m = /^([0-9.]+)([KMGT]i?)?$/.exec(q.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? (n * MEM_UNITS[m[2] ?? ""]) / 1024 ** 2 : 0;
}

interface EdgeContext {
  backendPolicies: InfraBackendPolicy[];
}

interface PlatformRules {
  edge(e: InfraEdge, ctx: EdgeContext): EdgeView;
  identity(sa: InfraServiceAccount | null): string | null;
  database(alwaysOn: PodView[]): DataStoreView;
  secrets(stores: InfraSecretStore[]): string | null;
  sandbox(runtimeClass: string | null): string | null;
  /** A link to the pod in the provider's console; `context` is the kube context name. */
  podConsole(context: string | null | undefined, namespace: string, pod: string): { url: string; label: string } | null;
  /** A provider-specific name for a peer ("Google's load balancer"), or null to fall back to the literal address. */
  namedPeer(peer: PolicyPeer, ports: PolicyPort[]): string | null;
}

/** gcloud names GKE contexts `gke_<project>_<location>_<cluster>` (none of the parts contain `_`). */
const GKE_CONTEXT = /^gke_([^_]+)_([^_]+)_([^_]+)$/;

function gkePodConsole(context: string | null | undefined, namespace: string, pod: string) {
  const m = context ? GKE_CONTEXT.exec(context) : null;
  if (!m || !namespace) return null;
  const [, project, location, cluster] = m.map(encodeURIComponent);
  const path = [location, cluster, encodeURIComponent(namespace), encodeURIComponent(pod)].join("/");
  return {
    url: `https://console.cloud.google.com/kubernetes/pod/${path}/details?project=${project}`,
    label: "Open in Google Cloud console",
  };
}

const GENERIC_EDGE_LABELS: Record<string, string> = {
  ingress: "Ingress",
  gateway: "Gateway",
  httproute: "HTTPRoute",
  http_route: "HTTPRoute",
  loadbalancer: "Load Balancer",
};

const isRoute = (e: InfraEdge) => e.kind === "httproute" || e.kind === "http_route";

/** A route's detail: its hostnames, or what a redirect-only route does. */
function routeDetail(e: InfraEdge): string[] {
  if (e.redirectOnly) return [e.redirectScheme === "https" ? "HTTP → HTTPS redirect" : "Redirect"];
  return e.hosts.length ? [e.hosts.join(", ")] : [];
}

const genericEdge = (e: InfraEdge): EdgeView => ({
  label: GENERIC_EDGE_LABELS[e.kind] ?? e.kind,
  detail: isRoute(e) && !e.redirectOnly ? routeDetail(e) : [],
  hosts: e.hosts,
  role: isRoute(e) ? "route" : "entry",
  ...(isRoute(e) && e.redirectOnly ? { redirect: routeDetail(e)[0] } : {}),
});

/**
 * Orders the edge views as the request travels: entries, then each protection layer as its
 * own step, then the routes into the namespace. Redirect-only routes become a note on the entry.
 */
function edgePath(views: EdgeView[]): EdgeView[] {
  const strip = (v: EdgeView): EdgeView => {
    const copy = { ...v };
    delete copy.protection;
    delete copy.redirect;
    return copy;
  };
  const redirects = [...new Set(views.flatMap((v) => (v.redirect ? [v.redirect] : [])))];
  const entries = views.filter((v) => v.role === "entry").map(strip);
  if (entries.length) entries[0] = { ...entries[0], detail: [...entries[0].detail, ...redirects] };
  const layers = new Map<string, Set<string>>();
  for (const v of views) {
    if (!v.protection) continue;
    const names = layers.get(v.protection.label) ?? new Set<string>();
    v.protection.names.forEach((n) => names.add(n));
    layers.set(v.protection.label, names);
  }
  const protection = [...layers].map(([label, names]): EdgeView => ({ label, detail: [...names], hosts: [] }));
  const routes = views.filter((v) => v.role !== "entry" && !v.redirect).map(strip);
  const orphanRedirects = entries.length
    ? []
    : views.filter((v) => v.redirect).map((v) => ({ ...strip(v), detail: [v.redirect!] }));
  return [...entries, ...protection, ...routes, ...orphanRedirects];
}

/** Cloud Armor policy names a GCPBackendPolicy attaches to a Gateway or to the Services a route sends traffic to. */
function armorPolicies(e: InfraEdge, ctx: EdgeContext): string[] {
  const names = ctx.backendPolicies.flatMap((p) => {
    if (!p.securityPolicy || !p.targetName) return [];
    if (e.kind === "gateway" && p.targetKind === "Gateway" && p.targetName === e.name) return [p.securityPolicy];
    if (isRoute(e) && p.targetKind === "Service" && e.backends.includes(p.targetName)) return [p.securityPolicy];
    return [];
  });
  return [...new Set(names)];
}

const genericDatabase = (): DataStoreView => ({ label: "Postgres (external)", detail: [] });

const gkeEdge = (e: InfraEdge, ctx: EdgeContext): EdgeView => {
  const named = armorPolicies(e, ctx);
  const armorAnnotation =
    e.kind === "gateway" &&
    Object.entries(e.annotations).some(
      ([k, v]) =>
        (k.startsWith("networking.gke.io/") || k.startsWith("cloud.google.com/")) &&
        /armor|security[-_ ]?policy/i.test(`${k} ${v}`),
    );
  const protection = named.length || armorAnnotation ? { protection: { label: "Cloud Armor", names: named } } : {};
  if (e.kind !== "gateway") return { ...genericEdge(e), ...protection };
  return { label: "Gateway", detail: e.hosts.length ? ["TLS"] : [], hosts: e.hosts, role: "entry", ...protection };
};

const gkeIdentity = (sa: InfraServiceAccount | null): string | null => {
  if (!sa) return null;
  const gsa = sa.identity["iam.gke.io/gcp-service-account"];
  return gsa ? `GSA ${gsa}` : `SA ${sa.name}`;
};

const gkeDatabase = (alwaysOn: PodView[]): DataStoreView =>
  alwaysOn.some((p) => p.containers.some((c) => c.image.includes("cloud-sql-proxy")))
    ? { label: "Cloud SQL", detail: ["via Auth Proxy", "IAM login"] }
    : genericDatabase();

const GKE_LOAD_BALANCER_RANGES = ["130.211.0.0/22", "35.191.0.0/16"];
const GKE_METADATA_IPS = ["169.254.169.254", "169.254.169.252"];
const GKE_NODE_LOCAL_DNS = "169.254.20.10";
const CLOUD_SQL_PROXY_PORT = 3307;

/** The address of a single-host CIDR (a /32 or a bare IP), else null. */
function singleHost(cidr: string): string | null {
  const [ip, bits] = cidr.split("/");
  return bits === undefined || bits === "32" ? ip : null;
}

function gkeNamedPeer(peer: PolicyPeer, ports: PolicyPort[]): string | null {
  if (peer.kind !== "ip") return null;
  if (GKE_LOAD_BALANCER_RANGES.includes(peer.cidr)) return "Google's load balancer";
  const host = singleHost(peer.cidr);
  if (!host) return null;
  if (GKE_METADATA_IPS.includes(host)) return "the GKE metadata server";
  if (host === GKE_NODE_LOCAL_DNS) return DNS_PHRASE;
  if (ports.some((p) => p.port === CLOUD_SQL_PROXY_PORT)) return `Cloud SQL (${host}:${CLOUD_SQL_PROXY_PORT})`;
  return null;
}

const GENERIC_RULES: PlatformRules = {
  edge: genericEdge,
  identity: (sa) => (sa ? `SA ${sa.name}` : null),
  database: genericDatabase,
  secrets: (stores) => (stores.length ? "External Secrets" : null),
  sandbox: (rc) => rc,
  podConsole: () => null,
  namedPeer: () => null,
};

const RULES: Record<Platform, PlatformRules> = {
  generic: GENERIC_RULES,
  gke: {
    edge: gkeEdge,
    identity: gkeIdentity,
    database: gkeDatabase,
    secrets: (stores) =>
      stores.some((s) => s.provider === "gcpsm") ? "Secret Manager" : stores.length ? "External Secrets" : null,
    sandbox: (rc) => rc,
    podConsole: gkePodConsole,
    namedPeer: gkeNamedPeer,
  },
  kind: { ...GENERIC_RULES, sandbox: (rc) => rc ?? "none (container runtime)" },
  // PR 3 adds EKS; platformOf never returns it until then.
  eks: undefined as never,
};

const KIND_NODE = /^(.+)-(control-plane|worker\d*)$/;

/** kind names every node `<cluster>-control-plane` / `<cluster>-worker[N]`, all with one cluster prefix. */
function looksLikeKindNodes(cluster: ClusterState): boolean {
  const nodes = new Set<string>();
  for (const p of cluster.objects.pod.values()) if (p.node) nodes.add(p.node);
  const prefixes = new Set<string>();
  let control = false;
  for (const n of nodes) {
    const m = KIND_NODE.exec(n);
    if (!m) return false;
    prefixes.add(m[1]);
    if (m[2] === "control-plane") control = true;
  }
  return control && prefixes.size === 1;
}

export function platformOf(info: InfraInfo, cluster: ClusterState, opts: DescribeOpts = {}): Platform {
  // The server reports "generic" or "gke-autopilot"; other GKE (Standard) is detected only via the SA fallback below.
  if (info.kubernetes?.platform.startsWith("gke")) return "gke";
  for (const sa of cluster.objects.service_account.values()) {
    if ("iam.gke.io/gcp-service-account" in sa.identity) return "gke";
  }
  if (info.kubernetes?.platform !== "generic") return "generic";
  if (opts.context?.startsWith("kind-")) return "kind";
  return looksLikeKindNodes(cluster) ? "kind" : "generic";
}

function hostPort(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

const ALWAYS_ON: [prefix: string, title: string][] = [
  ["wardby-control-plane", "control-plane"],
  ["wardby-coding-proxy", "coding-proxy"],
  ["wardby-headroom", "headroom"],
];

const values = <K extends ClusterKind>(c: ClusterState, k: K): KindItem<K>[] => [...c.objects[k].values()];

function runtimeName(rc: string | null): string | null {
  if (!rc) return null;
  const l = rc.toLowerCase();
  if (l.includes("gvisor") || l === "runsc") return "gVisor";
  if (l.includes("kata")) return "Kata";
  return rc;
}

function podStatus(p: InfraPod): string {
  if (p.terminating) return "Terminating";
  if (p.phase === "Succeeded") return "Completed";
  const bad = p.containers.find((c) => !c.ready && c.reason && c.state !== "terminated");
  return bad?.reason ?? p.phase;
}

function matches(selector: Record<string, string | undefined>, labels: Record<string, string>): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([k, v]) => labels[k] === v);
}

const selects = (np: InfraNetworkPolicy, labels: Record<string, string>) =>
  np.selectsAll || matches(np.podSelector, labels);

/** An empty-selector policy that allows nothing for each direction it declares. */
function deniesAll(np: InfraNetworkPolicy): boolean {
  if (!np.selectsAll) return false;
  const types = np.policyTypes.length ? np.policyTypes : ["Ingress", ...(np.egress.length ? ["Egress"] : [])];
  return types.every((t) => (t === "Ingress" ? np.ingressRules === 0 : t === "Egress" ? np.egress.length === 0 : true));
}

// ---- NetworkPolicy intent sentences -------------------------------------------------------------

const DNS_PHRASE = "look up DNS names";
const INTERNET_CIDRS = ["0.0.0.0/0", "::/0"];

/** "A", "A and B", "A, B and C". */
export function joinNatural(items: string[]): string {
  const xs = [...new Set(items)];
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Names the pods a label set picks out: "the coding proxy", "coding runs", "every pod", else k=v text. */
export function podsName(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "every pod";
  if (entries.length === 1) {
    const [k, v] = entries[0];
    // The migrate Job's pods read better as what they are.
    if (k === "app.kubernetes.io/name" && v === "wardby-migrate") return "migrations";
    if (k === "app.kubernetes.io/name" && v.startsWith("wardby-") && v.length > "wardby-".length)
      return `the ${v.slice("wardby-".length).replace(/-/g, " ")}`;
    if (k === "wardby.io/component" && v === "coding-run") return "coding runs";
    if (k === "wardby.io/component" && v === "native-run") return "agent sandboxes";
  }
  if (entries.length === 2 && labels["wardby.io/component"] === "native-run" && labels["wardby.io/pool"] === "warm")
    return "the warm pool";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

const isKubeDns = (labels: Record<string, string>) =>
  Object.keys(labels).length === 1 && labels["k8s-app"] === "kube-dns";

function namespaceName(labels: Record<string, string>): string {
  const only = Object.entries(labels);
  if (only.length === 1 && only[0][0] === "kubernetes.io/metadata.name") return only[0][1];
  return only.map(([k, v]) => `${k}=${v}`).join(", ");
}

const isPort = (p: PolicyPort, n: number, protocol = "TCP") => p.port === n && p.protocol === protocol;

/** "port 8787", "ports 8787 and 8788", "UDP port 53"; empty list is "" (every port). */
function portsText(ports: PolicyPort[]): string {
  const byProtocol = new Map<string, (number | string)[]>();
  const anyPort: string[] = [];
  for (const p of ports) {
    if (p.port === null) anyPort.push(p.protocol);
    else byProtocol.set(p.protocol, [...(byProtocol.get(p.protocol) ?? []), p.port]);
  }
  const parts = [...byProtocol].map(([protocol, nums]) => {
    const prefix = protocol === "TCP" ? "" : `${protocol} `;
    return `${prefix}port${nums.length === 1 ? "" : "s"} ${joinNatural(nums.map(String))}`;
  });
  for (const protocol of anyPort) parts.push(protocol === "TCP" ? "any port" : `any ${protocol} port`);
  return joinNatural(parts);
}

/** The literal form: "TCP 9000", "TCP 80 and 443", "UDP 53". */
function portsLiteral(ports: PolicyPort[]): string {
  const byProtocol = new Map<string, string[]>();
  for (const p of ports) byProtocol.set(p.protocol, [...(byProtocol.get(p.protocol) ?? []), String(p.port ?? "any")]);
  return joinNatural([...byProtocol].map(([protocol, nums]) => `${protocol} ${joinNatural(nums)}`));
}

function peerLiteral(peer: PolicyPeer, anyText: string): string {
  if (peer.kind === "any") return anyText;
  if (peer.kind === "ip") return peer.except.length ? `${peer.cidr} (except ${peer.except.join(", ")})` : peer.cidr;
  const pods = podsName(peer.podLabels);
  if (!peer.namespaceLabels) return pods;
  return `${pods} in namespace ${namespaceName(peer.namespaceLabels)}`;
}

function ingressClause(rule: PolicyRule, rules: PlatformRules): { peers: string; ports: string } {
  const peers = rule.peers.map((p) =>
    p.kind === "any" ? "anyone" : (rules.namedPeer(p, rule.ports) ?? peerLiteral(p, "anyone")),
  );
  return { peers: peers.includes("anyone") ? "anyone" : joinNatural(peers), ports: portsText(rule.ports) };
}

function ingressSentence(subject: string, ingress: PolicyRule[], rules: PlatformRules): string {
  const clauses = ingress.map((r) => ingressClause(r, rules));
  const anyone = clauses.some((c) => c.peers === "anyone");
  if (clauses.length === 1) {
    const [c] = clauses;
    return `${anyone ? "Anyone" : `Only ${c.peers}`} can connect to ${subject}${c.ports ? `, on ${c.ports}` : ""}.`;
  }
  const list = joinNatural(clauses.map((c) => (c.ports ? `${c.peers} (on ${c.ports})` : c.peers)));
  return `${anyone ? capitalize(list) : `Only ${list}`} can connect to ${subject}.`;
}

/** The "reach ..." noun phrases for one egress rule, plus whether it is a DNS lookup. */
function egressPhrases(rule: PolicyRule, rules: PlatformRules): { dns: boolean; reach: string[] } {
  if (rule.ports.some((p) => p.port === 53)) return { dns: true, reach: [] };
  let dns = false;
  const reach: string[] = [];
  const literals: string[] = [];
  for (const peer of rule.peers) {
    const named = rules.namedPeer(peer, rule.ports);
    if (named === DNS_PHRASE || (peer.kind === "pods" && isKubeDns(peer.podLabels))) {
      dns = true;
    } else if (named) {
      reach.push(named);
    } else if (peer.kind === "ip" && INTERNET_CIDRS.includes(peer.cidr)) {
      const others = rule.ports.filter((p) => !isPort(p, 443));
      if (rule.ports.length === 0) reach.push("the internet");
      if (rule.ports.length > others.length) reach.push("the internet over HTTPS");
      if (others.length) reach.push(`the internet on ${portsText(others)}`);
    } else {
      literals.push(peerLiteral(peer, "anywhere"));
    }
  }
  const ports = portsLiteral(rule.ports);
  if (literals.length) reach.push(`${joinNatural(literals)}${ports ? ` on ${ports}` : ""}`);
  return { dns, reach };
}

function egressSentence(subject: string, egress: PolicyRule[], rules: PlatformRules): string {
  const phrases = egress.map((r) => egressPhrases(r, rules));
  const verbs: string[] = [];
  if (phrases.some((p) => p.dns)) verbs.push(DNS_PHRASE);
  const reach = [...new Set(phrases.flatMap((p) => p.reach))];
  if (reach.length) verbs.push(`reach ${joinNatural(reach)}`);
  return `${capitalize(subject)} can ${joinNatural(verbs)}.`;
}

/** Two selectors can pick the same pod unless some label key has different values in each. */
function mayOverlap(a: InfraNetworkPolicy, b: InfraNetworkPolicy): boolean {
  if (a.selectsAll || b.selectsAll) return true;
  return Object.entries(a.podSelector).every(([k, v]) => b.podSelector[k] === undefined || b.podSelector[k] === v);
}

/** The directions a policy declares; Kubernetes defaults to Ingress, plus Egress when it has egress rules. */
function declaredTypes(np: InfraNetworkPolicy): string[] {
  return np.policyTypes.length ? np.policyTypes : ["Ingress", ...(np.egressRules.length ? ["Egress"] : [])];
}

/** Plain-English sentences for what a NetworkPolicy allows or blocks. Deterministic; unknown peers stay literal. */
export function policyIntent(np: InfraNetworkPolicy, all: InfraNetworkPolicy[], rules: PlatformRules): string {
  const types = declaredTypes(np);
  const ingress = types.includes("Ingress");
  const egress = types.includes("Egress");
  const emptyLabels = Object.keys(np.podSelector).length === 0;
  const subject = np.selectsAll ? "every pod" : emptyLabels ? "the selected pods" : podsName(np.podSelector);
  const allowedElsewhere = (dir: "ingress" | "egress") =>
    all.some(
      (o) =>
        o !== np &&
        mayOverlap(np, o) &&
        declaredTypes(o).includes(dir === "ingress" ? "Ingress" : "Egress") &&
        (dir === "ingress" ? o.ingress : o.egressRules).length > 0,
    );
  const sentences: string[] = [];
  if (np.selectsAll && ingress && egress && np.ingress.length === 0 && np.egressRules.length === 0)
    return "Blocks all traffic to and from every pod, unless another policy allows it.";
  if (ingress) {
    if (np.ingress.length) sentences.push(ingressSentence(subject, np.ingress, rules));
    else if (np.selectsAll)
      sentences.push("Blocks all incoming traffic to every pod, unless another policy allows it.");
    else
      sentences.push(
        `Nothing can connect to ${subject}${allowedElsewhere("ingress") ? " (other policies may allow it)" : ""}.`,
      );
  }
  if (egress) {
    if (np.egressRules.length) sentences.push(egressSentence(subject, np.egressRules, rules));
    else if (np.selectsAll)
      sentences.push("Blocks all outgoing traffic from every pod, unless another policy allows it.");
    else
      sentences.push(
        `${capitalize(subject)} can't reach anything${allowedElsewhere("egress") ? " (other policies may allow it)" : ""}.`,
      );
  }
  return sentences.join(" ");
}

function policyView(np: InfraNetworkPolicy, all: InfraNetworkPolicy[], rules: PlatformRules): PolicyView {
  const selects = np.selectsAll
    ? "all pods"
    : Object.entries(np.podSelector)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "all pods";
  const summary: string[] = [];
  if (deniesAll(np)) summary.push("denies all");
  else {
    if (np.policyTypes.includes("Ingress"))
      summary.push(
        np.ingressRules === 0 ? "ingress: none" : `ingress: ${np.ingressRules} rule${np.ingressRules === 1 ? "" : "s"}`,
      );
    if (np.policyTypes.includes("Egress"))
      summary.push(np.egress.length ? `egress: ${np.egress.join(", ")}` : "egress: none");
  }
  return { name: np.name, selects, rules: summary, intent: policyIntent(np, all, rules) };
}

/** The labels on native sandbox pods; servers from before /admin/api/infra described them use the same ones. */
function nativeLabels(info: InfraInfo) {
  const k = info.native?.kubernetes;
  return {
    componentLabel: k?.componentLabel ?? { "wardby.io/component": "native-run" },
    warmPoolLabel: k?.warmPoolLabel ?? { "wardby.io/pool": "warm" },
    runLabel: k?.runLabel ?? "wardby.io/run-sha256",
  };
}

export function describe(cluster: ClusterState, info: InfraInfo, opts: DescribeOpts = {}): InfraModel {
  const platform = platformOf(info, cluster, opts);
  const rules = RULES[platform];
  const k8s = info.kubernetes;
  const componentLabel = k8s?.componentLabel ?? {};
  const native = nativeLabels(info);
  const sas = cluster.objects.service_account;
  const policies = values(cluster, "network_policy");
  const unique = (rules: string[]) => [...new Set(rules)];

  const view = (p: InfraPod, group: PodView["group"], title: string): PodView => {
    const sa = p.serviceAccount ? (sas.get(p.serviceAccount) ?? { name: p.serviceAccount, identity: {} }) : null;
    const main = p.containers.filter((c) => c.role !== "init");
    return {
      name: p.name,
      group,
      title,
      status: podStatus(p),
      phase: p.phase,
      terminating: p.terminating,
      ready: p.ready,
      runtime:
        group === "coding_run" || group === "agent_sandbox"
          ? rules.sandbox(runtimeName(p.runtimeClass))
          : runtimeName(p.runtimeClass),
      sandboxed: p.runtimeClass !== null,
      node: p.node,
      identity: rules.identity(sa),
      containers: p.containers,
      runSha:
        group === "coding_run" && k8s
          ? (p.labels[k8s.runLabel] ?? null)
          : group === "agent_sandbox"
            ? (p.labels[native.runLabel] ?? null)
            : null,
      runId: group === "agent_sandbox" ? (opts.warmRuns?.get(p.name) ?? null) : null,
      warm: group === "agent_sandbox" && matches(native.warmPoolLabel, p.labels),
      console: rules.podConsole(opts.context, k8s?.namespace ?? "", p.name),
      egress: unique(policies.filter((np) => selects(np, p.labels)).flatMap((np) => np.egress)),
      policies: policies.filter((np) => selects(np, p.labels)).map((np) => np.name),
      policyIntents: policies
        .filter((np) => selects(np, p.labels))
        .map((np) => ({ name: np.name, intent: policyIntent(np, policies, rules) })),
      requests: {
        cpuMillis: main.reduce((s, c) => s + parseCpu(c.requests.cpu), 0),
        memoryMiB: Math.round(main.reduce((s, c) => s + parseMemory(c.requests.memory), 0)),
      },
      startedAt: p.startedAt,
    };
  };

  const alwaysOn: PodView[] = [];
  const codingRuns: PodView[] = [];
  const agentSandboxes: PodView[] = [];
  const warmPool: PodView[] = [];
  const jobs: PodView[] = [];
  for (const p of values(cluster, "pod")) {
    if (matches(componentLabel, p.labels)) {
      codingRuns.push(view(p, "coding_run", p.name));
      continue;
    }
    if (matches(native.componentLabel, p.labels)) {
      const v = view(p, "agent_sandbox", p.name);
      (v.warm && !v.runId ? warmPool : agentSandboxes).push(v);
      continue;
    }
    const ownerName = p.owner?.name ?? p.name;
    const hit = ALWAYS_ON.find(([prefix]) => ownerName === prefix || ownerName.startsWith(`${prefix}-`));
    if (hit) alwaysOn.push(view(p, "always_on", hit[1]));
    else if (p.owner?.kind === "Job") jobs.push(view(p, "job", p.owner.name));
  }
  const order = (p: PodView) => ALWAYS_ON.findIndex(([, t]) => t === p.title);
  alwaysOn.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  codingRuns.sort((a, b) => a.name.localeCompare(b.name));
  agentSandboxes.sort((a, b) => a.name.localeCompare(b.name));
  warmPool.sort((a, b) => a.name.localeCompare(b.name));
  jobs.sort((a, b) => a.name.localeCompare(b.name));

  const edges: InfraEdge[] = [
    ...values(cluster, "ingress"),
    ...values(cluster, "gateway"),
    ...values(cluster, "http_route"),
    ...values(cluster, "service").flatMap((s) => (s.edge ? [s.edge] : [])),
  ];

  // The server writes one policy per run, so the same rules repeat across them.
  const egressRules = unique(
    policies
      .filter((np) => matches(componentLabel, np.podSelector as Record<string, string>))
      .flatMap((np) => np.egress),
  );

  const stores = values(cluster, "secret_store");
  const secretError = cluster.kindErrors.secret;
  const forbidden = secretError?.kind === "forbidden";
  const all = [...alwaysOn, ...codingRuns, ...agentSandboxes, ...warmPool, ...jobs];
  const nativeK8s = info.native?.kubernetes ?? null;

  return {
    platform,
    controlPlane:
      alwaysOn.some((p) => p.title === "control-plane") || !cluster.podsSynced // unknown until the pod snapshot arrives
        ? { inCluster: true }
        : { inCluster: false, location: hostPort(opts.serverUrl) },
    edge: edgePath(edges.map((e) => rules.edge(e, { backendPolicies: values(cluster, "backend_policy") }))),
    groups: { alwaysOn, codingRuns, agentSandboxes, warmPool, jobs },
    // Older servers don't describe sandboxes; their pods still show when present.
    agentSandbox:
      nativeK8s || agentSandboxes.length > 0 || warmPool.length > 0
        ? {
            warmPoolSize: info.native ? info.native.warmPoolSize : null,
            elsewhere: nativeK8s && k8s && nativeK8s.namespace !== k8s.namespace ? nativeK8s.namespace : null,
          }
        : null,
    isolation: {
      egressRules,
      sandbox: rules.sandbox(runtimeName(k8s?.runtimeClass ?? null)),
      policies: {
        count: policies.length,
        defaultDeny: policies.some(deniesAll),
        list: policies.map((np) => policyView(np, policies, rules)),
      },
    },
    dataStores: [rules.database(alwaysOn)],
    secrets: {
      source: rules.secrets(stores),
      names: secretError ? null : values(cluster, "secret").map((s) => s.name),
      forbidden,
    },
    totals: {
      pods: all.length,
      codingRuns: codingRuns.length,
      agentSandboxes: agentSandboxes.length,
      readyContainers: all.reduce((s, p) => s + p.containers.filter((c) => c.ready && countsTowardReady(c)).length, 0),
      cpuMillis: all.reduce((s, p) => s + p.requests.cpuMillis, 0),
      memoryMiB: all.reduce((s, p) => s + p.requests.memoryMiB, 0),
    },
  };
}
