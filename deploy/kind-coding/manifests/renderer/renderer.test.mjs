// The optional export renderer's manifests: Chromium runs with its own sandbox off, so the pod
// spec is the isolation. Each hardening item is asserted on the source and, where kubectl is
// installed, on the rendered gvisor overlay.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Plain objects (the Kubernetes client's loadAllYaml returns model classes).
const loadAllYaml = (text) => parseAllDocuments(text).map((doc) => doc.toJS());

const here = dirname(fileURLToPath(import.meta.url));
const source = loadAllYaml(readFileSync(join(here, "base/renderer.yaml"), "utf8"));
const hasKubectl = (() => {
  try {
    execFileSync("kubectl", ["version", "--client"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const rendered = hasKubectl
  ? loadAllYaml(execFileSync("kubectl", ["kustomize", join(here, "gvisor")], { encoding: "utf8" }))
  : [];

const pick = (docs, kind, name) => docs.find((o) => o.kind === kind && o.metadata.name === name);

function checkDeployment(deployment, { gvisor }) {
  const spec = deployment.spec;
  const pod = spec.template.spec;
  const container = pod.containers[0];
  expect(spec).not.toHaveProperty("replicas");
  // No surge pod during a rollout: the namespace quota has room for one renderer.
  expect(spec.strategy).toEqual({ type: "Recreate" });
  if (gvisor) expect(pod.runtimeClassName).toBe("gvisor");
  expect(pod.automountServiceAccountToken).toBe(false);
  expect(pod).not.toHaveProperty("serviceAccountName");
  expect(pod.securityContext.runAsNonRoot).toBe(true);
  expect(pod.securityContext.seccompProfile).toEqual({ type: "RuntimeDefault" });
  expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
  expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
  expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
  expect(container).not.toHaveProperty("envFrom");
  for (const entry of container.env) {
    expect(entry).not.toHaveProperty("valueFrom");
    expect(entry.name).not.toMatch(/DATABASE|SECRET|TOKEN|KEY|PASSWORD/i);
  }
  expect(pod.volumes.every((v) => !v.secret && !v.projected && !v.hostPath)).toBe(true);
  expect(container.ports).toEqual([{ name: "http", containerPort: 8796 }]);
  // Probes must tolerate a renderer at its connection cap.
  for (const probe of [container.readinessProbe, container.livenessProbe]) {
    expect(probe.httpGet.path).toBe("/healthz");
    expect(probe.timeoutSeconds).toBeGreaterThanOrEqual(5);
    expect(probe.failureThreshold).toBeGreaterThanOrEqual(3);
  }
  // Requests equal limits (Autopilot), memory sized for 14 buffered bodies plus two renders.
  expect(container.resources.requests).toEqual(container.resources.limits);
  expect(container.resources.limits.memory).toBe("2Gi");
  expect(container.image).toMatch(/^wardby-renderer-image$|^.+@sha256:/);
}

describe("renderer manifests (source)", () => {
  it("hardens the pod and carries no secret", () => {
    checkDeployment(pick(source, "Deployment", "wardby-renderer"), { gvisor: false });
  });

  it("admits only the control plane on 8796 and has an empty egress list", () => {
    const np = pick(source, "NetworkPolicy", "wardby-renderer");
    expect(np.spec.podSelector.matchLabels).toEqual({ "app.kubernetes.io/name": "wardby-renderer" });
    expect(np.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(np.spec.ingress).toEqual([
      {
        from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "wardby-control-plane" } } }],
        ports: [{ protocol: "TCP", port: 8796 }],
      },
    ]);
    expect(np.spec.egress).toEqual([]);
  });

  it("lets the control plane reach the renderer on 8796 and nothing else", () => {
    const np = pick(source, "NetworkPolicy", "wardby-control-plane-renderer-egress");
    expect(np.spec.policyTypes).toEqual(["Egress"]);
    expect(np.spec.egress).toEqual([
      {
        to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "wardby-renderer" } } }],
        ports: [{ protocol: "TCP", port: 8796 }],
      },
    ]);
  });

  it("exposes the Deployment through a Service of the same name on 8796", () => {
    const svc = pick(source, "Service", "wardby-renderer");
    expect(svc.spec.ports).toEqual([{ name: "http", port: 8796, targetPort: "http" }]);
    expect(svc.spec.selector).toEqual({ "app.kubernetes.io/name": "wardby-renderer" });
  });
});

describe.skipIf(!hasKubectl)("renderer/gvisor (kubectl kustomize)", () => {
  it("renders the hardened Deployment under the gVisor runtime class", () => {
    checkDeployment(pick(rendered, "Deployment", "wardby-renderer"), { gvisor: true });
  });

  it("renders both NetworkPolicies and the Service", () => {
    expect(pick(rendered, "NetworkPolicy", "wardby-renderer").spec.egress).toEqual([]);
    expect(pick(rendered, "NetworkPolicy", "wardby-control-plane-renderer-egress")).toBeDefined();
    expect(pick(rendered, "Service", "wardby-renderer")).toBeDefined();
  });
});
