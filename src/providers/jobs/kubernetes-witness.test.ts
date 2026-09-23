import { describe, expect, it } from "vitest";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import { readProxyWitness } from "./kubernetes-witness.js";

const NAMESPACE = "wardby-coding";
const SERVICE = "wardby-coding-proxy";

function api(
  options: { ports?: number[]; endpointPorts?: number[]; addresses?: string[]; clusterIP?: string } = {},
): FakeKubernetesApi {
  const fake = new FakeKubernetesApi();
  const {
    ports = [8787, 8788],
    endpointPorts = [8787, 8788],
    addresses = ["10.244.0.5"],
    clusterIP = "10.96.0.50",
  } = options;
  fake.put("service", NAMESPACE, {
    metadata: { name: SERVICE },
    spec: { clusterIP, ports: ports.map((port) => ({ port, protocol: "TCP" })) },
  });
  fake.put("endpoints", NAMESPACE, {
    metadata: { name: SERVICE },
    subsets: [
      {
        addresses: addresses.map((ip) => ({ ip })),
        ports: endpointPorts.map((port) => ({ port, protocol: "TCP" })),
      },
    ],
  });
  return fake;
}

describe("readProxyWitness", () => {
  it("returns the ClusterIP when both ports are exposed and a ready endpoint serves both", async () => {
    expect(await readProxyWitness(api(), NAMESPACE, SERVICE)).toEqual({ clusterIp: "10.96.0.50" });
  });

  it("refuses a Service that does not expose the deny port", async () => {
    await expect(readProxyWitness(api({ ports: [8787] }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy does not expose port 8788",
    );
  });

  it("refuses a Service with no ready endpoint address", async () => {
    await expect(readProxyWitness(api({ addresses: [] }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no ready endpoint address",
    );
  });

  it("refuses when the ready endpoint does not serve the deny port", async () => {
    await expect(readProxyWitness(api({ endpointPorts: [8787] }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: no ready endpoint of wardby-coding/wardby-coding-proxy serves port 8788",
    );
  });

  it("refuses a headless or missing Service", async () => {
    await expect(readProxyWitness(api({ clusterIP: "None" }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no usable ClusterIP",
    );
    await expect(readProxyWitness(new FakeKubernetesApi(), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no usable ClusterIP",
    );
  });
});
