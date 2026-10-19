/**
 * Python lockfile verification (`POST /registry/pypi/-/plan`) through
 * RegistryService with the real PyPI adapter against a fake PyPI: the JSON
 * API (per-release facts), the simple index and wheel files. Approvals are
 * names: no version is served from an approval, so every download keeps the
 * usual per-file checks.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pypiAdapter } from "../../../coding/registry/pypi.js";
import type { UpstreamFetch } from "../../../coding/registry/types.js";
import { capabilityHash } from "../proxy.js";
import { RegistryService } from "./service.js";
import { MemoryRegistryStore } from "./store.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-19T00:00:00Z");
const OLD = new Date(NOW.getTime() - 30 * DAY).toISOString();
const NEW = new Date(NOW.getTime() - DAY).toISOString();
const wheelBytes = new TextEncoder().encode("wheel bytes");
const sha256 = createHash("sha256").update(wheelBytes).digest("hex");

interface FakeRelease {
  requires?: string[];
  uploaded?: string;
  /** Only an sdist. */
  sdistOnly?: boolean;
}
type FakePypi = Record<string, Record<string, FakeRelease>>;

const wheelName = (name: string, version: string) => `${name.replace(/-/g, "_")}-${version}-py3-none-any.whl`;
const fileUrl = (filename: string) => `https://files.pythonhosted.org/packages/ab/cd/${filename}`;

function fakePypi(pypi: FakePypi) {
  const calls: string[] = [];
  const upstream: UpstreamFetch = async (url) => {
    calls.push(url);
    const json = url.match(/^https:\/\/pypi\.org\/pypi\/([^/]+)\/([^/]+)\/json$/);
    if (json) {
      const [name, version] = [decodeURIComponent(json[1]), decodeURIComponent(json[2])];
      const release = pypi[name]?.[version];
      if (!release) return new Response("{}", { status: 404 });
      const files = release.sdistOnly
        ? [{ packagetype: "sdist", filename: `${name}-${version}.tar.gz`, url: fileUrl(`${name}-${version}.tar.gz`) }]
        : [
            {
              packagetype: "bdist_wheel",
              filename: wheelName(name, version),
              url: fileUrl(wheelName(name, version)),
              yanked: false,
              upload_time_iso_8601: release.uploaded ?? OLD,
              digests: { sha256 },
            },
          ];
      return Response.json({ info: { name, version, requires_dist: release.requires ?? null }, urls: files });
    }
    const simple = url.match(/^https:\/\/pypi\.org\/simple\/([^/]+)\/$/);
    if (simple) {
      const versions = pypi[simple[1]];
      if (!versions) return new Response("{}", { status: 404 });
      return Response.json({
        name: simple[1],
        files: Object.entries(versions).map(([version, release]) => ({
          filename: release.sdistOnly ? `${simple[1]}-${version}.tar.gz` : wheelName(simple[1], version),
          url: fileUrl(wheelName(simple[1], version)),
          hashes: { sha256 },
          "upload-time": release.uploaded ?? OLD,
          size: wheelBytes.byteLength,
        })),
      });
    }
    if (url.startsWith("https://files.pythonhosted.org/")) return new Response(wheelBytes);
    return new Response("no route", { status: 404 });
  };
  return { upstream, calls };
}

