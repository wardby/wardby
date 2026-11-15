// Low-power mode manifests: the power RBAC, the HPA, no headroom pod, one
// gateway replica, and a quota adjusted for them. The plain gke-autopilot
// overlay must stay byte-identical to the committed snapshot, which was taken
// before these overlays existed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllYaml } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = join(here, "../..");
const read = (file) => readFileSync(join(here, file), "utf8");
const load = (file) => loadAllYaml(read(file));
const loadAt = (rel) => loadAllYaml(readFileSync(join(manifests, rel), "utf8"));

const hasKubectl = (() => {
  try {
    execFileSync("kubectl", ["version", "--client"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const render = (overlay) =>
  execFileSync("kubectl", ["kustomize", join(manifests, "overlays", overlay)], { encoding: "utf8" });

describe("low-power manifest sources", () => {
  const role = loadAt("components/low-power/role.yaml");
  const power = role.find((o) => o.kind === "Role");
  const binding = role.find((o) => o.kind === "RoleBinding");

  it("grants get and patch on exactly the proxy, gateway and renderer Deployments, and get on their Endpoints", () => {
    expect(power.metadata.name).toBe("wardby-power");
    expect(power.rules).toEqual([
      {
        apiGroups: ["apps"],
        resources: ["deployments"],
        resourceNames: ["wardby-coding-proxy", "wardby-native-gateway", "wardby-renderer"],
        verbs: ["get", "patch"],
      },
      {
        apiGroups: [""],
        resources: ["endpoints"],
        resourceNames: ["wardby-coding-proxy", "wardby-native-gateway", "wardby-renderer"],
        verbs: ["get"],
      },
    ]);
  });

  it("binds the role to the control plane's ServiceAccount only", () => {
    expect(binding.roleRef.name).toBe("wardby-power");
    expect(binding.subjects).toEqual([
      { kind: "ServiceAccount", name: "wardby-control-plane", namespace: "wardby-coding" },
    ]);
  });

  it("names Deployments that exist in the base, and the proxy the control plane is pointed at", () => {
    const base = [
      ...["proxy.yaml", "native-gateway.yaml"].flatMap((f) => loadAt(`base/${f}`)),
      ...loadAt("renderer/base/renderer.yaml"),
    ];
    const deployments = base.filter((o) => o.kind === "Deployment").map((o) => o.metadata.name);
    const services = base.filter((o) => o.kind === "Service").map((o) => o.metadata.name);
    expect(power.rules[1].resourceNames).toEqual(power.rules[0].resourceNames);
    for (const name of power.rules[0].resourceNames) {
      expect(deployments).toContain(name);
      expect(services).toContain(name);
    }
    const cp = loadAt("overlays/gke-autopilot/control-plane.yaml").find((o) => o.kind === "Deployment");
    const proxyService = cp.spec.template.spec.containers[0].env.find((e) => e.name === "KUBERNETES_PROXY_SERVICE");
    expect(power.rules[0].resourceNames).toContain(proxyService.value);
  });

  it("sets the low-power env on the control-plane container", () => {
    const patch = load("control-plane-env.yaml")[0];
    expect(patch.metadata.name).toBe("wardby-control-plane");
    const container = patch.spec.template.spec.containers[0];
    expect(container.name).toBe("control-plane");
    expect(Object.fromEntries(container.env.map((e) => [e.name, e.value]))).toEqual({
      WARDBY_LOW_POWER: "1",
      LOW_POWER_IDLE_MINUTES: "30",
    });
  });

  it("autoscales the control plane between 1 and 2 on CPU", () => {
    const hpa = load("hpa.yaml")[0];
    expect(hpa.spec.scaleTargetRef.name).toBe("wardby-control-plane");
    expect(hpa.spec.minReplicas).toBe(1);
    expect(hpa.spec.maxReplicas).toBe(2);
    expect(hpa.spec.metrics[0].resource.name).toBe("cpu");
    expect(hpa.spec.metrics[0].resource.target.averageUtilization).toBe(20);
    expect(hpa.spec.behavior.scaleDown.stabilizationWindowSeconds).toBe(600);
  });

  it("turns the headroom pod off and runs one gateway replica", () => {
    expect(load("headroom-off.yaml")[0].metadata.name).toBe("wardby-headroom");
    expect(load("headroom-off.yaml")[0].spec.replicas).toBe(0);
    expect(load("gateway-one.yaml")[0].metadata.name).toBe("wardby-native-gateway");
    expect(load("gateway-one.yaml")[0].spec.replicas).toBe(1);
  });

  it("raises CPU and memory by the net +0.5 CPU / +1Gi and keeps the pod limit", () => {
    const quota = load("quota.yaml")[0].spec.hard;
    expect(quota).toEqual({
      pods: "27",
      "requests.cpu": "12.5",
      "limits.cpu": "12.5",
      "requests.memory": "23Gi",
      "limits.memory": "23Gi",
    });
    const gke = loadAt("overlays/gke-autopilot/quota.yaml")[0].spec.hard;
    expect(quota.pods).toBe(gke.pods);
    expect(Number(quota["requests.cpu"]) - Number(gke["requests.cpu"])).toBe(1);
  });
});

describe.skipIf(!hasKubectl)("low-power rendered overlays (kubectl)", () => {
  const find = (docs, kind, name) => docs.find((o) => o.kind === kind && o.metadata.name === name);

  it("leaves the plain gke-autopilot render byte-identical to the pre-change snapshot", () => {
    expect(render("gke-autopilot")).toBe(read("__snapshots__/gke-autopilot.render.txt"));
  });

  it("renders the GKE low-power overlay with every piece applied", () => {
    const docs = loadAllYaml(render("gke-autopilot-low-power"));
    const powerRole = find(docs, "Role", "wardby-power");
    expect(powerRole.rules.map((r) => [r.resources, r.resourceNames, r.verbs])).toEqual([
      [["deployments"], ["wardby-coding-proxy", "wardby-native-gateway", "wardby-renderer"], ["get", "patch"]],
      [["endpoints"], ["wardby-coding-proxy", "wardby-native-gateway", "wardby-renderer"], ["get"]],
    ]);
    expect(find(docs, "RoleBinding", "wardby-power").subjects[0].name).toBe("wardby-control-plane");
    const hpa = find(docs, "HorizontalPodAutoscaler", "wardby-control-plane");
    expect([hpa.spec.minReplicas, hpa.spec.maxReplicas]).toEqual([1, 2]);
    expect(find(docs, "Deployment", "wardby-headroom").spec.replicas).toBe(0);
    expect(find(docs, "Deployment", "wardby-native-gateway").spec.replicas).toBe(1);
    const cp = find(docs, "Deployment", "wardby-control-plane");
    const env = Object.fromEntries(cp.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]));
    expect(env.WARDBY_LOW_POWER).toBe("1");
    expect(env.LOW_POWER_IDLE_MINUTES).toBe("30");
    expect(env.EXECUTOR).toBe("dbos");
    const hard = find(docs, "ResourceQuota", "wardby-coding").spec.hard;
    expect(hard["requests.cpu"]).toBe("12.5");
    expect(hard["requests.memory"]).toBe("23Gi");
    expect(hard.pods).toBe("27");
  });

  it("leaves the control-plane replica count to the HPA, so a re-apply never resets it", () => {
    const low = find(loadAllYaml(render("gke-autopilot-low-power")), "Deployment", "wardby-control-plane");
    expect(low.spec).not.toHaveProperty("replicas");
    const plain = find(loadAllYaml(render("gke-autopilot")), "Deployment", "wardby-control-plane");
    expect(plain.spec.replicas).toBe(1);
  });

  it("renders the kind low-power overlay with the Role but no HPA", () => {
    const docs = loadAllYaml(render("kind-low-power"));
    expect(find(docs, "Role", "wardby-power")).toBeDefined();
    expect(find(docs, "RoleBinding", "wardby-power")).toBeDefined();
    expect(docs.some((o) => o.kind === "HorizontalPodAutoscaler")).toBe(false);
  });
});
