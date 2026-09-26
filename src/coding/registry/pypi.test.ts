import { readFile } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { pypiAdapter, requiresDist } from "./pypi.js";

const json = async () => JSON.parse(await readFile(new URL("./fixtures/pypi-flask.json", import.meta.url), "utf8"));
const metadataText = () => readFile(new URL("./fixtures/flask.METADATA", import.meta.url), "utf8");

describe("pypiAdapter allowlist syntax", () => {
  it.each([
    ["flask", { name: "flask", wildcard: false }],
    ["Flask>=3", { name: "flask", wildcard: false, range: ">=3" }],
    ["zope.interface ~=6.0", { name: "zope-interface", wildcard: false, range: "~=6.0" }],
  ])("parses %s", (raw, expected) => {
    expect(pypiAdapter.parseAllowlistEntry(raw)).toEqual(expected);
  });
  it.each(["", "flask>>3", "@scope/*"])("rejects %j", (raw) => {
    expect(() => pypiAdapter.parseAllowlistEntry(raw)).toThrow();
  });
});

describe("pypiAdapter protocol", () => {
  it("routes the simple index, files, and metadata files", () => {
    expect(pypiAdapter.route("GET", "simple/Flask/", new Headers())).toEqual({ kind: "metadata", name: "flask" });
    expect(pypiAdapter.route("GET", "files/flask/flask-3.0.0-py3-none-any.whl", new Headers())).toMatchObject({
      kind: "download",
      version: "3.0.0",
    });
    expect(pypiAdapter.route("GET", "files/flask/flask-3.0.0-py3-none-any.whl.metadata", new Headers())).toEqual({
      kind: "file-metadata",
      name: "flask",
      filename: "flask-3.0.0-py3-none-any.whl",
    });
  });

  it("keeps wheels, refuses sdists, and rewrites file URLs", async () => {
    const meta = await pypiAdapter.fetchMetadata("flask", async () => Response.json(await json()));
    const files = [...meta.versions.values()].flatMap((version) => version.files);
    expect(files.filter((file) => file.filename.endsWith(".tar.gz")).every((file) => !file.allowed)).toBe(true);
    const keep = new Set(meta.versions.keys());
    const allFiles = new Set(files.map((file) => file.filename));
    const doc = JSON.parse(
      pypiAdapter.renderMetadata(meta, keep, allFiles, "http://wardby-proxy:8787/registry/pypi/").body,
    );
    expect(doc.files.every((file: { filename: string }) => file.filename.endsWith(".whl"))).toBe(true);
    expect(doc.files[0].url.startsWith("http://wardby-proxy:8787/registry/pypi/files/flask/")).toBe(true);
  });

  it("keeps only wheels, with the fields it renders, in the cached index", async () => {
    const meta = await pypiAdapter.fetchMetadata("flask", async () => Response.json(await json()));
    const raw = meta.raw as { files: Record<string, unknown>[] };
    expect(raw.files.length).toBeGreaterThan(0);
    expect(raw.files.every((file) => String(file.filename).endsWith(".whl"))).toBe(true);
  });

  it("reads Requires-Dist names and skips extras", async () => {
    const names = requiresDist(await metadataText());
    expect(names).toContain("werkzeug");
    expect(names).not.toContain("asgiref"); // only under extra == "async"
  });

  it("reads dependencies from a wheel's dist-info METADATA", async () => {
    const wheel = zipSync({ "flask-3.0.0.dist-info/METADATA": strToU8(await metadataText()) });
    const names = await pypiAdapter.dependenciesFromFile!(
      { kind: "download", name: "flask", version: "3.0.0", filename: "flask-3.0.0-py3-none-any.whl" },
      wheel,
    );
    expect(names).toContain("werkzeug");
  });

  it("configures pip for wheels only with the registry token", () => {
    const config = pypiAdapter.workerConfig({
      registryUrl: "http://wardby-proxy:8787/registry/pypi/",
      token: "rrg_example",
      cacheDir: "/workspace/.cache/pypi",
    });
    expect(config.env.PIP_INDEX_URL).toBe("http://wardby:rrg_example@wardby-proxy:8787/registry/pypi/simple/");
    expect(config.env.PIP_ONLY_BINARY).toBe(":all:");
    expect(config.files).toEqual([]);
  });
});
