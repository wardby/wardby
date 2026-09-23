/**
 * The proxy Service as the NetworkPolicy enforcement witness.
 *
 * The preflight canary and the per-launch gate both prove a run's policy is
 * enforced by requiring a connect to the proxy's deny port to be *refused*
 * while a connect to the proxy port succeeds. This read is the configuration
 * cross-check for that: the Service must expose both ports, and at least one
 * ready endpoint must serve both, or the deployment is misconfigured and says
 * so by name rather than failing later at a gate.
 *
 * This is a control-plane cross-check only: it does not itself keep a probe
 * from being vacuous. That is what the two-port probe (measured in one exec,
 * at the instant of the blocked observation) proves; see kubernetes.ts.
 *
 * It also checks the one thing the probe cannot observe about itself: WHO
 * dropped the packet. A timeout on the deny port proves the SYN was dropped
 * somewhere on the path, not that the run pod's own egress policy dropped it.
 * The attribution follows from the proxy's own NetworkPolicy admitting run
 * pods on the deny port at its ingress — because ingress is enforced at the
 * destination, a proxy policy that did NOT admit 8788 would drop the packet
 * there and every run would read "blocked" with no egress policy at all. That
 * was falsified on a live cluster: a proxy policy admitting 8787 only made a
 * prober with no policy and full internet egress read PROVEN. The rule was
 * asserted by manifest and checked nowhere, so one deleted line in an overlay
 * silently voided the gate. It is verified here instead.
 *
 * Both reads are in wardby's own namespace, which the launcher Role permits.
 * (EndpointSlice is the durable successor to the core/v1 Endpoints read here;
 * migrating is a follow-up and needs its own resourceNames grant.)
 */
