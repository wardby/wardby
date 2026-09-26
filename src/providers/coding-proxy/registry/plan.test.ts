/**
 * Lockfile verification (`POST /registry/npm/-/plan`) and the approved
 * download path, through RegistryService with the real npm adapter against
 * a fake npm registry: per-version documents, full packuments (for publish
 * times) and tarballs.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { npmAdapter } from "../../../coding/registry/npm.js";
import { RegistryError, type UpstreamFetch } from "../../../coding/registry/types.js";
import { capabilityHash } from "../proxy.js";
import type { AuditedVersion, WithheldVersions } from "./audit.js";
import { RegistryService, type RegistryResponse } from "./service.js";
import { MemoryRegistryStore } from "./store.js";

const DAY = 86_400_000;
const NOW = new Date("2026-09-25T00:00:00Z");
const OLD = new Date(NOW.getTime() - 30 * DAY).toISOString();
const NEW = new Date(NOW.getTime() - DAY).toISOString();

interface FakeVersion {
  deps?: Record<string, string>;
  peer?: Record<string, string>;
  optional?: Record<string, string>;
  published?: string;
}
type FakeRegistry = Record<string, Record<string, FakeVersion>>;

const tarballOf = (name: string, version: string) => new TextEncoder().encode(`tarball ${name}@${version}`);
const sriOf = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const tarballUrl = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/${name.slice(name.indexOf("/") + 1)}-${version}.tgz`;

function fakeNpm(registry: FakeRegistry) {
  const calls: string[] = [];
  const upstream: UpstreamFetch = async (url) => {
    calls.push(url);
    const tarball = Object.entries(registry)
      .flatMap(([name, versions]) => Object.keys(versions).map((version) => ({ name, version })))
      .find(({ name, version }) => tarballUrl(name, version) === url);
    if (tarball) return new Response(tarballOf(tarball.name, tarball.version));
    const match = url.match(/^https:\/\/registry\.npmjs\.org\/([^/]+)(?:\/([^/]+))?$/);
    if (!match) return new Response("no route", { status: 404 });
    const name = decodeURIComponent(match[1]);
    const versions = registry[name];
    if (!versions) return new Response("{}", { status: 404 });
    const manifest = (version: string) => ({
      name,
      version,
      dist: { integrity: sriOf(tarballOf(name, version)), tarball: tarballUrl(name, version) },
      ...(versions[version].deps ? { dependencies: versions[version].deps } : {}),
      ...(versions[version].peer ? { peerDependencies: versions[version].peer } : {}),
      ...(versions[version].optional ? { optionalDependencies: versions[version].optional } : {}),
    });
    if (match[2]) {
      const version = decodeURIComponent(match[2]);
      return versions[version]
        ? Response.json(manifest(version))
        : new Response('"version not found"', { status: 404 });
    }
    return Response.json({
      name,
      versions: Object.fromEntries(Object.keys(versions).map((version) => [version, manifest(version)])),
      time: Object.fromEntries(Object.entries(versions).map(([version, info]) => [version, info.published ?? OLD])),
    });
  };
  return { upstream, calls };
}

/** A lockfile entry for `name@version` as npm writes it, integrity from
 *  the fake registry unless overridden. */
function locked(name: string, version: string, extra: Record<string, unknown> = {}) {
  return {
    version,
    resolved: tarballUrl(name, version),
    integrity: sriOf(tarballOf(name, version)),
    ...extra,
  };
}

function lockfileOf(rootDeps: Record<string, string>, packages: Record<string, unknown>) {
  return JSON.stringify({
    name: "app",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "app", dependencies: rootDeps }, ...packages },
  });
}

