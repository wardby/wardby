/**
 * Release invariant 4: package policy. Random dependency graphs (direct, transitive and orphan
 * packages) are written as every lockfile format the registry verifies (npm package-lock.json,
 * pnpm-lock.yaml v9 and v6, yarn.lock classic and Berry, uv.lock, a pinned requirements file),
 * planned through the real RegistryService against the fake npm registry and fake PyPI, in
 * enforce and audit mode. Then:
 *
 * - enforce: exactly what the allowlist reaches over registry-confirmed edges is approved;
 * - audit: everything is approved, and the labels are sound: `top-level` only for what a project
 *   declares, `transitive` only below a top-level package that reaches it, `unknown` only for what
 *   no declared package reaches; a download records the plan's label;
 * - `unknown` is never added by approve_audited_packages unless named;
 * - an sdist is never served; Poetry and pylock lockfiles are refused;
 * - a lockfile written through the proxy comes back from collection with no proxy URL and no
 *   registry token, as the public install would have written it.
 *
 * The registry token and the run capability are swept through every response and record.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { npmAdapter } from "../coding/registry/npm.js";
import { pypiAdapter } from "../coding/registry/pypi.js";
import { normalizeRegistryLockfiles } from "../coding/registry/lockfiles.js";
import { fakeResourceGrants } from "../core/grants.test-support.js";
import type { McpRequestContext } from "../mcp/context.js";
import { buildMcpServer } from "../mcp/server.js";
import { registerPackageTools } from "../mcp/tools/packages.js";
import { capabilityHash } from "../providers/coding-proxy/proxy.js";
import {
  fakeNpmRegistry,
  fakePypiRegistry,
  sriOf,
  tarballOf,
  tarballUrl,
  wheelName,
  type FakePypi,
  type FakeRegistry,
} from "../providers/coding-proxy/registry/fake-registries.test-support.js";
import { RegistryService, type RegistryResponse } from "../providers/coding-proxy/registry/service.js";
import { MemoryRegistryStore } from "../providers/coding-proxy/registry/store.js";
import { forAll, type Rng } from "./seeded.test-support.js";
import { secretSweep, type SecretSweep } from "./secret-sweep.test-support.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-19T00:00:00Z");
const OLD = new Date(NOW.getTime() - 30 * DAY).toISOString();
const PROXY_BASE = "http://wardby-proxy:8787";

let sweep: SecretSweep | undefined;
afterEach(() => {
  sweep?.dispose();
  sweep = undefined;
});

/** A generated graph: packages pkg0..pkgN-1, each at 1.i.0, edges only to later packages (a DAG). */
interface Graph {
  names: string[];
  version: (name: string) => string;
  deps: Map<string, string[]>;
  /** What the project declares. */
  declared: string[];
  allowlist: string[];
}

/**
 * `pruned`: no orphans, as a real install writes it (every entry reachable from what the project
 * declares). Yarn classic needs it: with no projects recorded, an entry nothing depends on stands
 * in for a declared one.
 */
function graph(r: Rng, pruned = false): Graph {
  const n = r.int(3, 9);
  const names = Array.from({ length: n }, (_, i) => `pkg${i}`);
  const deps = new Map(names.map((name, i) => [name, names.slice(i + 1).filter(() => r.bool(0.3))] as const));
  const dependedOn = new Set([...deps.values()].flat());
  // At least one declared package; unless pruned, some end up neither declared nor reachable (orphans).
  const declared = names.filter((name, i) => i === 0 || r.bool(0.35) || (pruned && !dependedOn.has(name)));
  const allowlist = names.filter(() => r.bool(0.25));
  return { names, version: (name) => `1.${names.indexOf(name)}.0`, deps, declared, allowlist };
}

