import { readFile } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { pypiAdapter, requiredDists, requiresDist } from "./pypi.js";

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

  it.each([
    ["psycopg[binary]", { name: "psycopg", wildcard: false, extras: ["binary"] }],
    ["psycopg[binary]>=3.2", { name: "psycopg", wildcard: false, extras: ["binary"], range: ">=3.2" }],
    ["psycopg [binary, pool] >=3.2", { name: "psycopg", wildcard: false, extras: ["binary", "pool"], range: ">=3.2" }],
    // PEP 685: extras compare lowercased, with runs of -_. as one "-".
    ["Uvicorn[Standard]", { name: "uvicorn", wildcard: false, extras: ["standard"] }],
    ["pkg[Foo_Bar,foo.bar,c]", { name: "pkg", wildcard: false, extras: ["c", "foo-bar"] }],
  ])("parses extras in %s", (raw, expected) => {
    expect(pypiAdapter.parseAllowlistEntry(raw)).toEqual(expected);
  });

  it.each([
    "psycopg[]",
    "psycopg[binary",
    "psycopg[bin ary]",
    "psycopg[-binary]",
    "psycopg[a,,b]",
    "psycopg[a]]",
    "psycopg[a][b]",
    'psycopg["a"]',
    "psycopg[a]>>3",
  ])("rejects the extras in %j", (raw) => {
    expect(() => pypiAdapter.parseAllowlistEntry(raw)).toThrow();
  });
});

/** psycopg 3.2's real Requires-Dist lines (from its wheel METADATA). */
const PSYCOPG = [
  "Metadata-Version: 2.1",
  "Name: psycopg",
  "Version: 3.2.3",
  'Requires-Dist: backports.zoneinfo>=0.2.0; python_version < "3.9"',
  'Requires-Dist: typing-extensions>=4.6; python_version < "3.13"',
  'Requires-Dist: tzdata; sys_platform == "win32"',
  'Requires-Dist: psycopg-binary==3.2.3; implementation_name != "pypy" and extra == "binary"',
  'Requires-Dist: psycopg-c==3.2.3; implementation_name != "pypy" and extra == "c"',
  'Requires-Dist: psycopg-pool; extra == "pool"',
  'Requires-Dist: pytest>=6.2.5; extra == "test"',
  'Requires-Dist: mypy>=1.11; extra == "dev"',
  'Requires-Dist: sphinx>=5.0; extra == "docs"',
].join("\n");

const names = (deps: { name: string }[]) => deps.map((dep) => dep.name).sort();

