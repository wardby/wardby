import { describe, expect, it } from "vitest";
import { ObjectSerializer } from "@kubernetes/client-node/dist/serializer.js";
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
    ingress?: unknown[] | null;
    policyPodSelector?: Record<string, string>;
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
    // The manifest's real rule: run pods admitted at the destination on both ports.
    ingress = [
      {
        from: [{ podSelector: { matchLabels: { "wardby.io/component": "coding-run" } } }],
        ports: [
          { protocol: "TCP", port: 8787 },
          { protocol: "TCP", port: 8788 },
        ],
      },
    ],
    policyPodSelector = { "app.kubernetes.io/name": "wardby-coding-proxy" },
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
  if (ingress !== null) {
    fake.put("networkpolicy", NAMESPACE, {
      metadata: { name: SERVICE },
      spec: { podSelector: { matchLabels: policyPodSelector }, policyTypes: ["Ingress", "Egress"], ingress },
    });
  }
  return fake;
}

/** The deny-port ingress rule the whole attribution rests on. */
const admitsRunPods = (ports: unknown[]) => [
  { from: [{ podSelector: { matchLabels: { "wardby.io/component": "coding-run" } } }], ports },
];

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

describe("readProxyWitness: the proxy's own ingress rule (the attribution precondition)", () => {
  // A timeout only proves the SYN was dropped SOMEWHERE on the path. That it was dropped by the
  // run pod's own egress policy follows from the proxy admitting run pods on 8788 at its ingress.
  // Falsified live: move the drop to the destination (a policy admitting 8787 only) and a prober
  // with no policy at all and full internet egress reads PROVEN. That rule was asserted by
  // manifest and checked nowhere, so deleting one line from an overlay silently voided the gate.

  it("accepts the manifest's rule: run pods admitted on both ports", async () => {
    expect(await readProxyWitness(api(), NAMESPACE, SERVICE)).toEqual({ clusterIp: "10.96.0.50" });
  });

  it("refuses when the proxy has no NetworkPolicy at all", async () => {
    await expect(readProxyWitness(api({ ingress: null }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: NetworkPolicy wardby-coding/wardby-coding-proxy was not found",
    );
  });

  it("refuses the live falsification: a rule admitting 8787 only", async () => {
    await expect(
      readProxyWitness(api({ ingress: admitsRunPods([{ protocol: "TCP", port: 8787 }]) }), NAMESPACE, SERVICE),
    ).rejects.toThrow(/no ingress rule .*admits .*coding-run.* on port 8788/);
  });

  it("refuses a rule whose podSelector does not admit run pods", async () => {
    const ingress = [
      {
        from: [{ podSelector: { matchLabels: { "wardby.io/component": "something-else" } } }],
        ports: [{ protocol: "TCP", port: 8788 }],
      },
    ];
    await expect(readProxyWitness(api({ ingress }), NAMESPACE, SERVICE)).rejects.toThrow(PROXY_WITNESS_UNUSABLE);
  });

  it("refuses a rule that admits the deny port only as UDP", async () => {
    await expect(
      readProxyWitness(api({ ingress: admitsRunPods([{ protocol: "UDP", port: 8788 }]) }), NAMESPACE, SERVICE),
    ).rejects.toThrow(PROXY_WITNESS_UNUSABLE);
  });

  it("refuses a policy that does not select the proxy pods, so its rule governs nothing", async () => {
    await expect(
      readProxyWitness(api({ policyPodSelector: { "app.kubernetes.io/name": "something-else" } }), NAMESPACE, SERVICE),
    ).rejects.toThrow(PROXY_WITNESS_UNUSABLE);
  });

  it("accepts a rule with no ports (all ports) and one with no from (all sources)", async () => {
    await expect(readProxyWitness(api({ ingress: admitsRunPods([]) }), NAMESPACE, SERVICE)).resolves.toBeDefined();
    const allSources = [{ ports: [{ protocol: "TCP", port: 8788 }] }];
    await expect(readProxyWitness(api({ ingress: allSources }), NAMESPACE, SERVICE)).resolves.toBeDefined();
  });

  it("accepts a port range that covers the deny port, and refuses one that stops short", async () => {
    const covering = admitsRunPods([{ protocol: "TCP", port: 8700, endPort: 8800 }]);
    await expect(readProxyWitness(api({ ingress: covering }), NAMESPACE, SERVICE)).resolves.toBeDefined();
    const short = admitsRunPods([{ protocol: "TCP", port: 8700, endPort: 8787 }]);
    await expect(readProxyWitness(api({ ingress: short }), NAMESPACE, SERVICE)).rejects.toThrow(PROXY_WITNESS_UNUSABLE);
  });

  it("refuses a peer scoped to another namespace: run pods live in this one", async () => {
    const elsewhere = [
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "other" } },
            podSelector: { matchLabels: { "wardby.io/component": "coding-run" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 8788 }],
      },
    ];
    await expect(readProxyWitness(api({ ingress: elsewhere }), NAMESPACE, SERVICE)).rejects.toThrow(
      PROXY_WITNESS_UNUSABLE,
    );
  });
});

describe("readProxyWitness: the ingress rule survives a real API round trip", () => {
  it("reads the rule under @kubernetes/client-node's `_from` spelling, not just the manifest's `from`", async () => {
    // The wire field `from` deserializes to `_from` (it collides with a TS keyword), so a policy
    // read from a real API server carries `_from`. Reading only `from` would leave the source list
    // undefined, which means "no restriction" — i.e. this check would silently pass on ANY policy.
    // This asserts the real serializer's output, not a hand-written guess at it.
    const fake = api();
    const raw = fake.objects.get("networkpolicy/wardby-coding/wardby-coding-proxy");
    const roundTripped = ObjectSerializer.deserialize(JSON.parse(JSON.stringify(raw)), "V1NetworkPolicy");
    expect(roundTripped.spec.ingress[0]).toHaveProperty("_from");
    expect(roundTripped.spec.ingress[0].from).toBeUndefined();
    fake.put("networkpolicy", NAMESPACE, roundTripped);
    await expect(readProxyWitness(fake, NAMESPACE, SERVICE)).resolves.toEqual({ clusterIp: "10.96.0.50" });
  });

  it("still refuses the 8787-only policy after the same round trip (the check is not merely absent)", async () => {
    const fake = api({ ingress: admitsRunPods([{ protocol: "TCP", port: 8787 }]) });
    const raw = fake.objects.get("networkpolicy/wardby-coding/wardby-coding-proxy");
    fake.put(
      "networkpolicy",
      NAMESPACE,
      ObjectSerializer.deserialize(JSON.parse(JSON.stringify(raw)), "V1NetworkPolicy"),
    );
    await expect(readProxyWitness(fake, NAMESPACE, SERVICE)).rejects.toThrow(PROXY_WITNESS_UNUSABLE);
  });
});
