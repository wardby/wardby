import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  declaredDependencies,
  fetchNpmPublishTimes,
  fetchNpmVersionFact,
  npmEdgeSatisfies,
  parseNpmLockfile,
  registryDependencyEdges,
} from "./npm-plan.js";
import { RegistryError, type UpstreamFetch } from "./types.js";

const PROXY = "http://wardby-proxy:8787/registry/npm/";
const parse = (lock: unknown, maxEntries = 100) =>
  parseNpmLockfile(JSON.stringify(lock), { maxEntries, proxyRegistryUrl: PROXY });
const reg = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;

const lockfile = {
  name: "app",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "app",
      dependencies: { a: "^1.0.0", "b-alias": "npm:b@^2.0.0" },
      devDependencies: { d: "1.0.0" },
    },
    "node_modules/a": { version: "1.2.0", resolved: reg("a", "1.2.0"), integrity: "sha512-a" },
    "node_modules/a/node_modules/c": { version: "2.0.0", resolved: reg("c", "2.0.0"), integrity: "sha512-c2" },
    "node_modules/c": { version: "1.0.0", resolved: `${PROXY}c/-/c-1.0.0.tgz`, integrity: "sha512-c1" },
    "node_modules/b-alias": { name: "b", version: "2.1.0", resolved: reg("b", "2.1.0"), integrity: "sha512-b" },
    "node_modules/d": { version: "1.0.0", integrity: "sha512-d", dev: true },
    "node_modules/@s/e": { version: "1.0.0", resolved: reg("@s/e", "1.0.0"), integrity: "sha512-e" },
    "node_modules/git-dep": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/y.git#abc" },
    "node_modules/tarball-dep": { version: "1.0.0", resolved: "https://example.com/t.tgz" },
    "node_modules/weird": { version: "latest", resolved: reg("weird", "1.0.0") },
    "node_modules/local": { resolved: "packages/local", link: true },
    "packages/local": { name: "local", version: "0.0.0", dependencies: { a: "^1.0.0" } },
    "node_modules/bundler": { version: "1.0.0", resolved: reg("bundler", "1.0.0"), integrity: "sha512-x" },
    "node_modules/bundler/node_modules/inner": { version: "1.0.0", inBundle: true },
  },
};

describe("parseNpmLockfile", () => {
  it("classifies entries: registry (public or proxy URL, or none), bundled, and unsupported", () => {
    const parsed = parse(lockfile);
    const kinds = Object.fromEntries(parsed.entries.map((entry) => [entry.path, entry.kind]));
    expect(kinds).toEqual({
      "node_modules/a": "registry",
      "node_modules/a/node_modules/c": "registry",
      "node_modules/c": "registry",
      "node_modules/b-alias": "registry",
      "node_modules/d": "registry",
      "node_modules/@s/e": "registry",
      "node_modules/git-dep": "unsupported",
      "node_modules/tarball-dep": "unsupported",
      "node_modules/weird": "unsupported",
      "node_modules/bundler": "registry",
      "node_modules/bundler/node_modules/inner": "bundled",
    });
    const alias = parsed.entries.find((entry) => entry.path === "node_modules/b-alias");
    expect(alias).toMatchObject({ name: "b", version: "2.1.0", integrity: "sha512-b" });
  });

  it("collects the root and workspace projects with every kind of declared dependency, aliases resolved", () => {
    const parsed = parse(lockfile);
    expect(parsed.projects).toEqual([
      {
        path: "",
        dependencies: [
          { key: "a", name: "a", range: "^1.0.0" },
          { key: "b-alias", name: "b", range: "^2.0.0" },
          { key: "d", name: "d", range: "1.0.0" },
        ],
      },
      { path: "packages/local", dependencies: [{ key: "a", name: "a", range: "^1.0.0" }] },
    ]);
  });

  it("resolves a dependency as npm does: the nearest ancestor node_modules folder", () => {
    const parsed = parse(lockfile);
    expect(parsed.resolve("node_modules/a", "c")?.path).toBe("node_modules/a/node_modules/c");
    expect(parsed.resolve("node_modules/b-alias", "c")?.path).toBe("node_modules/c");
    expect(parsed.resolve("", "c")?.path).toBe("node_modules/c");
    expect(parsed.resolve("node_modules/@s/e", "a")?.path).toBe("node_modules/a");
    expect(parsed.resolve("packages/local", "a")?.path).toBe("node_modules/a");
    // A peer or optional dependency the lockfile does not install resolves to nothing.
    expect(parsed.resolve("node_modules/a", "missing-peer")).toBeUndefined();
    // A dependency on a workspace link is local, never a registry entry.
    expect(parsed.resolve("", "local")).toBeUndefined();
  });

  it("refuses lockfile v1, a lockfile without packages, and invalid JSON", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof RegistryError ? [error.status, error.code] : error;
      }
      return "no error";
    };
    expect(code(() => parse({ lockfileVersion: 1, dependencies: {} }))).toEqual([400, "wardby_lockfile_unsupported"]);
    expect(code(() => parse({ lockfileVersion: 3 }))).toEqual([400, "wardby_lockfile_unsupported"]);
    expect(code(() => parseNpmLockfile("{", { maxEntries: 5, proxyRegistryUrl: PROXY }))).toEqual([
      400,
      "wardby_bad_request",
    ]);
  });

  it("refuses a lockfile with more entries than the bound", () => {
    expect(() => parse(lockfile, 5)).toThrow(
      expect.objectContaining({ status: 413, code: "wardby_lockfile_too_large" }),
    );
  });
});

