// Per-run worker egress policies are pinned in src/providers/jobs/kubernetes-isolation.test.ts and
// src/native-worker/kubernetes-isolation.test.ts; these manifest tests cover the static policies.
// The run-steps path: the coding proxy posts each coding run's steps to the control plane's
// listener on 8792. The listener authenticates with the run capability, which the coding worker
// also holds, so these NetworkPolicies are the boundary: only the proxy's pods may reach the port.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllYaml } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { admitsRunStepsPort } from "../admits-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, "../../base");
const loadFile = (dir, file) => loadAllYaml(readFileSync(join(dir, file), "utf8"));
const load = (file) => loadFile(here, file);
const find = (objects, kind, name) => objects.find((o) => o.kind === kind && o.metadata.name === name);
const envOf = (deployment, container) =>
  Object.fromEntries(
    deployment.spec.template.spec.containers.find((c) => c.name === container).env.map((e) => [e.name, e.value]),
  );
const runSteps = load("run-steps.yaml");
const selector = (name) => ({ podSelector: { matchLabels: { "app.kubernetes.io/name": name } } });
const PROXY = { "app.kubernetes.io/name": "wardby-coding-proxy" };
const CONTROL_PLANE = { "app.kubernetes.io/name": "wardby-control-plane" };

// Every NetworkPolicy the overlay renders (its own files plus the base).
const allPolicies = [
  ...[here, base].flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") && f !== "kustomization.yaml")
      .flatMap((f) => loadFile(dir, f)),
  ),
].filter((o) => o?.kind === "NetworkPolicy");
const selects = (policy, labels) => {
  const match = policy.spec.podSelector?.matchLabels ?? {};
  return Object.entries(match).every(([k, v]) => labels[k] === v);
};

describe("admitsRunStepsPort", () => {
  it("catches portless, named, ranged and bare-protocol rules, and ignores other ports", () => {
    expect(admitsRunStepsPort({ to: [] })).toBe(true);
    expect(admitsRunStepsPort({ ports: [{ protocol: "TCP" }] })).toBe(true);
    expect(admitsRunStepsPort({ ports: [{ protocol: "TCP", port: 8792 }] })).toBe(true);
    expect(admitsRunStepsPort({ ports: [{ protocol: "TCP", port: "run-steps" }] })).toBe(true);
    expect(admitsRunStepsPort({ ports: [{ protocol: "TCP", port: 8000, endPort: 9000 }] })).toBe(true);
    expect(admitsRunStepsPort({ ports: [{ protocol: "TCP", port: 8080 }] })).toBe(false);
    expect(admitsRunStepsPort({ ports: [{ protocol: "TCP", port: 8000, endPort: 8500 }] })).toBe(false);
    expect(admitsRunStepsPort({ ports: [{ protocol: "UDP", port: 8792 }] })).toBe(false);
  });
});

describe("run steps path on GKE Autopilot", () => {
  it("admits only the coding proxy to the control plane, on the run-steps port only", () => {
    const policy = find(runSteps, "NetworkPolicy", "wardby-control-plane-run-steps");
    expect(policy.spec.podSelector.matchLabels).toEqual(CONTROL_PLANE);
    expect(policy.spec.policyTypes).toEqual(["Ingress"]);
    expect(policy.spec.ingress).toHaveLength(1);
    const [rule] = policy.spec.ingress;
    expect(rule._from ?? rule.from).toEqual([selector("wardby-coding-proxy")]);
    expect(rule.ports.map((p) => [p.protocol, p.port])).toEqual([["TCP", 8792]]);
  });

  it("admits no worker pod, or any pod but the proxy, to 8792 under any policy", () => {
    const ingressToControlPlane = allPolicies.filter(
      (p) => selects(p, CONTROL_PLANE) && (p.spec.policyTypes ?? []).includes("Ingress"),
    );
    expect(ingressToControlPlane.length).toBeGreaterThan(0);
    const admitting = ingressToControlPlane.flatMap((p) =>
      (p.spec.ingress ?? []).filter((r) => admitsRunStepsPort(r)).map((r) => ({ name: p.metadata.name, rule: r })),
    );
    // The only rule admitting 8792 is the proxy rule: no rule without `from`, no namespace-wide or
    // ipBlock peer, and no peer naming the coding-run or native-run worker pods.
    expect(admitting.map((a) => a.name)).toEqual(["wardby-control-plane-run-steps"]);
    for (const { rule } of admitting) {
      const peers = rule._from ?? rule.from;
      expect(peers).toEqual([selector("wardby-coding-proxy")]);
      const labels = JSON.stringify(peers);
      expect(labels).not.toContain("coding-run");
      expect(labels).not.toContain("native-run");
      expect(labels).not.toContain("wardby-coding-worker");
    }
    // A policy selecting every pod must not open ingress either (only default-deny does, with no rules).
    for (const p of allPolicies.filter((q) => Object.keys(q.spec.podSelector?.matchLabels ?? {}).length === 0)) {
      expect(p.spec.ingress ?? []).toEqual([]);
    }
  });

  it("lets the proxy reach that port of the control plane and nothing else of it", () => {
    const policy = find(runSteps, "NetworkPolicy", "wardby-coding-proxy-run-steps");
    expect(policy.spec.podSelector.matchLabels).toEqual(PROXY);
    expect(policy.spec.policyTypes).toEqual(["Egress"]);
    expect(policy.spec.egress).toHaveLength(1);
    const [rule] = policy.spec.egress;
    expect(rule.to).toEqual([selector("wardby-control-plane")]);
    expect(rule.ports.map((p) => [p.protocol, p.port])).toEqual([["TCP", 8792]]);
  });

  it("points the proxy at an internal Service on the port the control plane listens on", () => {
    const service = find(runSteps, "Service", "wardby-control-plane-internal");
    expect(service.spec.type).toBe("ClusterIP");
    expect(service.spec.selector).toEqual(CONTROL_PLANE);
    expect(service.spec.ports.map((p) => [p.port, p.targetPort])).toEqual([[8792, 8792]]);
    const proxy = find(load("proxy-run-steps-env.yaml"), "Deployment", "wardby-coding-proxy");
    expect(envOf(proxy, "proxy").WARDBY_RUN_STEPS_URL).toBe("http://wardby-control-plane-internal:8792");
    const controlPlane = find(load("control-plane.yaml"), "Deployment", "wardby-control-plane");
    expect(envOf(controlPlane, "control-plane").WARDBY_RUN_STEPS_LISTEN).toBe("0.0.0.0:8792");
    const ports = controlPlane.spec.template.spec.containers.find((c) => c.name === "control-plane").ports;
    expect(ports.map((p) => p.containerPort).sort()).toEqual([8080, 8792]);
    const kustomization = readFileSync(join(here, "kustomization.yaml"), "utf8");
    expect(kustomization).toMatch(/^ {2}- run-steps\.yaml$/m);
    expect(kustomization).toMatch(/^ {2}- path: proxy-run-steps-env\.yaml$/m);
  });

  it("keeps the load-balanced control-plane Service to its MCP port", () => {
    const service = find(load("control-plane.yaml"), "Service", "wardby-control-plane");
    expect(service.spec.ports.map((p) => p.port)).toEqual([8080]);
  });
});