function setup(
  registry: FakeRegistry,
  options: {
    allowlist?: string[];
    withheld?: Record<string, string[]>;
    audit?: (versions: readonly AuditedVersion[]) => Promise<WithheldVersions>;
    store?: MemoryRegistryStore;
    upstream?: UpstreamFetch;
    planMaxEntries?: number;
    planTimeoutMs?: number;
  } = {},
) {
  const npm = fakeNpm(registry);
  const store = options.store ?? new MemoryRegistryStore();
  store.contexts.set(capabilityHash("rrg_token"), {
    runId: "run-1",
    deadlineAt: new Date(NOW.getTime() + DAY),
    allowlist: { npm: options.allowlist ?? ["a"] },
    policy: {},
  });
  const audited: AuditedVersion[][] = [];
  const service = new RegistryService({
    adapters: new Map([["npm", npmAdapter]]),
    store,
    audit: {
      audit: async () => ({ withheld: () => [], reported: () => [] }),
      auditVersions: async (_adapter, versions) => {
        audited.push([...versions]);
        if (options.audit) return options.audit(versions);
        return new Map(Object.entries(options.withheld ?? {}));
      },
    },
    upstream: options.upstream ?? npm.upstream,
    proxyBase: "http://wardby-proxy:8787/registry/",
    limits: { maxFileBytes: 1_000_000, maxTotalBytes: 10_000_000, maxFiles: 100, idleTimeoutMs: 1_000 },
    now: () => NOW,
    planMaxEntries: options.planMaxEntries,
    planTimeoutMs: options.planTimeoutMs,
  });
  const plan = async (body: string) => {
    const response = await service.plan({
      ecosystem: "npm",
      token: "rrg_token",
      body,
      signal: new AbortController().signal,
    });
    return { status: response.status, json: JSON.parse((response as { body: string }).body) };
  };
  return { service, store, plan, calls: npm.calls, audited };
}

type PlanBody = { approved: number; refused: { name: string; version: string; code: string }[] };
const refusedOf = (json: PlanBody) =>
  Object.fromEntries(json.refused.map((refusal) => [`${refusal.name}@${refusal.version}`, refusal.code]));
const approvedOf = (store: MemoryRegistryStore) =>
  [...store.approvals.values()].map((approval) => `${approval.name}@${approval.version}`).sort();

const chain: FakeRegistry = {
  a: { "1.0.0": { deps: { b: "^1.0.0" } } },
  b: { "1.1.0": { deps: { c: "~2.0.0" } } },
  c: { "2.0.3": {} },
};
const chainLock = lockfileOf(
  { a: "^1.0.0" },
  {
    "node_modules/a": locked("a", "1.0.0", { dependencies: { b: "^1.0.0" } }),
    "node_modules/b": locked("b", "1.1.0", { dependencies: { c: "~2.0.0" } }),
    "node_modules/c": locked("c", "2.0.3"),
  },
);

