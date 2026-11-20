import { describe, expect, it, vi } from "vitest";
import { createRegistryAdapters } from "./adapters.js";
import { loadJfrogRegistryConfig } from "./jfrog.js";
import { createNpmAdapter, npmAdapter } from "./npm.js";
import { normalizeNpmLockfile } from "./npm-lockfile.js";
import { normalizePnpmLockfile, parsePnpmLockfile } from "./pnpm-lockfile.js";
import { normalizeYarnLockfile, parseYarnLockfile } from "./yarn-lockfile.js";
import { createNpmClientLockfilePlan, createNpmClientLockfiles } from "./npm-lockfile-formats.js";
import { createPypiAdapter, pypiAdapter } from "./pypi.js";
import { jfrogNpmRegistry } from "./jfrog.js";
import type { UpstreamFetch } from "./types.js";

const jfrog = loadJfrogRegistryConfig({
  REGISTRY_JFROG_URL: "https://example.jfrog.io/acme",
  REGISTRY_JFROG_NPM_REPO: "npm-local",
  REGISTRY_JFROG_NPM_SCOPES: "@acme",
  REGISTRY_JFROG_PYPI_REPO: "pypi",
});
const PRIVATE = "https://example.jfrog.io/acme/api/npm/npm-local/";
const PROXY = "http://wardby-proxy:8787/registry/npm/";
const privateRegistry = jfrogNpmRegistry(jfrog)!;
const adapter = createNpmAdapter(jfrog);

function packument(name: string, tarball: string) {
  return {
    name,
    "dist-tags": { latest: "1.0.0" },
    time: { "1.0.0": "2020-01-01T00:00:00.000Z" },
    versions: { "1.0.0": { name, version: "1.0.0", dist: { tarball, integrity: "sha512-AAAA" } } },
  };
}

describe("npm adapter with a JFrog registry", () => {
  it("reads a scoped name only from JFrog and every other name only from public npm", async () => {
    const urls: string[] = [];
    const upstream: UpstreamFetch = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(packument("x", "https://example.jfrog.io/x.tgz")));
    };
    await adapter.fetchMetadata("@acme/ui", upstream);
    await adapter.fetchMetadata("left-pad", upstream);
    await adapter.fetchMetadata("@other/pkg", upstream);
    expect(urls).toEqual([
      `${PRIVATE}@acme%2fui`,
      "https://registry.npmjs.org/left-pad",
      "https://registry.npmjs.org/@other%2fpkg",
    ]);
  });

  it("allows each name's downloads only from that name's own host", () => {
    expect(adapter.upstreamHosts).toEqual(["registry.npmjs.org", "example.jfrog.io"]);
    expect(adapter.hostsFor?.("@acme/ui")).toEqual(["example.jfrog.io"]);
    expect(adapter.hostsFor?.("left-pad")).toEqual(["registry.npmjs.org"]);
    expect(adapter.hostsFor?.("@other/pkg")).toEqual(["registry.npmjs.org"]);
    expect(adapter.isPrivateName?.("@acme/ui")).toBe(true);
    expect(adapter.isPrivateName?.("@acme-evil/ui")).toBe(false);
    expect(adapter.isPrivateName?.("left-pad")).toBe(false);
  });

  it("is unchanged without a JFrog configuration", () => {
    expect(npmAdapter.upstreamHosts).toEqual(["registry.npmjs.org"]);
    expect(npmAdapter.hostsFor).toBeUndefined();
    expect(npmAdapter.isPrivateName).toBeUndefined();
    expect(npmAdapter.lockfilePlan?.privateRegistry).toBeUndefined();
  });

  it("reads a scoped name's version facts and publish times from JFrog", async () => {
    const urls: string[] = [];
    const upstream: UpstreamFetch = async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify({ name: "@acme/ui", version: "1.0.0", dist: { tarball: `${PRIVATE}@acme/ui/-/ui-1.0.0.tgz` } }),
      );
    };
    const plan = adapter.lockfilePlan!;
    expect(plan.privateRegistry).toEqual(privateRegistry);
    await plan.fetchVersionFact("@acme/ui", "1.0.0", upstream);
    await plan.fetchVersionFact("left-pad", "1.0.0", async (url) => {
      urls.push(url);
      return new Response("{}", { status: 404 });
    });
    expect(urls).toEqual([`${PRIVATE}@acme%2fui/1.0.0`, "https://registry.npmjs.org/left-pad/1.0.0"]);
  });
});