import { isIP } from "node:net";
import type { V1NetworkPolicyIngressRule, V1NetworkPolicyPeer } from "@kubernetes/client-node";
import { CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "./docker-isolation.js";
import type { KubernetesApi } from "./kubernetes-api.js";
import { PROXY_POD_LABEL, RUN_COMPONENT_LABEL } from "./kubernetes-isolation.js";

export const PROXY_WITNESS_UNUSABLE = "kubernetes_proxy_witness_unusable";

export class ProxyWitnessError extends Error {
  constructor(detail: string) {
    super(`${PROXY_WITNESS_UNUSABLE}: ${detail}`);
    this.name = "ProxyWitnessError";
  }
}

export interface ProxyWitness {
  /** The proxy Service's ClusterIP: the address both probed ports live on. */
  clusterIp: string;
}

const REQUIRED_PORTS = [CODING_PROXY_PORT, CODING_PROXY_DENY_PORT] as const;

/** core/v1 defaults an omitted port protocol to TCP; only count a port toward either
 * required-port check when it is TCP (or silent on protocol), so a UDP/SCTP declaration
 * of 8788 can never satisfy a check that exists to prove something is TCP-listening there. */
function isTcp(protocol: string | undefined): boolean {
  return protocol === undefined || protocol === "TCP";
}

/** A selector we can evaluate: plain matchLabels, no matchExpressions we would have to guess at. */
function selectsPodLabeled(
  selector: { matchLabels?: { [key: string]: string }; matchExpressions?: unknown[] } | undefined,
  labels: Readonly<Record<string, string>>,
): boolean {
  if (!selector) return false;
  // An expression-based selector may well be correct, but we cannot prove it here: fail closed.
  if (Array.isArray(selector.matchExpressions) && selector.matchExpressions.length > 0) return false;
  const required = Object.entries(selector.matchLabels ?? {});
  return required.every(([key, value]) => labels[key] === value);
}

/** Whether a peer admits pods carrying `labels` in this same namespace. */
function peerAdmits(peer: V1NetworkPolicyPeer, labels: Readonly<Record<string, string>>): boolean {
  // A namespaceSelector re-scopes the peer to other namespaces; run pods are in this one. An
  // ipBlock never matches a pod selector at all. Neither can be counted as admitting run pods.
  if (peer.namespaceSelector || peer.ipBlock) return false;
  return selectsPodLabeled(peer.podSelector, labels);
}

/** Whether a rule's port list covers `port` over TCP (absent/empty = every port, per the API). */
function ruleCoversPort(rule: V1NetworkPolicyIngressRule, port: number): boolean {
  const ports = rule.ports ?? [];
  if (ports.length === 0) return true;
  return ports.some((entry) => {
    if (!isTcp(entry.protocol)) return false;
    // `port` may be a named port, which we cannot resolve to a number here: fail closed.
    if (typeof entry.port !== "number") return false;
    const endPort = typeof entry.endPort === "number" ? entry.endPort : entry.port;
    return entry.port <= port && port <= endPort;
  });
}

/**
 * The rule's source list, under either spelling. `@kubernetes/client-node` deserializes the wire
 * field `from` to `_from` (it collides with a TypeScript keyword), so a policy read back from a
 * real API server has `_from` while a hand-written manifest object has `from`. Reading only one
 * spelling would leave the other `undefined`, which this function reads as "no restriction" — so
 * getting this wrong fails OPEN and would let any policy at all satisfy the check.
 */
function ruleSources(rule: V1NetworkPolicyIngressRule): V1NetworkPolicyPeer[] {
  return rule._from ?? (rule as { from?: V1NetworkPolicyPeer[] }).from ?? [];
}

/** Whether a rule admits pods carrying `labels` on `port` (absent/empty `from` = every source). */
function ruleAdmits(rule: V1NetworkPolicyIngressRule, labels: Readonly<Record<string, string>>, port: number): boolean {
  if (!ruleCoversPort(rule, port)) return false;
  const from = ruleSources(rule);
  return from.length === 0 || from.some((peer) => peerAdmits(peer, labels));
}

/**
 * Proves the attribution precondition: the proxy's own policy admits run pods on the deny port,
 * so the run pod's egress policy is the only thing left that can drop that packet.
 */
async function assertDenyPortAdmitted(api: KubernetesApi, namespace: string, service: string): Promise<void> {
  const where = `NetworkPolicy ${namespace}/${service}`;
  const policy = await api.readNetworkPolicy(namespace, service);
  if (!policy) {
    throw new ProxyWitnessError(
      `${where} was not found, so nothing proves the proxy admits run pods on port ${CODING_PROXY_DENY_PORT}; ` +
        "without that rule the proxy's own ingress drops the probe and every run reads as enforced",
    );
  }
  if (!selectsPodLabeled(policy.spec?.podSelector, PROXY_POD_LABEL)) {
    throw new ProxyWitnessError(
      `${where} does not select the proxy pods (${JSON.stringify(PROXY_POD_LABEL)}), so its rules govern nothing`,
    );
  }
  const admitted = (policy.spec?.ingress ?? []).some((rule) =>
    ruleAdmits(rule, RUN_COMPONENT_LABEL, CODING_PROXY_DENY_PORT),
  );
  if (!admitted) {
    throw new ProxyWitnessError(
      `${where} has no ingress rule that admits ${JSON.stringify(RUN_COMPONENT_LABEL)} on port ` +
        `${CODING_PROXY_DENY_PORT}/TCP. The gate reads a dropped connect to that port as proof the run's ` +
        "own egress policy is enforced; if the proxy does not admit it, the proxy's ingress drops it instead " +
        "and every run reads as enforced while having no egress policy at all",
    );
  }
}

export async function readProxyWitness(api: KubernetesApi, namespace: string, service: string): Promise<ProxyWitness> {
  const where = `Service ${namespace}/${service}`;
  const found = await api.readService(namespace, service);
  if (!found) throw new ProxyWitnessError(`${where} was not found`);
  const clusterIp = found.spec?.clusterIP;
  if (!clusterIp || clusterIp === "None" || isIP(clusterIp) === 0) {
    throw new ProxyWitnessError(`${where} has no usable ClusterIP`);
  }
  const exposed = new Set((found.spec?.ports ?? []).filter((port) => isTcp(port.protocol)).map((port) => port.port));
  for (const required of REQUIRED_PORTS) {
    if (!exposed.has(required)) throw new ProxyWitnessError(`${where} does not expose port ${required}`);
  }

  const endpoints = await api.readEndpoints(namespace, service);
  if (!endpoints) throw new ProxyWitnessError(`${where} has no Endpoints`);

  // Endpoints subset ports are the container's targetPorts, not the Service's own port
  // numbers checked above. Comparing them directly here is only correct because the
  // manifest keeps targetPort == port for both the proxy and deny ports; a future re-map
  // (Service port != container targetPort) fails closed here rather than trusting a port
  // that merely happens to share a number with the deny port.
  let hasReadyAddress = false;
  const readyPorts = new Set<number>();
  for (const subset of endpoints.subsets ?? []) {
    const ready = (subset.addresses ?? []).some((address) => typeof address.ip === "string" && isIP(address.ip) !== 0);
    if (!ready) continue;
    hasReadyAddress = true;
    for (const port of subset.ports ?? []) {
      if (typeof port.port === "number" && isTcp(port.protocol)) readyPorts.add(port.port);
    }
  }
  if (!hasReadyAddress) throw new ProxyWitnessError(`${where} has no ready endpoint address`);
  if (readyPorts.size === 0) throw new ProxyWitnessError(`${where} has a ready endpoint that declares no ports`);
  for (const required of REQUIRED_PORTS) {
    if (!readyPorts.has(required)) {
      throw new ProxyWitnessError(`${where} has no ready endpoint serving port ${required}`);
    }
  }
  await assertDenyPortAdmitted(api, namespace, service);
  return { clusterIp };
}
