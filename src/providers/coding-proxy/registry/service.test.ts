import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RegistryAdapter, PackageMetadata } from "../../../coding/registry/types.js";
import { capabilityHash } from "../proxy.js";
import { MemoryRegistryStore } from "./store.js";
import { RegistryService } from "./service.js";

const DAY = 86_400_000;
const NOW = new Date("2026-09-25T00:00:00Z");
const tarball = new TextEncoder().encode("package bytes");
const sha512 = createHash("sha512").update(tarball).digest("hex");

function meta(name: string, versions: Record<string, { ageDays: number | null; deps?: string[] }>): PackageMetadata {
  return {
    name,
    raw: null,
    versions: new Map(
      Object.entries(versions).map(([version, info]) => [
        version,
        {
          version,
          publishedAt: info.ageDays === null ? null : new Date(NOW.getTime() - info.ageDays * DAY),
          dependencies: info.deps ?? [],
          files: [
            {
              filename: `${version}.tgz`,
              version,
              upstreamUrl: `https://upstream.test/${name}/${version}.tgz`,
              integrity: { algorithm: "sha512", hex: sha512 },
              sizeBytes: tarball.byteLength,
              allowed: true,
            },
          ],
        },
      ]),
    ),
  };
}

const catalog: Record<string, PackageMetadata> = {
  app: meta("app", { "1.0.0": { ageDays: 10, deps: ["dep"] }, "2.0.0": { ageDays: 1 } }),
  dep: meta("dep", { "1.0.0": { ageDays: 10 } }),
  stranger: meta("stranger", { "1.0.0": { ageDays: 10 } }),
};

const fakeAdapter: RegistryAdapter = {
  id: "fake",
  osvEcosystem: "npm",
  upstreamHosts: ["upstream.test"],
  collectExclude: [],
  parseAllowlistEntry: (raw) => ({ name: raw, wildcard: false }),
  normalizeName: (name) => name,
  satisfies: () => true,
  route: (_method, subpath) => {
    const download = subpath.match(/^dl\/([^/]+)\/([^/]+)$/);
    return download
      ? { kind: "download", name: download[1], version: download[2], filename: `${download[2]}.tgz` }
      : { kind: "metadata", name: subpath };
  },
  fetchMetadata: async (name) => catalog[name],
  renderMetadata: (m, keep) => ({ contentType: "application/json", body: JSON.stringify([...keep]) }),
  resolveDownload: (route, m) => m.versions.get(route.version)?.files[0] ?? null,
  workerConfig: () => ({ env: {}, files: [] }),
};

function service(
  overrides: {
    upstreamBody?: Uint8Array;
    withheld?: string[];
    limits?: { maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number; idleTimeoutMs?: number };
    upstream?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  } = {},
) {
  const store = new MemoryRegistryStore();
  store.contexts.set(capabilityHash("rrg_token"), {
    runId: "run-1",
    deadlineAt: new Date(NOW.getTime() + DAY),
    allowlist: { fake: ["app"] },
    policy: {},
  });
  const registry = new RegistryService({
    adapters: new Map([["fake", fakeAdapter]]),
    store,
    audit: {
      audit: async () => ({
        withheld: new Map((overrides.withheld ?? []).map((v) => [v, ["GHSA-x"]])),
        reported: new Map(),
      }),
    },
    upstream: overrides.upstream ?? (async () => new Response(overrides.upstreamBody ?? tarball)),
    proxyBase: "http://wardby-proxy:8787/registry/",
    limits: {
      maxFileBytes: 1_000_000,
      maxTotalBytes: 2_000_000,
      maxFiles: 10,
      idleTimeoutMs: 1_000,
      ...overrides.limits,
    },
    now: () => NOW,
  });
  return { registry, store };
}

const request = (subpath: string, token = "rrg_token") => ({
  method: "GET",
  ecosystem: "fake",
  subpath,
  token,
  signal: new AbortController().signal,
});

describe("RegistryService", () => {
  it("rejects an unknown token", async () => {
    const { registry } = service();
    await expect(registry.handle(request("app", "nope"))).resolves.toMatchObject({ status: 401 });
  });

  it("refuses and records a package outside the allowlist and its graph", async () => {
    const { registry, store } = service();
    const response = await registry.handle(request("stranger"));
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed");
    expect(store.fetches[0]).toMatchObject({ name: "stranger", outcome: "refused" });
  });

  it("serves only versions older than the release age and grows the graph from them", async () => {
    const { registry, store } = service();
    const response = await registry.handle(request("app"));
    expect(response).toMatchObject({ status: 200, body: JSON.stringify(["1.0.0"]) });
    expect(await store.isAllowedDependency("run-1", "fake", "dep")).toBe(true);
    await expect(registry.handle(request("dep"))).resolves.toMatchObject({ status: 200 });
  });

  it("withholds versions with blocking advisories", async () => {
    const { registry } = service({ withheld: ["1.0.0"] });
    const response = await registry.handle(request("app"));
    expect(response).toMatchObject({ status: 404 });
  });

  it("streams a download, verifies integrity, and records it", async () => {
    const { registry, store } = service();
    const response = await registry.handle(request("dl/app/1.0.0"));
    if (!("stream" in response)) throw new Error("expected a stream");
    expect(new Uint8Array(await new Response(response.stream).arrayBuffer())).toEqual(tarball);
    expect(store.fetches.at(-1)).toMatchObject({ name: "app", version: "1.0.0", outcome: "served" });
  });

  it("errors the stream when the bytes do not match the published integrity", async () => {
    const { registry, store } = service({ upstreamBody: new TextEncoder().encode("tampered") });
    const response = await registry.handle(request("dl/app/1.0.0"));
    if (!("stream" in response)) throw new Error("expected a stream");
    await expect(new Response(response.stream).arrayBuffer()).rejects.toThrow();
    expect(store.fetches.at(-1)).toMatchObject({ outcome: "refused", reason: "wardby_integrity_mismatch" });
  });

  it("refuses a download of a filtered version", async () => {
    const { registry } = service();
    await expect(registry.handle(request("dl/app/2.0.0"))).resolves.toMatchObject({ status: 404 });
  });

  it("guards the fail()/pending-read race: an idle reader that never resolves errors the stream and records exactly one refused row", async () => {
    // The upstream body's reader never resolves its read() — simulating a
    // stalled connection — so only the idle timer can settle the stream.
    // The controller's ruling requires that once fail() runs from the idle
    // timer, a later resolution of that pending read (if the underlying
    // stream ever did resolve) must be ignored: no double enqueue/close and
    // no second recorded row.
    const hangingBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}), // never resolves
    });
    const { registry, store } = service({
      limits: { idleTimeoutMs: 5 },
      upstream: async () => new Response(hangingBody),
    });
    const response = await registry.handle(request("dl/app/1.0.0"));
    if (!("stream" in response)) throw new Error("expected a stream");
    await expect(new Response(response.stream).arrayBuffer()).rejects.toThrow();
    const refused = store.fetches.filter(
      (fetch) => fetch.outcome === "refused" && fetch.reason === "wardby_download_idle",
    );
    expect(refused).toHaveLength(1);
    expect(store.fetches).toHaveLength(1);
  });
});
