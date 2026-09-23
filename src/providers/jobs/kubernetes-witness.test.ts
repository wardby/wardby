import { describe, expect, it } from "vitest";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import { PROXY_WITNESS_UNUSABLE, ProxyWitnessError, readProxyWitness } from "./kubernetes-witness.js";

const NAMESPACE = "wardby-coding";
const SERVICE = "wardby-coding-proxy";

type PortSpec = number | { port: number; protocol?: string };

function toPort(spec: PortSpec): { port: number; protocol: string } {
  return typeof spec === "number"
    ? { port: spec, protocol: "TCP" }
    : { port: spec.port, protocol: spec.protocol ?? "TCP" };
}

function api(
  options: {
    ports?: PortSpec[];
    endpointPorts?: PortSpec[];
    addresses?: string[];
    notReadyAddresses?: string[];
    clusterIP?: string;
    withEndpoints?: boolean;
  } = {},
): FakeKubernetesApi {
  const fake = new FakeKubernetesApi();
  const {
    ports = [8787, 8788],
    endpointPorts = [8787, 8788],
    addresses = ["10.244.0.5"],
    notReadyAddresses = [],
    clusterIP = "10.96.0.50",
    withEndpoints = true,
  } = options;
  fake.put("service", NAMESPACE, {
    metadata: { name: SERVICE },
    spec: { clusterIP, ports: ports.map(toPort) },
  });
  if (withEndpoints) {
    fake.put("endpoints", NAMESPACE, {
      metadata: { name: SERVICE },
      subsets: [
        {
          addresses: addresses.map((ip) => ({ ip })),
          notReadyAddresses: notReadyAddresses.map((ip) => ({ ip })),
          ports: endpointPorts.map(toPort),
        },
      ],
    });
  }
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

  it("refuses a Service that exposes the deny port only as UDP (protocol must be TCP, not just present)", async () => {
    await expect(
      readProxyWitness(api({ ports: [8787, { port: 8788, protocol: "UDP" }] }), NAMESPACE, SERVICE),
    ).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy does not expose port 8788",
    );
  });

  it("refuses a Service with no ready endpoint address", async () => {
    await expect(readProxyWitness(api({ addresses: [] }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no ready endpoint address",
    );
  });

  it("refuses a Service whose only endpoint address is not-ready (notReadyAddresses must not count)", async () => {
    await expect(
      readProxyWitness(api({ addresses: [], notReadyAddresses: ["10.244.0.5"] }), NAMESPACE, SERVICE),
    ).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no ready endpoint address",
    );
  });

  it("refuses when the ready endpoint declares no ports at all", async () => {
    await expect(readProxyWitness(api({ endpointPorts: [] }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has a ready endpoint that declares no ports",
    );
  });

  it("refuses when the ready endpoint does not serve the deny port", async () => {
    await expect(readProxyWitness(api({ endpointPorts: [8787] }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no ready endpoint serving port 8788",
    );
  });

  it("refuses when the ready endpoint serves the deny port only as UDP", async () => {
    await expect(
      readProxyWitness(api({ endpointPorts: [8787, { port: 8788, protocol: "UDP" }] }), NAMESPACE, SERVICE),
    ).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no ready endpoint serving port 8788",
    );
  });

  it("refuses a Service with no Endpoints object at all", async () => {
    await expect(readProxyWitness(api({ withEndpoints: false }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no Endpoints",
    );
  });

  it("refuses a headless Service", async () => {
    await expect(readProxyWitness(api({ clusterIP: "None" }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no usable ClusterIP",
    );
  });

  it("refuses a Service that was never created", async () => {
    await expect(readProxyWitness(new FakeKubernetesApi(), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy was not found",
    );
  });

  it("throws a ProxyWitnessError carrying the PROXY_WITNESS_UNUSABLE code, not just a matching message", async () => {
    const error: unknown = await readProxyWitness(new FakeKubernetesApi(), NAMESPACE, SERVICE).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(ProxyWitnessError);
    expect((error as Error).message.startsWith(PROXY_WITNESS_UNUSABLE)).toBe(true);
  });
});