describe("registry dependency declarations", () => {
  it("keeps install folders and alias targets, drops non-registry specs", () => {
    expect(
      registryDependencyEdges({
        a: "^1",
        "x-cjs": "npm:x@^4",
        tag: "latest",
        git: "github:u/r",
        file: "file:../f",
        bare: "npm:y",
      }),
    ).toEqual([
      { key: "a", name: "a", range: "^1" },
      { key: "x-cjs", name: "x", range: "^4" },
      { key: "tag", name: "tag", range: "*" },
      { key: "bare", name: "y", range: "*" },
    ]);
  });

  it("merges dependencies, optionalDependencies and peerDependencies once per folder", () => {
    expect(
      declaredDependencies(
        {
          dependencies: { a: "^1", opt: "^2" },
          optionalDependencies: { opt: "^2" },
          peerDependencies: { react: ">=18", a: "^9" },
        },
        ["dependencies", "optionalDependencies", "peerDependencies"],
      ),
    ).toEqual([
      { key: "a", name: "a", range: "^1" },
      { key: "opt", name: "opt", range: "^2" },
      { key: "react", name: "react", range: ">=18" },
    ]);
  });

  it("matches ranges as npm does when reusing a locked version", () => {
    expect(npmEdgeSatisfies("1.2.3", "^1.0.0")).toBe(true);
    expect(npmEdgeSatisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(npmEdgeSatisfies("1.0.0-rc.1", "*")).toBe(true);
    expect(npmEdgeSatisfies("1.0.0", "not a range")).toBe(false);
  });
});

function upstreamOf(routes: Record<string, () => Response>): UpstreamFetch & { calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  }) as UpstreamFetch & { calls: string[] };
  fetch.calls = calls;
  return fetch;
}

describe("fetchNpmVersionFact", () => {
  it("reads integrity, the tarball URL and declared dependencies from the per-version document", async () => {
    const upstream = upstreamOf({
      "https://registry.npmjs.org/@s%2fe/1.0.0": () =>
        Response.json({
          name: "@s/e",
          version: "1.0.0",
          dist: { integrity: "sha512-e", tarball: "https://registry.npmjs.org/@s/e/-/e-1.0.0.tgz" },
          dependencies: { a: "^1" },
          optionalDependencies: { o: "^1" },
          peerDependencies: { p: "^1" },
          devDependencies: { never: "^1" },
        }),
    });
    expect(await fetchNpmVersionFact("@s/e", "1.0.0", upstream)).toEqual({
      name: "@s/e",
      version: "1.0.0",
      publishedAt: null,
      integrity: "sha512-e",
      downloadUrl: "https://registry.npmjs.org/@s/e/-/e-1.0.0.tgz",
      dependencies: [
        { key: "a", name: "a", range: "^1" },
        { key: "o", name: "o", range: "^1" },
        { key: "p", name: "p", range: "^1" },
      ],
    });
  });

  it("falls back to the sha1 shasum in SRI form, and is null for a missing or mismatched version", async () => {
    const shasum = "a".repeat(40);
    const upstream = upstreamOf({
      "https://registry.npmjs.org/old/0.1.0": () =>
        Response.json({ name: "old", version: "0.1.0", dist: { shasum, tarball: "https://registry.npmjs.org/x" } }),
      "https://registry.npmjs.org/tagged/1.0.0": () => Response.json({ name: "tagged", version: "2.0.0", dist: {} }),
    });
    expect((await fetchNpmVersionFact("old", "0.1.0", upstream))?.integrity).toBe(
      `sha1-${Buffer.from(shasum, "hex").toString("base64")}`,
    );
    expect(await fetchNpmVersionFact("tagged", "1.0.0", upstream)).toBeNull();
    expect(await fetchNpmVersionFact("absent", "1.0.0", upstream)).toBeNull();
  });

  it("throws on an upstream error", async () => {
    const upstream = upstreamOf({ "https://registry.npmjs.org/a/1.0.0": () => new Response("", { status: 500 }) });
    await expect(fetchNpmVersionFact("a", "1.0.0", upstream)).rejects.toMatchObject({ code: "wardby_upstream_error" });
  });
});

describe("fetchNpmPublishTimes", () => {
  const packument = JSON.stringify({
    name: "a",
    versions: { "1.0.0": {}, "2.0.0": {} },
    time: { created: "2019-01-01T00:00:00Z", "1.0.0": "2020-01-01T00:00:00Z", "2.0.0": "bad" },
  });
  const signal = new AbortController().signal;

  it("streams the package document (gzip or not) and returns the wanted versions' times", async () => {
    for (const response of [
      () => new Response(gzipSync(packument), { headers: { "content-encoding": "gzip" } }),
      () => new Response(packument),
    ]) {
      const upstream = upstreamOf({ "https://registry.npmjs.org/a": response });
      const times = await fetchNpmPublishTimes("a", ["1.0.0", "2.0.0", "3.0.0"], upstream, {
        maxBytes: 1e6,
        signal,
      });
      expect([...times]).toEqual([["1.0.0", new Date("2020-01-01T00:00:00Z")]]);
    }
  });

  it("bounds the decompressed size", async () => {
    const upstream = upstreamOf({
      "https://registry.npmjs.org/a": () =>
        new Response(gzipSync(packument), { headers: { "content-encoding": "gzip" } }),
    });
    await expect(fetchNpmPublishTimes("a", ["1.0.0"], upstream, { maxBytes: 50, signal })).rejects.toMatchObject({
      code: "wardby_metadata_too_large",
    });
  });
});
