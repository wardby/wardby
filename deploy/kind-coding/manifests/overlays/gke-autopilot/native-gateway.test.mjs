import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllYaml } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const load = (file) => loadAllYaml(readFileSync(join(here, file), "utf8"));
const read = (file) => readFileSync(join(here, file), "utf8");
const find = (objects, kind, name) => objects.find((o) => o.kind === kind && o.metadata.name === name);

const base = load("../../base/native-gateway.yaml");
const gateway = find(base, "Deployment", "wardby-native-gateway");
const gatewayPolicy = find(base, "NetworkPolicy", "wardby-native-gateway");
const cloudsql = load("native-gateway-cloudsql.yaml");
const proxyCloudsql = load("proxy-cloudsql.yaml");
const env = Object.fromEntries(
  find(load("control-plane.yaml"), "Deployment", "wardby-control-plane").spec.template.spec.containers[0].env.map(
    (e) => [e.name, e.value],
  ),
);

describe("native gateway on GKE Autopilot", () => {
  it("ships the gateway from base with no Kubernetes credential, admitting only native run pods", () => {
    expect(read("../../base/kustomization.yaml")).toMatch(/^ {2}- native-gateway\.yaml$/m);
    expect(read("../kind/kustomization.yaml")).not.toMatch(/^ {2}- native-gateway\.yaml$/m);
    expect(gateway.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(find(load("../../base/service-accounts.yaml"), "ServiceAccount", "wardby-native-gateway")).toMatchObject({
      automountServiceAccountToken: false,
    });
    const [ingress] = gatewayPolicy.spec.ingress;
    expect(ingress._from ?? ingress.from).toEqual([
      { podSelector: { matchLabels: { "wardby.io/component": "native-run" } } },
    ]);
    // The deny port stays admitted at the destination: only the run pod's own policy may block it.
    expect(ingress.ports.map((p) => p.port).sort()).toEqual([8790, 8791]);
  });

  it("logs in to Cloud SQL as its own identity through an Auth Proxy pinned like the proxy's", () => {
    expect(find(cloudsql, "ServiceAccount", "wardby-native-gateway").metadata.annotations).toEqual({
      "iam.gke.io/gcp-service-account": "wardby-gateway-gsa-email",
    });
    const spec = find(cloudsql, "Deployment", "wardby-native-gateway").spec.template.spec;
    const sidecar = spec.initContainers.find((c) => c.name === "cloud-sql-proxy");
    const proxySidecar = find(proxyCloudsql, "Deployment", "wardby-coding-proxy").spec.template.spec.initContainers[0];
    expect(sidecar.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(sidecar.image).toBe(proxySidecar.image);
    expect(sidecar.args).toEqual(proxySidecar.args);
    expect(sidecar.restartPolicy).toBe("Always");
    expect(spec.containers[0].env).toEqual([{ name: "DATABASE_URL", value: "wardby-gateway-database-url" }]);
    expect(spec.priorityClassName).toBe("wardby-control-plane");
  });

  it("reaches the database only through the Auth Proxy port, and resolves through NodeLocal DNSCache", () => {
    const db = find(load("native-gateway-database-egress.yaml"), "NetworkPolicy", "wardby-native-gateway-database");
    expect(db.spec.podSelector.matchLabels).toEqual({ "app.kubernetes.io/name": "wardby-native-gateway" });
    expect(db.spec.egress[0]).toEqual({
      to: [{ ipBlock: { cidr: "wardby-database-cidr" } }],
      ports: [{ protocol: "TCP", port: 3307 }],
    });
    expect(db.spec.egress[1].ports.map((p) => p.port)).toEqual([80, 988]);
    const dns = find(load("native-gateway-dns-egress.yaml"), "NetworkPolicy", "wardby-native-gateway-dns");
    expect(dns.spec.egress[0].to.map((t) => t.ipBlock.cidr)).toContain("169.254.20.10/32");
    const kustomization = read("kustomization.yaml");
    for (const line of [
      /^ {2}- native-gateway-dns-egress\.yaml$/m,
      /^ {2}- native-gateway-database-egress\.yaml$/m,
      /^ {2}- path: native-gateway-cloudsql\.yaml$/m,
      /^ {2}- path: quota\.yaml$/m,
    ]) {
      expect(kustomization).toMatch(line);
    }
  });

  it("configures the control plane's sandbox launcher for Autopilot, sized within the quota", () => {
    expect(env).toMatchObject({
      NATIVE_SANDBOX_LAUNCHER: "kubernetes",
      NATIVE_SANDBOX_WORKER_IMAGE: "wardby-native-worker-image",
      KUBERNETES_PLATFORM: "gke-autopilot",
      KUBERNETES_RUNTIME_CLASS: "gvisor",
      NATIVE_SANDBOX_READY_TIMEOUT_MS: "600000",
    });
    const cpus = Number(env.NATIVE_SANDBOX_CPUS);
    // Already legal on Autopilot: 250m steps and at least 1 GiB per vCPU.
    expect((cpus * 1000) % 250).toBe(0);
    expect(Number(env.NATIVE_SANDBOX_MEMORY_MB)).toBeGreaterThanOrEqual(cpus * 1024);
    const quota = load("quota.yaml")[0].spec.hard;
    const baseQuota = load("../../base/quota.yaml")[0].spec.hard;
    // The gateway's two replicas (500m each with the sidecar, as Autopilot rounds them) plus the
    // cap's workers and the warm pool's idle ones.
    const workers = Number(env.NATIVE_SANDBOX_MAX_CONCURRENT) + Number(env.NATIVE_SANDBOX_WARM_POOL_SIZE);
    const nativeCpu = 2 * 0.5 + workers * cpus;
    expect(Number(quota["requests.cpu"])).toBeGreaterThanOrEqual(Number(baseQuota["requests.cpu"]) + nativeCpu);
    expect(Number(quota.pods)).toBeGreaterThanOrEqual(Number(baseQuota.pods) + 2 + workers);
    expect(quota["limits.cpu"]).toBe(quota["requests.cpu"]);
  });
});

describe("deploy/gke/up.sh and the native sandbox", () => {
  const upSh = read("../../../../gke/up.sh");
  const sedLine = (needle) =>
    upSh
      .split("\n")
      .find((line) => line.includes(needle))
      .trim()
      .replace(/^(sed\s+)?-e\s+/, "")
      .replace(/\s*\\$/, "");
  const sed = (exprs, input, env) =>
    execFileSync("bash", ["-c", `printf '%s' "$IN" | sed ${exprs.map((e) => `-e ${e}`).join(" ")}`], {
      env: { PATH: process.env.PATH, IN: input, ...env },
    }).toString();

  it("substitutes the worker image digest, the gateway's identity and its database URL", () => {
    const image = `registry.example/native-worker@sha256:${"b".repeat(64)}`;
    const out = sed(
      [
        sedLine("s|value: wardby-native-worker-image$|"),
        sedLine("s|wardby-gateway-gsa-email|"),
        sedLine("s|value: wardby-gateway-database-url|"),
      ],
      [read("control-plane.yaml"), read("native-gateway-cloudsql.yaml")].join("\n---\n"),
      {
        NATIVE_WORKER_IMAGE: image,
        GATEWAY_SERVICE_ACCOUNT: "wardby-gateway@project.iam.gserviceaccount.com",
        GATEWAY_DATABASE_URL: "postgresql://wardby-gateway%40project.iam@127.0.0.1:5432/wardby",
      },
    );
    expect(out).toContain(`value: ${image}`);
    expect(out).toContain("iam.gke.io/gcp-service-account: wardby-gateway@project.iam.gserviceaccount.com");
    expect(out).not.toMatch(/wardby-native-worker-image|wardby-gateway-gsa-email|wardby-gateway-database-url/);
  });

  it("refuses to apply a manifest that still carries a native placeholder", () => {
    const fn = upSh.match(/^assert_no_placeholders\(\) \{[\s\S]*?^\}$/m)?.[0];
    const run = (manifest) =>
      execFileSync("bash", ["-c", `${fn}\nassert_no_placeholders "$M"`], {
        env: { PATH: process.env.PATH, M: manifest },
        stdio: "pipe",
      });
    expect(() => run("value: wardby-native-worker-image")).toThrow();
    expect(() => run("iam.gke.io/gcp-service-account: wardby-gateway-gsa-email")).toThrow();
    expect(() => run("value: wardby-gateway-database-url")).toThrow();
  });

  it("builds, pins, syncs and waits for everything the sandbox needs", () => {
    expect(upSh).toMatch(/^IMAGES=\(.*\bnative-worker\b.*\)$/m);
    expect(read("../../../../gke/docker-bake.hcl")).toMatch(/"native-worker",/);
    expect(upSh).toMatch(/^SYNCED_SECRETS=\(.*\bwardby-native-gateway-env\b.*\)$/m);
    expect(upSh).toContain("rollout status deploy/wardby-native-gateway");
    expect(upSh).toMatch(/database_roundtrip wardby-native-gateway gateway NativeGatewaySession/);
    const external = load("secrets/external-secrets.yaml").find((o) => o.metadata.name === "wardby-native-gateway-env");
    expect(external.spec.data.map((d) => d.secretKey).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "OPENAI_API_KEY",
      "SECRET_APP_KEY",
    ]);
  });
});
