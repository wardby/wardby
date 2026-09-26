import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { npmAdapter } from "./npm.js";

const fixture = async () =>
  JSON.parse(await readFile(new URL("./fixtures/npm-left-pad.json", import.meta.url), "utf8"));
const upstream = async (body: unknown) => async () => Response.json(body);

describe("npmAdapter allowlist syntax", () => {
  it.each([
    ["react", { name: "react", wildcard: false }],
    ["react@^19", { name: "react", wildcard: false, range: "^19" }],
    ["@heroui/react@^3", { name: "@heroui/react", wildcard: false, range: "^3" }],
    ["@HeroUI/*", { name: "@heroui/", wildcard: true }],
    ["JSONStream", { name: "JSONStream", wildcard: false }],
    ["JSONStream@^1", { name: "JSONStream", wildcard: false, range: "^1" }],
  ])("parses %s", (raw, expected) => {
    expect(npmAdapter.parseAllowlistEntry(raw)).toEqual(expected);
  });
  it.each(["", "react@not-a-range", "../evil", "a b"])("rejects %j", (raw) => {
    expect(() => npmAdapter.parseAllowlistEntry(raw)).toThrow();
  });
});

describe("npmAdapter protocol", () => {
  it("routes packuments, scoped packuments and tarballs", () => {
    expect(npmAdapter.route("GET", "left-pad", new Headers())).toEqual({ kind: "metadata", name: "left-pad" });
    expect(npmAdapter.route("GET", "@heroui%2freact", new Headers())).toEqual({
      kind: "metadata",
      name: "@heroui/react",
    });
    expect(npmAdapter.route("GET", "-/tarball/%40heroui%2Freact/3.2.6", new Headers())).toEqual({
      kind: "download",
      name: "@heroui/react",
      version: "3.2.6",
      filename: "3.2.6.tgz",
    });
    expect(npmAdapter.route("POST", "left-pad", new Headers())).toBeNull();
  });

  it("keeps legacy capitalized names exact: JSONStream is not jsonstream", async () => {
    expect(npmAdapter.normalizeName("JSONStream")).toBe("JSONStream");
    expect(npmAdapter.route("GET", "JSONStream", new Headers())).toEqual({ kind: "metadata", name: "JSONStream" });
    expect(npmAdapter.route("GET", "-/tarball/JSONStream/1.3.5", new Headers())).toMatchObject({
      kind: "download",
      name: "JSONStream",
    });
    const urls: string[] = [];
    const meta = await npmAdapter.fetchMetadata("JSONStream", async (url) => {
      urls.push(url);
      return Response.json({
        name: "JSONStream",
        time: { "1.3.5": "2018-11-14T00:00:00.000Z" },
        versions: {
          "1.3.5": {
            dist: { tarball: "https://registry.npmjs.org/JSONStream/-/JSONStream-1.3.5.tgz" },
            dependencies: { jsonparse: "^1.2.0", Through: "^2.2.7" },
          },
        },
      });
    });
    expect(urls).toEqual(["https://registry.npmjs.org/JSONStream"]);
    expect(meta.name).toBe("JSONStream");
    expect(meta.versions.get("1.3.5")?.dependencies).toEqual(["jsonparse", "Through"]);
  });

  it("parses versions, dates, dependencies and integrity", async () => {
    const meta = await npmAdapter.fetchMetadata("left-pad", await upstream(await fixture()));
    const [first] = [...meta.versions.values()];
    expect(first.files[0].publishedAt).toBeInstanceOf(Date);
    expect(first.files[0].integrity?.algorithm).toBe("sha512");
    expect(first.files[0].upstreamUrl.startsWith("https://registry.npmjs.org/")).toBe(true);
  });

  it("renders only kept versions with tarballs rewritten to the proxy and latest repointed", async () => {
    const meta = await npmAdapter.fetchMetadata("left-pad", await upstream(await fixture()));
    const versions = [...meta.versions.keys()];
    const keep = new Set([versions[0]]);
    const doc = JSON.parse(
      npmAdapter.renderMetadata(meta, keep, new Set([`${versions[0]}.tgz`]), "http://wardby-proxy:8787/registry/npm/")
        .body,
    );
    expect(Object.keys(doc.versions)).toEqual([versions[0]]);
    expect(doc.versions[versions[0]].dist.tarball).toBe(
      `http://wardby-proxy:8787/registry/npm/-/tarball/left-pad/${versions[0]}`,
    );
    expect(doc["dist-tags"].latest).toBe(versions[0]);
  });

  it("keeps only the install manifest fields, not the raw packument", async () => {
    const doc = await fixture();
    doc.readme = "x".repeat(10_000);
    const first = Object.keys(doc.versions)[0];
    doc.versions[first].readme = "y".repeat(10_000);
    doc.versions[first].description = "a description";
    const meta = await npmAdapter.fetchMetadata("left-pad", await upstream(doc));
    const raw = JSON.stringify(meta.raw);
    expect(raw).not.toContain("xxxxxxxxxx");
    expect(raw).not.toContain("yyyyyyyyyy");
    expect(raw).not.toContain("a description");
    expect(raw).toContain('"dist"');
  });

  it("writes an npmrc with the registry token under the cache dir only", () => {
    const config = npmAdapter.workerConfig({
      registryUrl: "http://wardby-proxy:8787/registry/npm/",
      token: "rrg_example",
      cacheDir: "/workspace/.cache/npm",
    });
    expect(config.env.npm_config_ignore_scripts).toBe("true");
    expect(config.env.npm_config_userconfig).toBe("/workspace/.cache/npm/npmrc");
    expect(config.files).toEqual([
      {
        path: "/workspace/.cache/npm/npmrc",
        content: "//wardby-proxy:8787/registry/npm/:_authToken=rrg_example\n",
        mode: 0o600,
      },
    ]);
  });
});