describe("npm lockfile plan parsing with a JFrog registry", () => {
  const options = { maxEntries: 100, proxyRegistryUrl: PROXY, privateRegistry };
  const lock = (entries: Record<string, { resolved: string; name?: string }>) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: Object.fromEntries(
        Object.entries(entries).map(([path, value]) => [path, { version: "1.0.0", integrity: "sha512-x", ...value }]),
      ),
    });
  const kinds = (body: string) =>
    Object.fromEntries(
      createNpmClientLockfilePlan(privateRegistry)
        .parse(body, options)
        .entries.map((entry) => [entry.name, entry.kind]),
    );

  it("accepts JFrog only for scoped names and public npm only for the rest", () => {
    expect(
      kinds(
        lock({
          "node_modules/@acme/ui": { resolved: `${PRIVATE}@acme/ui/-/ui-1.0.0.tgz` },
          "node_modules/left-pad": { resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz" },
        }),
      ),
    ).toEqual({ "@acme/ui": "registry", "left-pad": "registry" });
  });

  it("refuses a scoped name that records public npm, and a public name that records JFrog", () => {
    expect(
      kinds(
        lock({
          "node_modules/@acme/ui": { resolved: "https://registry.npmjs.org/@acme/ui/-/ui-1.0.0.tgz" },
          "node_modules/left-pad": { resolved: `${PRIVATE}left-pad/-/left-pad-1.0.0.tgz` },
        }),
      ),
    ).toEqual({ "@acme/ui": "unsupported", "left-pad": "unsupported" });
  });

  it("refuses JFrog URLs when no private registry is configured", () => {
    const body = lock({ "node_modules/@acme/ui": { resolved: `${PRIVATE}@acme/ui/-/ui-1.0.0.tgz` } });
    const parsed = createNpmClientLockfilePlan().parse(body, { maxEntries: 100, proxyRegistryUrl: PROXY });
    expect(parsed.entries[0].kind).toBe("unsupported");
  });

  it("applies the same per-name rule to pnpm and yarn classic lockfiles", () => {
    const pnpm = `lockfileVersion: '9.0'
packages:
  '@acme/ui@1.0.0':
    resolution: {integrity: sha512-x, tarball: ${PRIVATE}@acme/ui/-/ui-1.0.0.tgz}
  left-pad@1.0.0:
    resolution: {integrity: sha512-y}
snapshots:
  '@acme/ui@1.0.0': {}
  left-pad@1.0.0: {}
`;
    expect(parsePnpmLockfile(pnpm, options).entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["@acme/ui", "registry"],
      ["left-pad", "registry"],
    ]);
    const wrongPnpm = pnpm.replace("tarball: " + PRIVATE, "tarball: https://registry.npmjs.org/");
    expect(parsePnpmLockfile(wrongPnpm, options).entries[0].kind).toBe("unsupported");

    const yarn = `# yarn lockfile v1


"@acme/ui@^1.0.0":
  version "1.0.0"
  resolved "${PRIVATE}@acme/ui/-/ui-1.0.0.tgz#abc"
  integrity sha512-x

left-pad@^1.0.0:
  version "1.0.0"
  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.0.0.tgz#def"
  integrity sha512-y
`;
    expect(parseYarnLockfile(yarn, options).entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["@acme/ui", "registry"],
      ["left-pad", "registry"],
    ]);
  });
});

