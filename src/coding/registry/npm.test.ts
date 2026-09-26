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