describe("lockfile plan verification", () => {
  it("approves a valid lockfile's exact versions and stores their facts", async () => {
    const { plan, store, audited } = setup(chain);
    const { status, json } = await plan(chainLock);
    expect(status).toBe(200);
    expect(json).toEqual({ approved: 3, refused: [] });
    expect(approvedOf(store)).toEqual(["a@1.0.0", "b@1.1.0", "c@2.0.3"]);
    expect(store.facts.size).toBe(3);
    expect(audited).toEqual([
      [
        { name: "a", version: "1.0.0" },
        { name: "b", version: "1.1.0" },
        { name: "c", version: "2.0.3" },
      ],
    ]);
    expect(store.fetches).toEqual([]);
  });

  it("reuses stored facts: a second plan reads nothing from the registry", async () => {
    const store = new MemoryRegistryStore();
    await setup(chain, { store }).plan(chainLock);
    const again = setup(chain, { store });
    expect((await again.plan(chainLock)).json.approved).toBe(3);
    expect(again.calls).toEqual([]);
  });

  it("refuses a forged integrity, and what is reachable only through it", async () => {
    const lock = JSON.parse(chainLock);
    lock.packages["node_modules/b"].integrity = sriOf(new TextEncoder().encode("evil bytes"));
    const { plan, store } = setup(chain);
    const { json } = await plan(JSON.stringify(lock));
    expect(refusedOf(json)).toEqual({
      "b@1.1.0": "wardby_lockfile_integrity_mismatch",
      "c@2.0.3": "wardby_package_not_allowed",
    });
    expect(approvedOf(store)).toEqual(["a@1.0.0"]);
    // Every refusal is recorded once, as a plan refusal.
    expect(store.fetches.map((fetch) => [fetch.name, fetch.version, fetch.reason, fetch.filename])).toEqual([
      ["b", "1.1.0", "wardby_lockfile_integrity_mismatch", "-/plan"],
      ["c", "2.0.3", "wardby_package_not_allowed", "-/plan"],
    ]);
    await plan(JSON.stringify(lock));
    expect(store.fetches).toHaveLength(2);
  });

  it("refuses an entry linked only by a forged edge (a dependency the registry's version does not declare)", async () => {
    const lock = JSON.parse(chainLock);
    lock.packages["node_modules/a"].dependencies.evil = "^1.0.0";
    lock.packages["node_modules/evil"] = locked("evil", "1.0.0");
    const { plan, store, calls } = setup({ ...chain, evil: { "1.0.0": {} } });
    const { json } = await plan(JSON.stringify(lock));
    expect(refusedOf(json)).toEqual({ "evil@1.0.0": "wardby_package_not_allowed" });
    expect(approvedOf(store)).toEqual(["a@1.0.0", "b@1.1.0", "c@2.0.3"]);
    // An unreachable entry costs nothing upstream.
    expect(calls.some((url) => url.includes("evil"))).toBe(false);
  });

  it("refuses a child outside its parent's declared range", async () => {
    const registry: FakeRegistry = { ...chain, c: { "2.0.3": {}, "2.1.0": {} } };
    const lock = JSON.parse(chainLock);
    lock.packages["node_modules/c"] = locked("c", "2.1.0");
    const { json } = await setup(registry).plan(JSON.stringify(lock));
    expect(refusedOf(json)).toEqual({ "c@2.1.0": "wardby_package_not_allowed" });
  });

  it("refuses an entry nothing reaches, and a root outside its allowlist range", async () => {
    const lock = JSON.parse(chainLock);
    lock.packages["node_modules/stray"] = locked("stray", "1.0.0");
    const unreachable = await setup({ ...chain, stray: { "1.0.0": {} } }).plan(JSON.stringify(lock));
    expect(refusedOf(unreachable.json)).toEqual({ "stray@1.0.0": "wardby_package_not_allowed" });

    const outOfRange = await setup(chain, { allowlist: ["a@^2"] }).plan(chainLock);
    expect(outOfRange.json.approved).toBe(0);
    expect(Object.values(refusedOf(outOfRange.json))).toEqual([
      "wardby_package_not_allowed",
      "wardby_package_not_allowed",
      "wardby_package_not_allowed",
    ]);
  });

  it("starts from scope wildcard roots and from aliased root dependencies", async () => {
    const registry: FakeRegistry = { "@s/ui": { "1.0.0": { deps: { dep: "^1" } } }, dep: { "1.0.0": {} } };
    const lock = lockfileOf(
      { ui: "npm:@s/ui@^1" },
      { "node_modules/ui": { name: "@s/ui", ...locked("@s/ui", "1.0.0") }, "node_modules/dep": locked("dep", "1.0.0") },
    );
    const { json } = await setup(registry, { allowlist: ["@s/*"] }).plan(lock);
    expect(json).toEqual({ approved: 2, refused: [] });
  });

  it("follows nesting, aliases and peer dependencies, and ignores declared dependencies not installed", async () => {
    const registry: FakeRegistry = {
      a: { "1.0.0": { deps: { dep: "^1", "b-cjs": "npm:b@^2" }, peer: { react: ">=18" }, optional: { opt: "^1" } } },
      dep: { "1.0.0": {}, "2.0.0": {} },
      b: { "2.0.0": {} },
      react: { "19.0.0": {} },
      top: { "1.0.0": { deps: { dep: "^2" } } },
    };
    const lock = lockfileOf(
      { a: "^1", top: "^1" },
      {
        "node_modules/a": locked("a", "1.0.0"),
        "node_modules/a/node_modules/dep": locked("dep", "1.0.0"),
        "node_modules/dep": locked("dep", "2.0.0"),
        "node_modules/b-cjs": { name: "b", ...locked("b", "2.0.0") },
        "node_modules/react": locked("react", "19.0.0", { peer: true }),
        "node_modules/top": locked("top", "1.0.0"),
      },
    );
    const { json, status } = await setup(registry, { allowlist: ["a", "top"] }).plan(lock);
    expect(status).toBe(200);
    expect(json).toEqual({ approved: 6, refused: [] });
  });

  it("refuses a version newer than the release-age limit", async () => {
    const registry: FakeRegistry = { ...chain, b: { "1.1.0": { deps: { c: "~2.0.0" }, published: NEW } } };
    const { json, store } = await (async () => {
      const s = setup(registry);
      return { json: (await s.plan(chainLock)).json, store: s.store };
    })();
    expect(refusedOf(json)).toEqual({ "b@1.1.0": "wardby_version_filtered", "c@2.0.3": "wardby_package_not_allowed" });
    expect(approvedOf(store)).toEqual(["a@1.0.0"]);
  });

  it("refuses a version with a HIGH advisory; a refusal only blocks what depends on it", async () => {
    // a -> b -> c and a -> d -> c: withholding b leaves c reachable through d.
    const registry: FakeRegistry = {
      a: { "1.0.0": { deps: { b: "^1", d: "^1" } } },
      b: { "1.0.0": { deps: { c: "^1", onlyb: "^1" } } },
      d: { "1.0.0": { deps: { c: "^1" } } },
      c: { "1.0.0": {} },
      onlyb: { "1.0.0": {} },
    };
    const lock = lockfileOf(
      { a: "^1" },
      Object.fromEntries(["a", "b", "c", "d", "onlyb"].map((name) => [`node_modules/${name}`, locked(name, "1.0.0")])),
    );
    const { plan, store } = setup(registry, { withheld: { "b@1.0.0": ["GHSA-high"] } });
    const { json } = await plan(lock);
    expect(refusedOf(json)).toEqual({
      "b@1.0.0": "wardby_version_filtered",
      "onlyb@1.0.0": "wardby_package_not_allowed",
    });
    expect(approvedOf(store)).toEqual(["a@1.0.0", "c@1.0.0", "d@1.0.0"]);
    expect(json.refused.find((refusal: { name: string }) => refusal.name === "b").reason).toContain("GHSA-high");
  });

  it("refuses non-registry entries, and never approves or refuses bundled ones", async () => {
    const lock = JSON.parse(chainLock);
    lock.packages["node_modules/gitdep"] = { version: "1.0.0", resolved: "git+https://github.com/x/y.git#abc" };
    lock.packages["node_modules/a/node_modules/inner"] = { version: "1.0.0", inBundle: true };
    const { json } = await setup(chain).plan(JSON.stringify(lock));
    expect(refusedOf(json)).toEqual({ "gitdep@1.0.0": "wardby_lockfile_entry_unsupported" });
    expect(json.approved).toBe(3);
  });

  it("refuses an entry the registry cannot be read for, and approves the rest", async () => {
    const npm = fakeNpm(chain);
    const upstream: UpstreamFetch = async (url, init) =>
      url === "https://registry.npmjs.org/c/2.0.3" ? new Response("", { status: 503 }) : npm.upstream(url, init);
    const { json, store } = await (async () => {
      const s = setup(chain, { upstream });
      return { json: (await s.plan(chainLock)).json, store: s.store };
    })();
    expect(refusedOf(json)).toEqual({ "c@2.0.3": "wardby_upstream_error" });
    expect(approvedOf(store)).toEqual(["a@1.0.0", "b@1.1.0"]);
  });

  it("fails the whole plan closed when OSV is unavailable", async () => {
    const { plan, store } = setup(chain, {
      audit: async () => {
        throw new RegistryError(503, "wardby_audit_unavailable", "OSV down");
      },
    });
    const { status, json } = await plan(chainLock);
    expect(status).toBe(503);
    expect(json.error).toContain("wardby_audit_unavailable");
    expect(store.approvals.size).toBe(0);
  });

  it("refuses lockfile v1, too many entries and a bad token", async () => {
    const v1 = await setup(chain).plan(JSON.stringify({ lockfileVersion: 1, dependencies: {} }));
    expect([v1.status, v1.json.error]).toEqual([400, expect.stringContaining("wardby_lockfile_unsupported")]);
    const tooMany = await setup(chain, { planMaxEntries: 2 }).plan(chainLock);
    expect([tooMany.status, tooMany.json.error]).toEqual([413, expect.stringContaining("wardby_lockfile_too_large")]);
    const { service } = setup(chain);
    const bad = await service.plan({
      ecosystem: "npm",
      token: "nope",
      body: chainLock,
      signal: new AbortController().signal,
    });
    expect(bad.status).toBe(401);
  });

  it("runs one plan per run at a time", async () => {
    const npm = fakeNpm(chain);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const upstream: UpstreamFetch = async (url, init) => {
      await gate;
      return npm.upstream(url, init);
    };
    const { plan } = setup(chain, { upstream });
    const first = plan(chainLock);
    const second = await plan(chainLock);
    expect([second.status, second.json.error]).toEqual([429, expect.stringContaining("wardby_plan_in_progress")]);
    release();
    expect((await first).json.approved).toBe(3);
    expect((await plan(chainLock)).status).toBe(200);
  });

  it("stops at its time bound with a retryable 503, keeping what it verified", async () => {
    const npm = fakeNpm(chain);
    const upstream: UpstreamFetch = async (url, init) =>
      url === "https://registry.npmjs.org/b/1.1.0"
        ? new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error), { once: true }),
          )
        : npm.upstream(url, init);
    const { plan, store } = setup(chain, { upstream, planTimeoutMs: 50 });
    const { status, json } = await plan(chainLock);
    expect(status).toBe(503);
    expect(json.error).toContain("wardby_plan_incomplete");
    expect(store.approvals.size).toBe(0);
    expect([...store.facts.values()].map((fact) => fact.name)).toEqual(["a"]);
  });
});

