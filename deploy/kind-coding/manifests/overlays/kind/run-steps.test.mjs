// Per-run worker egress policies are pinned in src/providers/jobs/kubernetes-isolation.test.ts and
// src/native-worker/kubernetes-isolation.test.ts; these manifest tests cover the static policies.
// On the kind harness the control plane runs on the host, so the only in-cluster piece is the
// proxy's egress to the host's run-steps listener. Worker pods get no rule here.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllYaml } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { admitsRunStepsPort } from "../admits-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, "../../base");
const load = (file) => loadAllYaml(readFileSync(join(here, file), "utf8"));
const PROXY = { "app.kubernetes.io/name": "wardby-coding-proxy" };
const policies = [here, base]
  .flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") && f !== "kustomization.yaml")
      .flatMap((f) => loadAllYaml(readFileSync(join(dir, f), "utf8"))),
  )
  .filter((o) => o?.kind === "NetworkPolicy");

describe("run steps path on the kind harness", () => {
  it("lets the proxy reach the host's run-steps listener on 8792 only", () => {
    const [policy] = load("proxy-run-steps-egress.yaml");
    expect(policy.kind).toBe("NetworkPolicy");
    expect(policy.spec.podSelector.matchLabels).toEqual(PROXY);
    expect(policy.spec.policyTypes).toEqual(["Egress"]);
    expect(policy.spec.egress.flatMap((r) => r.ports.map((p) => [p.protocol, p.port]))).toEqual([["TCP", 8792]]);
  });

  it("admits no worker pod to 8792, in or out, under any policy", () => {
    const rules = policies.flatMap((p) =>
      (p.spec.egress ?? []).filter(admitsRunStepsPort).map((r) => ({ policy: p, rule: r })),
    );
    // Only the proxy's own policy opens 8792 egress, and nothing opens 8792 ingress.
    expect(rules.map((r) => r.policy.spec.podSelector.matchLabels)).toEqual([PROXY]);
    for (const p of policies) {
      expect((p.spec.ingress ?? []).filter(admitsRunStepsPort)).toEqual([]);
    }
    expect(JSON.stringify(policies.filter((p) => (p.spec.egress ?? []).some(admitsRunStepsPort)))).not.toMatch(
      /coding-run|native-run/,
    );
  });

  it("points the proxy at the host and applies both from the overlay", () => {
    const [deployment] = load("proxy-run-steps-env.yaml");
    const env = deployment.spec.template.spec.containers.find((c) => c.name === "proxy").env;
    expect(env).toEqual([{ name: "WARDBY_RUN_STEPS_URL", value: "http://host.docker.internal:8792" }]);
    const kustomization = readFileSync(join(here, "kustomization.yaml"), "utf8");
    expect(kustomization).toMatch(/^ {2}- proxy-run-steps-egress\.yaml$/m);
    expect(kustomization).toMatch(/^ {2}- path: proxy-run-steps-env\.yaml$/m);
  });
});