describe("requiredDists (extras)", () => {
  it("follows only the lines gated on a requested extra", () => {
    expect(names(requiredDists(PSYCOPG, ["binary"]))).toEqual([
      "backports-zoneinfo",
      "psycopg-binary",
      "typing-extensions",
      "tzdata",
    ]);
  });

  it("follows no extra-gated line without a requested extra (unchanged plain behavior)", () => {
    const plain = ["backports-zoneinfo", "typing-extensions", "tzdata"];
    expect(names(requiredDists(PSYCOPG))).toEqual(plain);
    expect([...requiresDist(PSYCOPG)].sort()).toEqual(plain);
  });

  it("follows several requested extras, normalizing both sides", () => {
    const text =
      'Name: a\nRequires-Dist: one; extra == "Foo_Bar"\nRequires-Dist: two; extra == "pool"\nRequires-Dist: three; extra == "c"';
    expect(names(requiredDists(text, ["foo.bar", "pool"]))).toEqual(["one", "two"]);
  });

  it("reads parenthesized, single-quoted and reversed extra clauses", () => {
    const text = [
      "Name: a",
      "Requires-Dist: one; (extra == 'x' or extra == 'y') and python_version >= \"3.8\"",
      'Requires-Dist: two; "y" == extra',
      'Requires-Dist: three; extra=="z"',
    ].join("\n");
    expect(names(requiredDists(text, ["y"]))).toEqual(["one", "two"]);
    expect(names(requiredDists(text, ["z"]))).toEqual(["three"]);
    expect(names(requiredDists(text))).toEqual([]);
  });

  it("does not read an extra clause out of a quoted marker value", () => {
    const text = 'Name: a\nRequires-Dist: sneaky; platform_release == \'extra == "binary"\' and extra == "other"';
    expect(names(requiredDists(text, ["binary"]))).toEqual([]);
  });

  it("propagates the extras a dependency line names", () => {
    const text = [
      "Name: app",
      "Requires-Dist: uvicorn[standard]>=0.30",
      'Requires-Dist: httpx[HTTP2,socks]; extra == "net"',
      'Requires-Dist: celery[redis]; extra == "queue"',
    ].join("\n");
    expect(requiredDists(text, ["net"])).toEqual([
      { name: "uvicorn", extras: ["standard"] },
      { name: "httpx", extras: ["http2", "socks"] },
    ]);
  });

  it("follows no extras at all for a plain install: neither its own nor its dependencies'", () => {
    const text = [
      "Name: app",
      "Requires-Dist: uvicorn[standard]>=0.30",
      "Requires-Dist: app[web]",
      'Requires-Dist: flask; extra == "web"',
    ].join("\n");
    // uvicorn is allowed as the bare package, exactly as before extras support.
    expect(requiredDists(text)).toEqual([{ name: "uvicorn", extras: [] }]);
  });

  it("expands a package's extras that name its own other extras", () => {
    const text = [
      "Name: Celery",
      'Requires-Dist: redis>=4; extra == "redis"',
      'Requires-Dist: pymongo; extra == "mongodb"',
      'Requires-Dist: celery[redis,mongodb]; extra == "all"',
    ].join("\n");
    expect(names(requiredDists(text, ["all"]))).toEqual(["pymongo", "redis"]);
  });

  it("skips invalid names and invalid extras from metadata", () => {
    const text = [
      "Name: a",
      "Requires-Dist: ok[good,b@d]",
      "Requires-Dist: .bad",
      "Requires-Dist: trailing.",
      'Requires-Dist: gated; extra == "b@d"',
    ].join("\n");
    expect(requiredDists(text, ["b@d"])).toEqual([{ name: "ok", extras: [] }]);
  });

  it("reads only the headers, never the description after them", () => {
    const text = "Name: a\nRequires-Dist: real\n\nRequires-Dist: from-the-readme\n";
    expect(names(requiredDists(text))).toEqual(["real"]);
  });

  it("reads past a folded header's whitespace-only continuation lines", () => {
    const text = [
      "Name: a",
      "License: MIT",
      "        ",
      "        Permission is hereby granted",
      "\t",
      "        to any person",
      "Requires-Dist: needed",
      "",
      "Requires-Dist: from-the-readme",
    ].join("\n");
    expect(names(requiredDists(text))).toEqual(["needed"]);
  });

  it.each([
    ['extra === "foo"', "foo"],
    ['extra == "foo', "foo"],
    ["extra == 'foo", "foo"],
    ['"foo" in extra', "foo"],
    ["extra in 'foo bar'", "foo"],
    ['extra.thing == "foo"', "foo"],
    ['python_version > "3" and extra', "foo"],
    ['os_name == "nt" or extra == "foo"', "foo"],
  ])("fails closed on the extra marker %j", (marker, extra) => {
    const text = `Name: a\nRequires-Dist: gated; ${marker}\nRequires-Dist: plain; python_version >= "3.8"`;
    // A plain install never follows it (the old /;\s*.*\bextra\s*==/ skip did the same or stricter).
    expect(names(requiredDists(text))).toEqual(["plain"]);
    expect(requiresDist(text)).toEqual(["plain"]);
    if (marker.startsWith("extra ===")) {
      // pip treats === as equality: a recognised gate, followed for that extra.
      expect(names(requiredDists(text, [extra]))).toEqual(["gated", "plain"]);
    } else if (!marker.startsWith("os_name")) {
      // Anything not fully recognised is followed for no extra at all.
      expect(names(requiredDists(text, [extra]))).toEqual(["plain"]);
    }
  });

  it("matches the old skip on plain entries for every extra == shape", () => {
    const old = (text: string) =>
      text
        .split("\n")
        .filter((line) => line.startsWith("Requires-Dist:"))
        .map((line) => line.slice("Requires-Dist:".length).trim())
        .filter((value) => !/;\s*.*\bextra\s*==/.test(value))
        .map((value) => value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)![1]);
    const text = [
      "Name: a",
      'Requires-Dist: one; extra == "x"',
      'Requires-Dist: two; extra=="x"',
      "Requires-Dist: three; (extra == 'x' or extra == 'y')",
      'Requires-Dist: four; implementation_name != "pypy" and extra == "binary"',
      'Requires-Dist: five; extra === "x"',
      'Requires-Dist: six; extra == "x',
      'Requires-Dist: seven; python_version < "3.9"',
      "Requires-Dist: eight",
      "Requires-Dist: nine; platform_release == 'extra == \"x\"'",
    ].join("\n");
    expect(requiresDist(text)).toEqual(old(text));
  });

  it("passes requested extras through dependenciesFromFile for a metadata file", async () => {
    const deps = await pypiAdapter.dependenciesFromFile!(
      { kind: "file-metadata", name: "psycopg", filename: "psycopg-3.2.3-py3-none-any.whl" },
      new TextEncoder().encode(PSYCOPG),
      ["binary"],
    );
    expect(names(deps)).toContain("psycopg-binary");
    expect(names(deps)).not.toContain("psycopg-c");
    expect(names(deps)).not.toContain("psycopg-pool");
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

  it("serves wheels only, lists sdists, and rewrites file URLs", async () => {
    const meta = await pypiAdapter.fetchMetadata("flask", async () => Response.json(await json()));
    const files = [...meta.versions.values()].flatMap((version) => version.files);
    expect(files.filter((file) => file.filename.endsWith(".tar.gz")).every((file) => !file.allowed)).toBe(true);
    const keep = new Set(meta.versions.keys());
    const allFiles = new Set(files.map((file) => file.filename));
    const doc = JSON.parse(
      pypiAdapter.renderMetadata(meta, keep, allFiles, "http://wardby-proxy:8787/registry/pypi/").body,
    );
    const rendered = doc.files as { filename: string; url: string; "core-metadata"?: unknown }[];
    expect(rendered.some((file) => file.filename.endsWith(".whl"))).toBe(true);
    // An sdist is listed (a uv.lock written through the proxy keeps it) without a metadata file.
    const sdists = rendered.filter((file) => file.filename.endsWith(".tar.gz"));
    expect(sdists.length).toBeGreaterThan(0);
    expect(sdists.every((file) => file["core-metadata"] === undefined)).toBe(true);
    expect(rendered.every((file) => file.url.startsWith("http://wardby-proxy:8787/registry/pypi/files/flask/"))).toBe(
      true,
    );
  });

  it("keeps only wheels and sdists, with the fields it renders, in the cached index", async () => {
    const meta = await pypiAdapter.fetchMetadata("flask", async () => Response.json(await json()));
    const raw = meta.raw as { files: Record<string, unknown>[] };
    expect(raw.files.length).toBeGreaterThan(0);
    expect(raw.files.every((file) => /\.(?:whl|tar\.gz|zip)$/.test(String(file.filename)))).toBe(true);
  });

  it("reads Requires-Dist names and skips extras", async () => {
    const found = requiresDist(await metadataText());
    expect(found).toContain("werkzeug");
    expect(found).not.toContain("asgiref"); // only under extra == "async"
  });

  it("reads dependencies from a wheel's dist-info METADATA", async () => {
    const wheel = zipSync({ "flask-3.0.0.dist-info/METADATA": strToU8(await metadataText()) });
    const deps = await pypiAdapter.dependenciesFromFile!(
      { kind: "download", name: "flask", version: "3.0.0", filename: "flask-3.0.0-py3-none-any.whl" },
      wheel,
      [],
    );
    expect(deps.map((dep) => dep.name)).toContain("werkzeug");
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

  it("configures uv the same way: the registry as its only index, no sdists, its own cache, no downloads", () => {
    const config = pypiAdapter.workerConfig({
      registryUrl: "http://wardby-proxy:8787/registry/pypi/",
      token: "rrg_example",
      cacheDir: "/workspace/.cache/pypi",
    });
    expect(config.env).toMatchObject({
      UV_DEFAULT_INDEX: "http://wardby:rrg_example@wardby-proxy:8787/registry/pypi/simple/",
      UV_NO_BUILD: "1",
      UV_CACHE_DIR: "/workspace/.cache/pypi/uv",
      UV_PYTHON_DOWNLOADS: "never",
    });
  });
});
