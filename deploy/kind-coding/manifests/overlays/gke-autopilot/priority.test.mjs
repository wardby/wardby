import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllYaml } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const load = (file) => loadAllYaml(readFileSync(join(here, file), "utf8"));
const read = (file) => readFileSync(join(here, file), "utf8");

const priority = load("priority.yaml");
const classes = Object.fromEntries(priority.filter((o) => o.kind === "PriorityClass").map((o) => [o.metadata.name, o]));
const headroom = priority.find((o) => o.kind === "Deployment" && o.metadata.name === "wardby-headroom");
const controlPlane = load("control-plane.yaml").find((o) => o.kind === "Deployment");

describe("GKE overlay priority classes", () => {
  it("defines the three classes in the intended order, none of them the cluster default", () => {
    expect(Object.keys(classes).sort()).toEqual(["wardby-coding-run", "wardby-control-plane", "wardby-headroom"]);
    expect(classes["wardby-control-plane"].value).toBe(1_000_000);
    expect(classes["wardby-control-plane"].preemptionPolicy).toBeUndefined();
    expect(classes["wardby-coding-run"].value).toBe(1000);
    expect(classes["wardby-coding-run"].preemptionPolicy).toBe("Never");
    expect(classes["wardby-headroom"].value).toBe(-10);
    expect(classes["wardby-headroom"].preemptionPolicy).toBe("Never");
    for (const c of Object.values(classes)) expect(c.globalDefault).toBe(false);
  });

  it("runs the control plane and the coding proxy at the control-plane class", () => {
    expect(controlPlane.spec.template.spec.priorityClassName).toBe("wardby-control-plane");
    const proxy = load("proxy-priority.yaml")[0];
    expect(proxy.metadata.name).toBe("wardby-coding-proxy");
    expect(proxy.spec.template.spec.priorityClassName).toBe("wardby-control-plane");
  });

  it("points the launcher's run pods at a class this overlay defines", () => {
    const env = controlPlane.spec.template.spec.containers[0].env;
    const run = env.find((e) => e.name === "KUBERNETES_RUN_PRIORITY_CLASS");
    expect(run.value).toBe("wardby-coding-run");
    expect(classes[run.value]).toBeDefined();
  });

  it("lists both new files in the overlay, and the kind overlay references no class", () => {
    const kustomization = read("kustomization.yaml");
    expect(kustomization).toMatch(/^ {2}- priority\.yaml$/m);
    expect(kustomization).toMatch(/^ {2}- path: proxy-priority\.yaml$/m);
    expect(read("../kind/kustomization.yaml")).not.toMatch(/priority/i);
  });
});

describe("GKE overlay headroom placeholder", () => {
  const pod = headroom.spec.template.spec;
  const container = pod.containers[0];

  it("is one lowest-priority pause pod in the wardby namespace", () => {
    expect(headroom.metadata.namespace).toBe("wardby-coding");
    expect(headroom.spec.replicas).toBe(1);
    expect(pod.priorityClassName).toBe("wardby-headroom");
    expect(pod.containers).toHaveLength(1);
    expect(container.image).toMatch(/^registry\.k8s\.io\/pause:[0-9.]+@sha256:[0-9a-f]{64}$/);
  });

  it("holds no token and runs locked down", () => {
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    expect(pod.securityContext.seccompProfile.type).toBe("RuntimeDefault");
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("requests exactly what it limits, as the namespace quota and Autopilot require", () => {
    expect(container.resources.requests).toEqual(container.resources.limits);
    expect(container.resources.requests.cpu).toBe("250m");
    expect(container.resources.requests.memory).toBe("512Mi");
  });
});
