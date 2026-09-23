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

export async function readProxyWitness(api: KubernetesApi, namespace: string, service: string): Promise<ProxyWitness> {
  const where = `Service ${namespace}/${service}`;
  const found = await api.readService(namespace, service);
  const clusterIp = found?.spec?.clusterIP;
  if (!clusterIp || clusterIp === "None" || isIP(clusterIp) === 0) {
    throw new ProxyWitnessError(`${where} has no usable ClusterIP`);
  }
  const exposed = new Set((found?.spec?.ports ?? []).map((port) => port.port));
  for (const required of REQUIRED_PORTS) {
    if (!exposed.has(required)) throw new ProxyWitnessError(`${where} does not expose port ${required}`);
  }
  const endpoints = await api.readEndpoints(namespace, service);
  const readyPorts = new Set<number>();
  for (const subset of endpoints?.subsets ?? []) {
    const ready = (subset.addresses ?? []).some((address) => typeof address.ip === "string" && isIP(address.ip) !== 0);
    if (!ready) continue;
    for (const port of subset.ports ?? []) if (typeof port.port === "number") readyPorts.add(port.port);
  }
  if (readyPorts.size === 0) throw new ProxyWitnessError(`${where} has no ready endpoint address`);
  for (const required of REQUIRED_PORTS) {
    if (!readyPorts.has(required)) {
      throw new ProxyWitnessError(`no ready endpoint of ${namespace}/${service} serves port ${required}`);
    }
  }
  return { clusterIp };
}