function setup(pypi: FakePypi, allowlist: string[], policy: unknown = {}) {
  const fake = fakePypi(pypi);
  const store = new MemoryRegistryStore();
  store.contexts.set(capabilityHash("rrg_token"), {
    runId: "run-1",
    deadlineAt: new Date(NOW.getTime() + DAY),
    allowlist: { pypi: allowlist },
    policy,
    repository: "owner/repo",
    cacheImage: null,
    dependencyCache: false,
    packageAudit: null,
  });
  const service = new RegistryService({
    adapters: new Map([["pypi", pypiAdapter]]),
    store,
    audit: {
      audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [] }),
      auditVersions: async () => new Map(),
    },
    upstream: fake.upstream,
    proxyBase: "http://wardby-proxy:8787/registry/",
    limits: { maxFileBytes: 1_000_000, maxTotalBytes: 10_000_000, maxFiles: 100, idleTimeoutMs: 1_000 },
    now: () => NOW,
  });
  const plan = async (body: string) => {
    const response = await service.plan({
      ecosystem: "pypi",
      token: "rrg_token",
      readBody: async () => body,
      signal: new AbortController().signal,
    });
    return {
      status: response.status,
      json: JSON.parse((response as { body: string }).body) as {
        approved: number;
        refused: { name: string; version: string; code: string; reason: string }[];
        error?: string;
      },
    };
  };
  const get = (subpath: string) =>
    service.handle({
      ecosystem: "pypi",
      method: "GET",
      subpath,
      token: "rrg_token",
      signal: new AbortController().signal,
    });
  const allowed = (name: string) => store.isAllowedDependency("run-1", "pypi", name);
  return { service, store, plan, get, allowed, calls: fake.calls };
}

const refusedOf = (json: { refused: { name: string; version: string; code: string }[] }) =>
  Object.fromEntries(json.refused.map((refusal) => [`${refusal.name}@${refusal.version}`, refusal.code]));

const app: FakePypi = {
  fastapi: { "0.115.0": { requires: ["starlette>=0.40,<0.50", "pydantic>=2"] } },
  starlette: { "0.45.0": { requires: ["anyio>=4"] } },
  pydantic: { "2.9.0": {} },
  anyio: { "4.6.0": {} },
  requests: { "2.32.0": {} },
};
const appRequirements = "fastapi==0.115.0\nstarlette==0.45.0\npydantic==2.9.0\nanyio==4.6.0\nrequests==2.32.0\n";

