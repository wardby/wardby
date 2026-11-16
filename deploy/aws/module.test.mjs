// Static invariants of the deploy/aws Terraform module that `terraform test` cannot see: values
// shared with the TypeScript code, the GKE module and the manifests, and the deployment rule that
// no identity is hardcoded (CLAUDE.md "Deployment").
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EKS_SANDBOX_NODE_LABEL,
  EKS_SANDBOX_TAINT_KEY,
  GVISOR_RUNTIME_CLASS,
} from "../../src/providers/jobs/kubernetes-platform.ts";

const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(moduleDir, "..", "..");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".terraform" || name === ".terraform.lock.hcl") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const read = (name) => readFileSync(join(moduleDir, name), "utf8");
const moduleFiles = walk(moduleDir);
const tfSources = moduleFiles.filter((f) => f.endsWith(".tf")).map((f) => readFileSync(f, "utf8"));

/** The body of each `variable "name" { ... }` block in variables.tf, keyed by name. */
function variableBlocks() {
  const blocks = {};
  for (const chunk of read("variables.tf")
    .split(/^variable "/m)
    .slice(1)) {
    blocks[chunk.slice(0, chunk.indexOf('"'))] = chunk;
  }
  return blocks;
}

describe("deploy/aws hygiene", () => {
  it("hardcodes no account id: only AWS's documentation placeholders appear", () => {
    for (const file of moduleFiles) {
      const ids = readFileSync(file, "utf8").match(/(?<!\d)\d{12}(?!\d)/g) ?? [];
      const real = ids.filter((id) => id !== "111122223333" && id !== "123456789012");
      expect(real, relative(repoRoot, file)).toEqual([]);
    }
  });

  it("names none of our own hosts or test repositories", () => {
    // This file is skipped: it holds the pattern itself.
    for (const file of moduleFiles.filter((f) => !f.endsWith("module.test.mjs"))) {
      expect(readFileSync(file, "utf8"), relative(repoRoot, file)).not.toMatch(/wardby\.com|knock-knock/i);
    }
  });

  it("commits no tfvars other than the example", () => {
    const tfvars = moduleFiles.filter((f) => /\.tfvars(\.json)?$/.test(f));
    expect(tfvars.map((f) => relative(moduleDir, f))).toEqual([]);
  });

  it("gives every variable a type and a description", () => {
    const blocks = variableBlocks();
    expect(Object.keys(blocks).length).toBeGreaterThan(0);
    for (const [name, body] of Object.entries(blocks)) {
      expect(body, name).toMatch(/^\s*type\s*=/m);
      expect(body, name).toMatch(/^\s*description\s*=/m);
    }
  });

  it("configures no backend: state location is the operator's choice", () => {
    for (const source of tfSources) expect(source).not.toMatch(/^\s*backend\s+"/m);
  });
});

describe("deploy/aws sandbox node group", () => {
  const local = (name) => read("nodegroups.tf").match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`, "m"))?.[1];

  it("labels and taints sandbox nodes exactly as the eks platform profile expects", () => {
    expect(local("sandbox_label_key")).toBe(EKS_SANDBOX_NODE_LABEL);
    expect(local("sandbox_taint_key")).toBe(EKS_SANDBOX_TAINT_KEY);
    expect(local("sandbox_value")).toBe(GVISOR_RUNTIME_CLASS);
  });
});

/** The body of `resource "<type>" "<name>" { ... }` in a .tf source (brace-matched). */
function resourceBlock(source, type, name) {
  const start = source.indexOf(`resource "${type}" "${name}" {`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return "";
}

/** The addresses listed in a block's `depends_on = [ ... ]`. */
const dependsOn = (block) =>
  (block.match(/^\s*depends_on\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Ordering `terraform test` cannot observe: mocks create everything at once.
describe("deploy/aws creation order", () => {
  const nodegroups = read("nodegroups.tf");

  it("creates the control-plane log group before the cluster, so EKS does not create an unmanaged one", () => {
    expect(dependsOn(resourceBlock(read("cluster.tf"), "aws_eks_cluster", "main"))).toContain(
      "aws_cloudwatch_log_group.cluster",
    );
  });

  it("starts both node groups only after the private subnets have their NAT routes", () => {
    for (const group of ["system", "sandbox"]) {
      const deps = dependsOn(resourceBlock(nodegroups, "aws_eks_node_group", group));
      expect(deps, group).toEqual(
        expect.arrayContaining(["aws_route.private_nat", "aws_route_table_association.private"]),
      );
    }
  });

  it("installs coredns after kube-proxy and the system nodes", () => {
    expect(dependsOn(resourceBlock(nodegroups, "aws_eks_addon", "coredns"))).toEqual(
      expect.arrayContaining(["aws_eks_addon.kube_proxy", "aws_eks_node_group.system"]),
    );
  });
});

describe("deploy/aws database identities", () => {
  it("binds each database role to a service account the manifests define", () => {
    const manifests = walk(join(repoRoot, "deploy", "kind-coding", "manifests")).filter((f) => f.endsWith(".yaml"));
    const accounts = new Set(
      manifests.flatMap((f) =>
        [
          ...readFileSync(f, "utf8").matchAll(
            /kind: ServiceAccount\s*\nmetadata:\s*\n(?:\s+\S.*\n)*?\s+name: ([\w-]+)/g,
          ),
        ].map((m) => m[1]),
      ),
    );
    const block = read("database-iam.tf").match(/database_identities = \{([\s\S]*?)\}/)[1];
    const bound = [...block.matchAll(/=\s*"([\w-]+)"/g)].map((m) => m[1]);
    expect(bound).toEqual(["wardby-control-plane", "wardby-migrator", "wardby-coding-proxy", "wardby-native-gateway"]);
    for (const account of bound) expect(accounts, account).toContain(account);
  });
});

/** Quoted strings inside `<name> = toset([ ... ])` in a .tf source. */
function tosetList(source, name) {
  const body = source.match(new RegExp(`${name}\\s*=\\s*toset\\(\\[([\\s\\S]*?)\\]\\)`))?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("deploy/aws parity with the GKE deployment", () => {
  it("creates the same secret ids as deploy/gke", () => {
    const gke = tosetList(readFileSync(join(repoRoot, "deploy", "gke", "secrets.tf"), "utf8"), "secret_ids");
    expect(gke.length).toBeGreaterThan(0);
    expect(tosetList(read("secrets.tf"), "secret_ids").sort()).toEqual(gke.sort());
  });

  it("creates one ECR repository per docker-bake.hcl default target, plus the optional renderer", () => {
    const bake = readFileSync(join(repoRoot, "deploy", "gke", "docker-bake.hcl"), "utf8");
    const targets = [
      ...bake.match(/group "default"\s*\{[\s\S]*?targets\s*=\s*\[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(tosetList(read("ecr.tf"), "image_names").sort()).toEqual([...targets, "renderer"].sort());
    // The renderer is a separate bake target outside the default group.
    expect(targets).not.toContain("renderer");
    expect(bake).toMatch(/target "renderer"/);
  });
});

describe("deploy/aws README", () => {
  const readme = read("README.md");

  it("documents every input variable", () => {
    for (const name of Object.keys(variableBlocks())) expect(readme, name).toContain(`\`${name}\``);
  });

  it("documents every output", () => {
    const outputs = [...read("outputs.tf").matchAll(/^output "([\w]+)"/gm)].map((m) => m[1]);
    for (const name of outputs) expect(readme, name).toContain(`\`${name}\``);
  });
});
