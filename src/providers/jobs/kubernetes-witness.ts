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
 * Both reads are in wardby's own namespace, which the launcher Role permits.
 * (EndpointSlice is the durable successor to the core/v1 Endpoints read here;
 * migrating is a follow-up and needs its own resourceNames grant.)
 */
import { isIP } from "node:net";
import { CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "./docker-isolation.js";
import type { KubernetesApi } from "./kubernetes-api.js";

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
  return { clusterIp };
}