describe("Python lockfile plans", () => {
  it("allows the names a pinned requirements file reaches from the allowlist, and refuses the rest", async () => {
    const { plan, store, allowed } = setup(app, ["fastapi"]);
    const { status, json } = await plan(appRequirements);
    expect(status).toBe(200);
    expect(json.approved).toBe(4);
    expect(refusedOf(json)).toEqual({ "requests@2.32.0": "wardby_package_not_allowed" });
    for (const name of ["fastapi", "starlette", "pydantic", "anyio"]) expect(await allowed(name)).toBe(true);
    expect(await allowed("requests")).toBe(false);
    // Names only: nothing is served from an approval.
    expect(store.approvals.size).toBe(0);
    expect(store.facts.size).toBe(4);
  });

  it("then serves a transitive package's index, and its wheel through the usual per-file checks", async () => {
    const { plan, get, calls, store } = setup(app, ["fastapi"]);
    await plan(appRequirements);
    await expect(get("simple/anyio/")).resolves.toMatchObject({ status: 200 });
    const served = await get(`files/anyio/${wheelName("anyio", "4.6.0")}`);
    if (!("stream" in served)) throw new Error("expected a stream");
    expect(new Uint8Array(await new Response(served.stream).arrayBuffer())).toEqual(wheelBytes);
    expect(calls).toContain("https://pypi.org/simple/anyio/");
    expect(store.fetches.filter((fetch) => fetch.outcome === "served").map((fetch) => fetch.name)).toEqual(["anyio"]);
  });

  it("reads each release's facts once, publish time included, and reuses them", async () => {
    const { plan, calls } = setup(app, ["fastapi"]);
    await plan(appRequirements);
    expect(calls.filter((url) => url.includes("/pypi/fastapi/"))).toEqual([
      "https://pypi.org/pypi/fastapi/0.115.0/json",
    ]);
    expect(calls.some((url) => url.includes("/simple/"))).toBe(false);
    const before = calls.length;
    await plan(appRequirements.replace("fastapi==", "FastAPI=="));
    expect(calls.length).toBe(before);
  });

  it("names a pin newer than the release-age limit, and a release with no wheel", async () => {
    const { plan, store } = setup(
      {
        ...app,
        fastapi: { "0.115.0": { requires: ["docopt"], uploaded: NEW } },
        docopt: { "0.6.2": { sdistOnly: true } },
      },
      ["fastapi", "docopt"],
    );
    const { json } = await plan("fastapi==0.115.0\ndocopt==0.6.2\n");
    expect(refusedOf(json)).toEqual({
      "fastapi@0.115.0": "wardby_version_filtered",
      "docopt@0.6.2": "wardby_file_not_allowed",
    });
    expect(json.refused.find((refusal) => refusal.name === "fastapi")?.reason).toContain("newer than the release-age");
    // Both are verdicts about the release itself, so they answer later downloads.
    expect(await store.findPlanRefusal("run-1", "pypi", "docopt", "0.6.2")).toMatchObject({
      code: "wardby_file_not_allowed",
    });
  });

  it("follows extras only from an allowlist entry that names them", async () => {
    const pypi: FakePypi = {
      psycopg: { "3.2.0": { requires: ["typing-extensions>=4", "psycopg-binary==3.2.0 ; extra == 'binary'"] } },
      "psycopg-binary": { "3.2.0": {} },
      "typing-extensions": { "4.12.0": {} },
    };
    const lock = "psycopg==3.2.0\npsycopg-binary==3.2.0\ntyping-extensions==4.12.0\n";
    const plain = await setup(pypi, ["psycopg"]).plan(lock);
    expect(refusedOf(plain.json)).toEqual({ "psycopg-binary@3.2.0": "wardby_package_not_allowed" });
    const extras = await setup(pypi, ["psycopg[binary]"]).plan(lock);
    expect(extras.json).toMatchObject({ approved: 3, refused: [] });
  });

  it("follows the extras a dependency line asks of its child, reached first without them", async () => {
    const pypi: FakePypi = {
      app: { "1.0": { requires: ["uvicorn", "web>=1"] } },
      web: { "1.0": { requires: ["uvicorn[standard]"] } },
      uvicorn: { "0.30.0": { requires: ["h11", "uvloop ; extra == 'standard'"] } },
      h11: { "0.14.0": {} },
      uvloop: { "0.21.0": {} },
    };
    const lock = "app==1.0\nweb==1.0\nuvicorn==0.30.0\nh11==0.14.0\nuvloop==0.21.0\n";
    // `app` and `web` are plain installs, so their dependencies come bare: uvloop is reached
    // only along a chain that starts at an allowlist entry naming extras.
    expect(refusedOf((await setup(pypi, ["app"]).plan(lock)).json)).toEqual({
      "uvloop@0.21.0": "wardby_package_not_allowed",
    });
    // `web[x]` asks uvicorn for `standard`: uvicorn, reached bare through app, is expanded again with it.
    expect((await setup(pypi, ["app", "web[x]"]).plan(lock)).json).toMatchObject({ approved: 5, refused: [] });
  });

  it("verifies a uv.lock: registry packages from PyPI, its project skipped, git and other indexes refused", async () => {
    const { plan, allowed } = setup(app, ["fastapi"]);
    const lock = `version = 1
requires-python = ">=3.12"

[[package]]
name = "demo-app"
version = "0.1.0"
source = { editable = "." }
dependencies = [{ name = "fastapi" }]

[[package]]
name = "fastapi"
version = "0.115.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "starlette" }, { name = "pydantic" }]

[[package]]
name = "starlette"
version = "0.45.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "anyio" }]

[[package]]
name = "pydantic"
version = "2.9.0"
source = { registry = "http://wardby-proxy:8787/registry/pypi/simple/" }

[[package]]
name = "anyio"
version = "4.6.0"
source = { git = "https://github.com/agronholm/anyio?rev=x#x" }
`;
    const { status, json } = await plan(lock);
    expect(status).toBe(200);
    expect(json.approved).toBe(3);
    expect(refusedOf(json)).toEqual({ "anyio@4.6.0": "wardby_lockfile_entry_unsupported" });
    expect(await allowed("pydantic")).toBe(true);
  });

  it("answers a Poetry lockfile with a clear unsupported error", async () => {
    const { plan } = setup(app, ["fastapi"]);
    const { status, json } = await plan("# This file is automatically @generated by Poetry 2.1.1\n[[package]]\n");
    expect(status).toBe(400);
    expect(json.error).toContain("wardby_lockfile_unsupported");
  });
});