describe("npmAdapter standard tarball path (lockfile resolved URLs)", () => {
  const route = (subpath: string) => npmAdapter.route("GET", subpath, new Headers());

  it.each([
    ["react/-/react-19.1.0.tgz", "react", "19.1.0"],
    ["JSONStream/-/JSONStream-1.3.5.tgz", "JSONStream", "1.3.5"],
    ["@scope/pkg/-/pkg-1.2.3.tgz", "@scope/pkg", "1.2.3"],
    ["@scope%2fpkg/-/pkg-1.2.3.tgz", "@scope/pkg", "1.2.3"],
    ["@scope%2Fpkg/-/pkg-1.2.3.tgz", "@scope/pkg", "1.2.3"],
    ["react/-/react-19.0.0-rc.1.tgz", "react", "19.0.0-rc.1"],
    ["xmlchars/-/xmlchars-2.2.0.tgz", "xmlchars", "2.2.0"],
  ])("routes %s as a download of %s %s", (subpath, name, version) => {
    expect(route(subpath)).toEqual({ kind: "download", name, version, filename: `${version}.tgz` });
  });

  it("answers HEAD like GET and refuses other methods", () => {
    expect(npmAdapter.route("HEAD", "react/-/react-19.1.0.tgz", new Headers())).toMatchObject({ kind: "download" });
    expect(npmAdapter.route("PUT", "react/-/react-19.1.0.tgz", new Headers())).toBeNull();
  });

  it.each([
    "react/-/preact-10.0.0.tgz", // filename names another package
    "react/-/React-19.1.0.tgz", // case differs: npm names are exact
    "@scope/pkg/-/scope-pkg-1.2.3.tgz",
    "@scope/pkg/-/other-1.2.3.tgz",
    "react/-/react-latest.tgz", // not a version
    "react/-/react-1.2.tgz",
    "react/-/react-v1.2.3.tgz", // loose spelling, not the exact version
    "react/-/react-1.2.3.tar.gz",
    "react/-/react-1.2.3",
    "react/-/react-.tgz",
    "react/-/..",
    "react/-/react-1.2.3%2F..%2F..%2Fx.tgz", // encoded slashes in the filename
    "react/-/react-1.2.3%2fx.tgz",
    "react/-/..%2Freact-1.2.3.tgz",
    "../react/-/react-1.2.3.tgz",
    "react/../-/react-1.2.3.tgz",
    "a/b/-/b-1.0.0.tgz", // unscoped names have no slash
    "@scope/pkg/extra/-/extra-1.0.0.tgz",
    "react/-/react-1.2.3.tgz/extra",
  ])("returns null for %s", (subpath) => {
    expect(route(subpath)).toBeNull();
  });
});

describe("npmAdapter dependency specs", () => {
  const depsOf = async (dependencies: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const meta = await npmAdapter.fetchMetadata("app", async () =>
      Response.json({
        name: "app",
        time: { "1.0.0": "2020-01-01T00:00:00.000Z" },
        versions: {
          "1.0.0": { dist: { tarball: "https://registry.npmjs.org/app/-/app-1.0.0.tgz" }, dependencies, ...extra },
        },
      }),
    );
    return meta.versions.get("1.0.0")?.dependencies;
  };

  it("follows an npm: alias to the package it names, not the alias key", async () => {
    await expect(
      depsOf({
        "string-width-cjs": "npm:string-width@^4.2.0",
        "strip-ansi-cjs": "npm:strip-ansi",
        "scoped-alias": "npm:@scope/pkg@^1",
        "@types/x-alias": "npm:@types/x@1.0.0",
        plain: "^1.0.0",
      }),
    ).resolves.toEqual(["string-width", "strip-ansi", "@scope/pkg", "@types/x", "plain"]);
  });

  it("applies the same rules to optional and peer dependencies", async () => {
    await expect(
      depsOf({}, { optionalDependencies: { a: "npm:b@1" }, peerDependencies: { c: "git+https://example.com/c.git" } }),
    ).resolves.toEqual(["b"]);
  });

  it.each([
    "file:../local",
    "link:../local",
    "./local",
    "../local",
    "~/local",
    "/abs/local",
    "git://github.com/u/r.git",
    "git+ssh://git@github.com/u/r.git",
    "git+https://github.com/u/r.git",
    "http://example.com/r.tgz",
    "https://example.com/r.tgz",
    "github:u/r",
    "gitlab:u/r",
    "bitbucket:u/r",
    "gist:abc",
    "u/r",
    "u/r#main",
    "workspace:*",
    "npm:",
    "npm:@scope",
    "npm:../evil@1",
  ])("skips the non-registry spec %s", async (spec) => {
    await expect(depsOf({ local: spec, kept: "*" })).resolves.toEqual(["kept"]);
  });

  it("keeps registry specs: ranges, exact versions, tags and empty", async () => {
    await expect(depsOf({ a: "^1", b: "1.2.3", c: "latest", d: "", e: "*", f: ">=1 <2 || 3.x" })).resolves.toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });
});