describe("lockfile normalization with a JFrog registry", () => {
  const lockfiles = createNpmClientLockfiles(privateRegistry);

  it("rewrites package-lock.json per package: scoped names to JFrog, others to public npm", () => {
    const before = JSON.stringify({
      packages: {
        "node_modules/@acme/ui": { resolved: `${PROXY}@acme/ui/-/ui-1.0.0.tgz` },
        "node_modules/left-pad": { resolved: `${PROXY}left-pad/-/left-pad-1.0.0.tgz` },
      },
    });
    const after = lockfiles.normalize(before, PROXY, "package-lock.json");
    expect(after).toContain(`"${PRIVATE}@acme/ui/-/ui-1.0.0.tgz"`);
    expect(after).toContain('"https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz"');
    // With no private registry the same scoped name goes to public npm, as before.
    expect(normalizeNpmLockfile(before, PROXY)).toContain('"https://registry.npmjs.org/@acme/ui/-/ui-1.0.0.tgz"');
  });

  it("keeps a private scope's pnpm tarball (rewritten to JFrog) but still drops a public one", () => {
    const before = [
      "packages:",
      `  '@acme/ui@1.0.0':`,
      `    resolution: {integrity: sha512-x, tarball: ${PROXY}@acme/ui/-/ui-1.0.0.tgz}`,
      "  left-pad@1.0.0:",
      `    resolution: {integrity: sha512-y, tarball: ${PROXY}left-pad/-/left-pad-1.0.0.tgz}`,
      "",
    ].join("\n");
    expect(normalizePnpmLockfile(before, PROXY, privateRegistry)).toBe(
      [
        "packages:",
        `  '@acme/ui@1.0.0':`,
        `    resolution: {integrity: sha512-x, tarball: ${PRIVATE}@acme/ui/-/ui-1.0.0.tgz}`,
        "  left-pad@1.0.0:",
        "    resolution: {integrity: sha512-y}",
        "",
      ].join("\n"),
    );
  });

  it("rewrites yarn classic per package, keeping the hash fragment", () => {
    const before = [
      "# yarn lockfile v1",
      "",
      '"@acme/ui@^1.0.0":',
      '  version "1.0.0"',
      `  resolved "${PROXY}@acme/ui/-/ui-1.0.0.tgz#abc"`,
      "",
      "left-pad@^1.0.0:",
      '  version "1.0.0"',
      `  resolved "${PROXY}left-pad/-/left-pad-1.0.0.tgz#def"`,
      "",
    ].join("\n");
    const after = normalizeYarnLockfile(before, PROXY, privateRegistry);
    expect(after).toContain(`resolved "${PRIVATE}@acme/ui/-/ui-1.0.0.tgz#abc"`);
    expect(after).toContain('resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.0.0.tgz#def"');
  });
});

describe("PyPI adapter with a JFrog registry", () => {
  const pypi = createPypiAdapter(jfrog);

  it("replaces the public index and hosts", async () => {
    expect(pypi.upstreamHosts).toEqual(["example.jfrog.io"]);
    expect(pypiAdapter.upstreamHosts).toEqual(["pypi.org", "files.pythonhosted.org"]);
    const upstream = vi.fn<UpstreamFetch>(async () => new Response(JSON.stringify({ name: "requests", files: [] })));
    await pypi.fetchMetadata("requests", upstream);
    expect(upstream.mock.calls[0][0]).toBe("https://example.jfrog.io/acme/api/pypi/pypi/simple/requests/");
  });

  it("says so when the index answers HTML instead of the JSON Simple API", async () => {
    const upstream: UpstreamFetch = async () =>
      new Response("<html></html>", { headers: { "content-type": "text/html" } });
    await expect(pypi.fetchMetadata("requests", upstream)).rejects.toThrow(/PEP 691/);
  });
});

describe("createRegistryAdapters", () => {
  it("builds both adapters from one JFrog configuration, and the public default without one", () => {
    expect(createRegistryAdapters(jfrog).get("npm")?.hostsFor).toBeDefined();
    expect(createRegistryAdapters().get("npm")?.hostsFor).toBeUndefined();
  });
});