async function drain(response: RegistryResponse): Promise<string> {
  if ("body" in response) return response.body;
  return new Response(response.stream).text();
}

describe("downloads of approved versions", () => {
  const download = (name: string, version: string) => ({
    method: "GET",
    ecosystem: "npm",
    subpath: `${name}/-/${name}-${version}.tgz`,
    token: "rrg_token",
    signal: new AbortController().signal,
  });

  it("serves an approved version directly: no metadata, no graph walk", async () => {
    const { plan, service, store, calls } = setup(chain);
    await plan(chainLock);
    calls.length = 0;
    const response = await service.handle(download("c", "2.0.3"));
    expect(response.status).toBe(200);
    expect(await drain(response)).toBe("tarball c@2.0.3");
    expect(calls).toEqual([tarballUrl("c", "2.0.3")]);
    expect(store.fetches.at(-1)).toMatchObject({ name: "c", version: "2.0.3", outcome: "served" });
  });

  it("checks the download against the approved integrity", async () => {
    const npm = fakeNpm(chain);
    let tamper = false;
    const upstream: UpstreamFetch = async (url, init) =>
      tamper && url.endsWith(".tgz") ? new Response("tampered") : npm.upstream(url, init);
    const { plan, service, store } = setup(chain, { upstream });
    await plan(chainLock);
    tamper = true;
    const response = await service.handle(download("c", "2.0.3"));
    await expect(drain(response)).rejects.toThrow();
    expect(store.fetches.at(-1)).toMatchObject({ name: "c", outcome: "refused", reason: "wardby_integrity_mismatch" });
  });

  it("sends an unapproved version of an approved name down the usual path", async () => {
    const registry: FakeRegistry = { ...chain, c: { "2.0.3": {}, "3.0.0": {} } };
    const { plan, service, calls } = setup(registry);
    await plan(chainLock);
    calls.length = 0;
    const response = await service.handle(download("c", "3.0.0"));
    // Not approved: the allowlist, the graph walk and the version filter
    // decide it from metadata, as for any install without a plan (the walk
    // approves names, so c's other kept versions are served).
    expect(response.status).toBe(200);
    expect(calls).toEqual(
      expect.arrayContaining([
        "https://registry.npmjs.org/a",
        "https://registry.npmjs.org/c",
        tarballUrl("c", "3.0.0"),
      ]),
    );
  });
});