/** Everything reachable from `starts` over the graph's edges (the starts included). */
function reachable(g: Graph, starts: readonly string[], through: (name: string) => boolean = () => true) {
  const seen = new Set<string>();
  const queue = starts.filter(through);
  for (const name of queue) seen.add(name);
  while (queue.length > 0) {
    for (const child of g.deps.get(queue.shift()!) ?? []) {
      if (seen.has(child) || !through(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

// ---- npm-family lockfiles ----------------------------------------------------------------------

type NpmFormat = "package-lock" | "pnpm-v9" | "pnpm-v6" | "yarn-classic" | "yarn-berry";
const NPM_FORMATS: NpmFormat[] = ["package-lock", "pnpm-v9", "pnpm-v6", "yarn-classic", "yarn-berry"];
const npmBase = `${PROXY_BASE}/registry/npm/`;
const sri = (name: string, version: string) => sriOf(tarballOf(name, version));
const proxyTarball = (name: string, version: string) => `${npmBase}-/tarball/${encodeURIComponent(name)}/${version}`;

function npmLockfile(g: Graph, format: NpmFormat, proxied = false): string {
  const v = g.version;
  const range = "^1.0.0";
  switch (format) {
    case "package-lock": {
      const packages: Record<string, unknown> = {
        "": { name: "app", dependencies: Object.fromEntries(g.declared.map((d) => [d, range])) },
      };
      for (const name of g.names) {
        const children = g.deps.get(name)!;
        packages[`node_modules/${name}`] = {
          version: v(name),
          resolved: proxied ? proxyTarball(name, v(name)) : tarballUrl(name, v(name)),
          integrity: sri(name, v(name)),
          ...(children.length > 0 ? { dependencies: Object.fromEntries(children.map((c) => [c, range])) } : {}),
        };
      }
      return `${JSON.stringify({ name: "app", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
    }
    case "pnpm-v9": {
      const lines = ["lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    dependencies:"];
      for (const d of g.declared) lines.push(`      ${d}:`, `        specifier: ${range}`, `        version: ${v(d)}`);
      lines.push("", "packages:", "");
      for (const name of g.names) {
        const tarball = proxied ? `, tarball: ${proxyTarball(name, v(name))}` : "";
        lines.push(`  ${name}@${v(name)}:`, `    resolution: {integrity: ${sri(name, v(name))}${tarball}}`, "");
      }
      lines.push("snapshots:", "");
      for (const name of g.names) {
        const children = g.deps.get(name)!;
        if (children.length === 0) lines.push(`  ${name}@${v(name)}: {}`, "");
        else
          lines.push(`  ${name}@${v(name)}:`, "    dependencies:", ...children.map((c) => `      ${c}: ${v(c)}`), "");
      }
      return `${lines.join("\n")}\n`;
    }
    case "pnpm-v6": {
      const lines = ["lockfileVersion: '6.0'", "", "dependencies:"];
      for (const d of g.declared) lines.push(`  ${d}:`, `    specifier: ${range}`, `    version: ${v(d)}`);
      lines.push("", "packages:", "");
      for (const name of g.names) {
        const children = g.deps.get(name)!;
        const tarball = proxied ? `, tarball: ${proxyTarball(name, v(name))}` : "";
        lines.push(`  /${name}@${v(name)}:`, `    resolution: {integrity: ${sri(name, v(name))}${tarball}}`);
        if (children.length > 0) lines.push("    dependencies:", ...children.map((c) => `      ${c}: ${v(c)}`));
        lines.push("    dev: false", "");
      }
      return `${lines.join("\n")}\n`;
    }
    case "yarn-classic": {
      const lines = ["# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.", "# yarn lockfile v1", "", ""];
      const host = proxied ? npmBase : "https://registry.yarnpkg.com/";
      for (const name of g.names) {
        const children = g.deps.get(name)!;
        lines.push(
          `${name}@${range}:`,
          `  version "${v(name)}"`,
          `  resolved "${host}${name}/-/${name}-${v(name)}.tgz"`,
          `  integrity ${sri(name, v(name))}`,
        );
        if (children.length > 0) lines.push("  dependencies:", ...children.map((c) => `    ${c} "${range}"`));
        lines.push("");
      }
      return `${lines.join("\n")}`;
    }
    case "yarn-berry": {
      const lines = [
        '# This file is generated by running "yarn install" inside your project.',
        "# Manual changes might be lost - proceed with caution!",
        "",
        "__metadata:",
        "  version: 8",
        "  cacheKey: 10c0",
        "",
      ];
      const entries: Array<[string, string[]]> = [];
      for (const name of g.names) {
        const children = g.deps.get(name)!;
        const resolution = proxied
          ? `${name}@npm:${v(name)}::__archiveUrl=${encodeURIComponent(proxyTarball(name, v(name)))}`
          : `${name}@npm:${v(name)}`;
        entries.push([
          `"${name}@npm:${range}":`,
          [
            `  version: ${v(name)}`,
            `  resolution: "${resolution}"`,
            ...(children.length > 0 ? ["  dependencies:", ...children.map((c) => `    ${c}: "npm:${range}"`)] : []),
            "  checksum: 10c0/0000",
            "  languageName: node",
            "  linkType: hard",
          ],
        ]);
      }
      entries.push([
        '"app@workspace:.":',
        [
          "  version: 0.0.0-use.local",
          '  resolution: "app@workspace:."',
          ...(g.declared.length > 0 ? ["  dependencies:", ...g.declared.map((d) => `    ${d}: "npm:${range}"`)] : []),
          "  languageName: unknown",
          "  linkType: soft",
        ],
      ]);
      entries.sort(([a], [b]) => a.localeCompare(b));
      for (const [head, body] of entries) lines.push(head, ...body, "");
      return `${lines.join("\n")}`;
    }
  }
}

const npmRegistryOf = (g: Graph): FakeRegistry =>
  Object.fromEntries(
    g.names.map((name) => [
      name,
      { [g.version(name)]: { deps: Object.fromEntries(g.deps.get(name)!.map((c) => [c, "^1.0.0"])) } },
    ]),
  );

// ---- PyPI lockfiles ----------------------------------------------------------------------------

type PypiFormat = "uv.lock" | "requirements";

function pypiLockfile(g: Graph, format: PypiFormat, proxied = false, token = ""): string {
  if (format === "requirements") return `${g.names.map((name) => `${name}==${g.version(name)}`).join("\n")}\n`;
  const pypiBase = proxied ? `http://wardby:${token}@wardby-proxy:8787/registry/pypi/` : "";
  const registry = proxied ? `${pypiBase}simple/` : "https://pypi.org/simple";
  const lines = ["version = 1", 'requires-python = ">=3.12"', ""];
  lines.push("[[package]]", 'name = "demo-app"', 'version = "0.1.0"', 'source = { editable = "." }');
  lines.push(`dependencies = [${g.declared.map((d) => `{ name = "${d}" }`).join(", ")}]`, "");
  for (const name of g.names) {
    const children = g.deps.get(name)!;
    const file = wheelName(name, g.version(name));
    const url = proxied
      ? `${pypiBase}files/${name}/${file}`
      : `https://files.pythonhosted.org/packages/py3/${name[0]}/${name}/${file}`;
    lines.push(
      "[[package]]",
      `name = "${name}"`,
      `version = "${g.version(name)}"`,
      `source = { registry = "${registry}" }`,
    );
    if (children.length > 0) lines.push(`dependencies = [${children.map((c) => `{ name = "${c}" }`).join(", ")}]`);
    lines.push(`wheels = [{ url = "${url}", hash = "sha256:00" }]`, "");
  }
  return lines.join("\n");
}

const pypiOf = (g: Graph): FakePypi =>
  Object.fromEntries(
    g.names.map((name) => [name, { [g.version(name)]: { requires: g.deps.get(name)!.map((c) => `${c}>=1`) } }]),
  );

// ---- the registry service ----------------------------------------------------------------------

function registryFor(ecosystem: "npm" | "pypi", g: Graph, packageAudit: "audit" | null, token: string) {
  const fake = ecosystem === "npm" ? fakeNpmRegistry(npmRegistryOf(g), OLD) : fakePypiRegistry(pypiOf(g), OLD);
  const store = new MemoryRegistryStore();
  store.contexts.set(capabilityHash(token), {
    runId: "run-1",
    deadlineAt: new Date(NOW.getTime() + DAY),
    allowlist: { [ecosystem]: g.allowlist },
    policy: {},
    repository: "owner/repo",
    cacheImage: null,
    dependencyCache: false,
    packageAudit,
  });
  const service = new RegistryService({
    adapters: new Map([ecosystem === "npm" ? ["npm", npmAdapter] : ["pypi", pypiAdapter]]),
    store,
    audit: {
      audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [] }),
      auditVersions: async () => new Map(),
    },
    upstream: fake.upstream,
    proxyBase: `${PROXY_BASE}/registry/`,
    limits: { maxFileBytes: 1_000_000, maxTotalBytes: 10_000_000, maxFiles: 100, idleTimeoutMs: 1_000 },
    now: () => NOW,
  });
  const request = (subpath: string) => ({
    method: "GET",
    ecosystem,
    subpath,
    token,
    signal: new AbortController().signal,
  });
  const plan = async (body: string) => {
    const response = await service.plan({
      ecosystem,
      token,
      readBody: async () => body,
      signal: new AbortController().signal,
    });
    const text = (response as { body: string }).body;
    sweep?.record("plan response", text);
    return { status: response.status, json: JSON.parse(text) as PlanJson };
  };
  const get = async (subpath: string) => {
    const response = await service.handle(request(subpath));
    const body = await drain(response);
    sweep?.record(`GET ${subpath}`, body);
    return { status: response.status, body };
  };
  return { store, plan, get };
}

interface PlanJson {
  approved: number;
  refused: { name: string; version: string; code: string; reason: string }[];
  audited?: number;
  error?: string;
}

async function drain(response: RegistryResponse): Promise<string> {
  if ("stream" in response) return new Response(response.stream).text();
  return (response as { body?: string }).body ?? "";
}

type Relation = "top-level" | "transitive" | "unknown";

/**
 * The soundness checks on audit labels. `declared` is what the format records as declared by a
 * project (a requirements file records none), `completeTopLevel` the declared packages it can
 * place (yarn classic records no projects: it stands in the descriptors no entry depends on).
 */
function checkLabels(
  g: Graph,
  labels: Map<string, { relation: Relation; via?: string }>,
  declared: string[],
  completeTopLevel: string[],
) {
  const allowed = reachable(g, g.allowlist);
  for (const name of g.names) {
    if (allowed.has(name)) {
      expect(labels.get(name), `${name} is reached from the allowlist: not audited`).toBeUndefined();
      continue;
    }
    const label = labels.get(name);
    expect(label, `${name} is audited`).toBeDefined();
    if (label!.relation === "top-level") expect(declared, `${name} is top-level`).toContain(name);
    if (label!.relation === "transitive") {
      expect(labels.get(label!.via!)?.relation, `${name}'s via ${label!.via} is top-level`).toBe("top-level");
      expect(reachable(g, [label!.via!], (x) => !allowed.has(x)).has(name), `${label!.via} reaches ${name}`).toBe(true);
    }
    if (label!.relation === "unknown") {
      const fromDeclared = reachable(g, declared, (x) => !allowed.has(x));
      expect(fromDeclared.has(name), `${name} is unknown, so no declared package reaches it`).toBe(false);
    }
  }
  for (const name of completeTopLevel) {
    if (!allowed.has(name)) expect(labels.get(name)?.relation, `${name} is declared`).toBe("top-level");
  }
}

describe("package policy: npm-family lockfiles x enforce/audit", () => {
  for (const format of NPM_FORMATS) {
    it(`${format}: enforce approves exactly the allowlist's reach; audit labels soundly; downloads record the label`, async () => {
      let cases = 0;
      await forAll(`packages.${format}`, 12, async (r) => {
        const g = graph(r, format === "yarn-classic");
        sweep = secretSweep(cases + 1);
        const token = `rrg_${sweep.plant("registry token", "opaque")}`;
        const body = npmLockfile(g, format);

        // Enforce.
        const enforce = registryFor("npm", g, null, token);
        const enforced = await enforce.plan(body);
        expect(enforced.status).toBe(200);
        const reach = reachable(g, g.allowlist);
        expect(new Set([...enforce.store.approvals.values()].map((a) => a.name))).toEqual(reach);
        for (const refusal of enforced.json.refused) {
          expect(reach.has(refusal.name)).toBe(false);
          expect(refusal.code).toBe("wardby_package_not_allowed");
        }

        // Audit.
        const audit = registryFor("npm", g, "audit", token);
        const audited = await audit.plan(body);
        expect(audited.json).toMatchObject({ approved: g.names.length, refused: [] });
        const labels = new Map(
          [...audit.store.approvals.values()]
            .filter((a) => a.audit)
            .map((a) => [a.name, a.audit as { relation: Relation; via?: string }]),
        );
        const dependedOn = new Set([...g.deps.values()].flat());
        const placeable = format === "yarn-classic" ? g.declared.filter((d) => !dependedOn.has(d)) : g.declared;
        checkLabels(g, labels, g.declared, placeable);

        // Each download records the plan's label.
        for (const name of g.names) {
          const version = g.version(name);
          const got = await audit.get(`${name}/-/${name}-${version}.tgz`);
          expect(got.status).toBe(200);
        }
        for (const [name, label] of labels) {
          const recorded = audit.store.audits.filter((row) => row.name === name).map((row) => row.relation);
          expect(new Set(recorded), `${name}'s download records its label`).toEqual(new Set([label.relation]));
        }
        sweep.record("store", { audits: audit.store.audits, fetches: audit.store.fetches });
        sweep.assertClean();
        sweep.dispose();
        cases += 1;
      });
      expect(cases).toBe(12);
    });
  }
});

describe("package policy: PyPI lockfiles x enforce/audit", () => {
  for (const format of ["uv.lock", "requirements"] as const) {
    it(`${format}: enforce allows exactly the allowlist's reach; audit labels soundly; downloads record the label`, async () => {
      let cases = 0;
      await forAll(`packages.${format}`, 12, async (r) => {
        const g = graph(r);
        sweep = secretSweep(cases + 100);
        const token = `rrg_${sweep.plant("registry token", "opaque")}`;
        const body = pypiLockfile(g, format);

        const enforce = registryFor("pypi", g, null, token);
        expect((await enforce.plan(body)).status).toBe(200);
        const reach = reachable(g, g.allowlist);
        for (const name of g.names) {
          expect(await enforce.store.isAllowedDependency("run-1", "pypi", name), name).toBe(reach.has(name));
        }

        const audit = registryFor("pypi", g, "audit", token);
        expect((await audit.plan(body)).json).toMatchObject({ approved: g.names.length, refused: [] });
        for (const name of g.names) {
          expect((await audit.get(`simple/${name}/`)).status).toBe(200);
          expect((await audit.get(`files/${name}/${wheelName(name, g.version(name))}`)).status).toBe(200);
        }
        const labels = new Map<string, { relation: Relation; via?: string }>();
        for (const row of audit.store.audits) {
          if (row.relation === "allowed") continue;
          const relations = new Set(audit.store.audits.filter((x) => x.name === row.name).map((x) => x.relation));
          expect(relations.size, `${row.name} is recorded with one label`).toBe(1);
          labels.set(row.name, { relation: row.relation, ...(row.via ? { via: row.via } : {}) });
        }
        // A requirements file declares no project: nothing in it can be placed top-level.
        const declared = format === "uv.lock" ? g.declared : [];
        checkLabels(g, labels, declared, declared);
        if (format === "requirements") {
          expect([...labels.values()].some((l) => l.relation === "top-level")).toBe(false);
        }
        sweep.record("store", { audits: audit.store.audits, fetches: audit.store.fetches });
        sweep.assertClean();
        sweep.dispose();
        cases += 1;
      });
      expect(cases).toBe(12);
    });
  }

  it("an sdist is never served, from a plan or a direct download, and the index lists none", async () => {
    const g: Graph = {
      names: ["wheelpkg", "sdistpkg"],
      version: () => "1.0.0",
      deps: new Map([
        ["wheelpkg", ["sdistpkg"]],
        ["sdistpkg", []],
      ]),
      declared: ["wheelpkg"],
      allowlist: ["wheelpkg", "sdistpkg"],
    };
    for (const packageAudit of [null, "audit"] as const) {
      sweep = secretSweep(7);
      const token = `rrg_${sweep.plant("registry token", "opaque")}`;
      const fake = registryFor("pypi", g, packageAudit, token);
      // The fake PyPI serves sdistpkg as an sdist only.
      const sdistOnly: FakePypi = { ...pypiOf(g), sdistpkg: { "1.0.0": { sdistOnly: true } } };
      const service = registryWith(sdistOnly, g, packageAudit, token);
      const planned = await service.plan(pypiLockfile(g, "requirements"));
      expect(planned.json.refused).toEqual([
        expect.objectContaining({ name: "sdistpkg", code: "wardby_file_not_allowed" }),
      ]);
      // The index may list the sdist (so a uv.lock written through the proxy keeps it, as one
      // written against PyPI does), but the file itself is never served.
      expect((await service.get("simple/sdistpkg/")).status).toBe(200);
      const download = await service.get("files/sdistpkg/sdistpkg-1.0.0.tar.gz");
      expect(download.status).toBeGreaterThanOrEqual(400);
      expect(download.body).not.toBe("wheel bytes");
      void fake;
      sweep.assertClean();
      sweep.dispose();
    }
  });

  it("refuses Poetry and pylock lockfiles with a clear unsupported error", async () => {
    const g = graph((await import("./seeded.test-support.js")).rng(1));
    sweep = secretSweep(9);
    const token = `rrg_${sweep.plant("registry token", "opaque")}`;
    const { plan } = registryFor("pypi", g, null, token);
    for (const body of [
      "# This file is automatically @generated by Poetry 2.1.1 and should not be changed by hand.\n[[package]]\n",
      'lock-version = "1.0"\ncreated-by = "pip"\n[[packages]]\nname = "x"\nversion = "1.0"\n',
    ]) {
      const { status, json } = await plan(body);
      expect(status).toBe(400);
      expect(json.error).toContain("wardby_lockfile_unsupported");
    }
    sweep.assertClean();
  });
});

/** registryFor, but over a given fake PyPI (for releases the graph cannot express, like sdists). */
function registryWith(pypi: FakePypi, g: Graph, packageAudit: "audit" | null, token: string) {
  const fake = fakePypiRegistry(pypi, OLD);
  const store = new MemoryRegistryStore();
  store.contexts.set(capabilityHash(token), {
    runId: "run-1",
    deadlineAt: new Date(NOW.getTime() + DAY),
    allowlist: { pypi: g.allowlist },
    policy: {},
    repository: "owner/repo",
    cacheImage: null,
    dependencyCache: false,
    packageAudit,
  });
  const service = new RegistryService({
    adapters: new Map([["pypi", pypiAdapter]]),
    store,
    audit: {
      audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [] }),
      auditVersions: async () => new Map(),
    },
    upstream: fake.upstream,
    proxyBase: `${PROXY_BASE}/registry/`,
    limits: { maxFileBytes: 1_000_000, maxTotalBytes: 10_000_000, maxFiles: 100, idleTimeoutMs: 1_000 },
    now: () => NOW,
  });
  return {
    plan: async (body: string) => {
      const response = await service.plan({
        ecosystem: "pypi",
        token,
        readBody: async () => body,
        signal: new AbortController().signal,
      });
      const text = (response as { body: string }).body;
      sweep?.record("plan response", text);
      return { status: response.status, json: JSON.parse(text) as PlanJson };
    },
    get: async (subpath: string) => {
      const response = await service.handle({
        method: "GET",
        ecosystem: "pypi",
        subpath,
        token,
        signal: new AbortController().signal,
      });
      const body = await drain(response);
      sweep?.record(`GET ${subpath}`, body);
      return { status: response.status, body };
    },
  };
}

describe("package policy: approve_audited_packages never adds an unknown package unless named", () => {
  async function approveTool(records: Array<{ name: string; relation: string; ecosystem: string }>) {
    const allowlist: Record<string, string[]> = { npm: [], pypi: [] };
    const agent = { id: "a1", ownerId: "owner", kind: "coding", codingProfile: { packageAllowlist: allowlist } };
    const db = {
      resourceGrant: fakeResourceGrants([]),
      agent: { findUnique: async () => agent },
      run: {
        findUnique: async () => ({ id: "r1", agentId: "a1", triggeredById: "owner" }),
        findMany: async () => [],
      },
      codingRun: { findUnique: async () => ({ runId: "r1" }) },
      registryAuditRecord: {
        findMany: async () => records.map((record) => ({ runId: "r1", version: "1.0.0", ...record })),
      },
      codingAgentProfile: {
        update: async ({ data }: { data: { packageAllowlist: Record<string, string[]> } }) => {
          agent.codingProfile = { packageAllowlist: data.packageAllowlist };
          return agent.codingProfile;
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    };
    const mcp = buildMcpServer({
      providers: {} as never,
      db: db as never,
      config: { canonicalUri: "https://host/mcp" },
    });
    const ctx: McpRequestContext = {
      principal: { id: "owner", subject: "owner", createdAt: new Date() },
      scopes: new Set(["agents:write", "packages:approve"]),
      roles: ["admin"],
      canonicalUri: "https://host/mcp",
      providers: {} as never,
      db: db as never,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    };
    mcp.setFixedContext(ctx);
    registerPackageTools(mcp);
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "release", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "approve_audited_packages", arguments: args });
      return (result.content as { text: string }[])[0].text;
    };
    return { call, allowlist: () => agent.codingProfile.packageAllowlist, close: () => client.close() };
  }

  it("for random audit records: without names only top-level names are added; a named unknown one is", async () => {
    await forAll("packages.approve", 40, async (r) => {
      const relations = ["top-level", "transitive", "unknown", "allowed"];
      const records = Array.from({ length: r.int(1, 8) }, () => ({
        name: `p${r.int(0, 5)}`,
        relation: r.pick(relations),
        ecosystem: r.pick(["npm", "pypi"]),
      }));
      const topLevel = new Set(
        records.filter((x) => x.relation === "top-level").map((x) => `${x.ecosystem}:${x.name}`),
      );
      const unknownOnly = records.filter((x) => x.relation === "unknown" && !topLevel.has(`${x.ecosystem}:${x.name}`));

      const tool = await approveTool(records);
      await tool.call({ runId: "r1" });
      const added = Object.entries(tool.allowlist()).flatMap(([eco, names]) => names.map((n) => `${eco}:${n}`));
      expect(new Set(added)).toEqual(topLevel);
      await tool.close();

      if (unknownOnly.length > 0) {
        const named = r.pick(unknownOnly);
        const again = await approveTool(records);
        await again.call({ runId: "r1", names: [named.name] });
        expect(again.allowlist()[named.ecosystem]).toContain(named.name);
        await again.close();
      }
    });
  });
});

describe("package policy: a lockfile written through the proxy is collected without the proxy", () => {
  it("every format, for random graphs: no proxy URL and no registry token, and exactly what a public install writes", async () => {
    await forAll("packages.collect", 8, async (r) => {
      const g = graph(r);
      sweep = secretSweep(r.int(1, 1e6));
      const token = `rrg_${sweep.plant("registry token", "opaque")}`;
      const workspace = await mkdtemp(join(tmpdir(), "wardby-release-lockfiles-"));
      try {
        const files: Array<[string, string, string]> = [
          ["package-lock.json", npmLockfile(g, "package-lock", true), npmLockfile(g, "package-lock")],
          ["pnpm9/pnpm-lock.yaml", npmLockfile(g, "pnpm-v9", true), npmLockfile(g, "pnpm-v9")],
          ["classic/yarn.lock", npmLockfile(g, "yarn-classic", true), npmLockfile(g, "yarn-classic")],
          ["berry/yarn.lock", npmLockfile(g, "yarn-berry", true), npmLockfile(g, "yarn-berry")],
          ["py/uv.lock", pypiLockfile(g, "uv.lock", true, token), pypiLockfile(g, "uv.lock")],
        ];
        for (const [path, proxied] of files) {
          await mkdir(join(workspace, path, ".."), { recursive: true });
          await writeFile(join(workspace, path), proxied);
        }
        await normalizeRegistryLockfiles({ workspace, proxyBaseUrl: PROXY_BASE });
        for (const [path, , expected] of files) {
          const collected = await readFile(join(workspace, path), "utf8");
          sweep.record(`collected ${path}`, collected);
          expect(collected, path).not.toContain("wardby-proxy");
          expect(collected, path).toBe(expected);
        }
        sweep.assertClean();
      } finally {
        await rm(workspace, { recursive: true, force: true });
        sweep.dispose();
      }
    });
  });
});
