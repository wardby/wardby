import { createHash } from "node:crypto";
import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  RegistryError,
  type Integrity,
  type RegistryAdapter,
  type PackageMetadata,
} from "../../../coding/registry/types.js";
import { npmAdapter } from "../../../coding/registry/npm.js";
import { pypiAdapter } from "../../../coding/registry/pypi.js";
import { capabilityHash } from "../proxy.js";
import { MemoryRegistryStore, type RegistryFetchRecord, type RegistryStore } from "./store.js";
import { RegistryService } from "./service.js";

const DAY = 86_400_000;
const NOW = new Date("2026-09-25T00:00:00Z");
const tarball = new TextEncoder().encode("package bytes");
const sha512 = createHash("sha512").update(tarball).digest("hex");

function meta(
  name: string,
  versions: Record<string, { ageDays: number | null; deps?: string[]; integrity?: Integrity | null }>,
): PackageMetadata {
  return {
    name,
    raw: null,
    versions: new Map(
      Object.entries(versions).map(([version, info]) => [
        version,
        {
          version,
          dependencies: info.deps ?? [],
          files: [
            {
              filename: `${version}.tgz`,
              version,
              upstreamUrl: `https://upstream.test/${name}/${version}.tgz`,
              integrity: info.integrity === undefined ? { algorithm: "sha512", hex: sha512 } : info.integrity,
              sizeBytes: tarball.byteLength,
              allowed: true,
              publishedAt: info.ageDays === null ? null : new Date(NOW.getTime() - info.ageDays * DAY),
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
  // No published checksum (integrity: null) — used to prove the download
  // stream's post-read `settled` guard matters: without it, a hash-mismatch
  // branch can't be the thing masking a removed guard, because there is no
  // hash check at all.
  noint: meta("noint", { "1.0.0": { ageDays: 10, integrity: null } }),
};

const fakeAdapter: RegistryAdapter = {
  id: "fake",
  osvEcosystem: "npm",
  upstreamHosts: ["upstream.test"],
  collectExclude: [],
  dependenciesInMetadata: true,
  parseAllowlistEntry: (raw) => ({ name: raw, wildcard: false }),
  normalizeName: (name) => name,
  satisfies: () => true,
  compareVersions: (a, b) => a.localeCompare(b),
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

type AdvisoryIndex = {
  withheld: (version: string) => readonly string[];
  reported: (version: string) => readonly string[];
};
const NO_ADVISORIES: AdvisoryIndex = { withheld: () => [], reported: () => [] };

function service(
  overrides: {
    upstreamBody?: Uint8Array;
    withheld?: string[];
    limits?: {
      maxFileBytes?: number;
      maxTotalBytes?: number;
      maxFiles?: number;
      idleTimeoutMs?: number;
      maxRefusalRecords?: number;
    };
    store?: MemoryRegistryStore;
    upstream?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
    allowlist?: Record<string, string[]>;
    audit?: () => Promise<AdvisoryIndex>;
  } = {},
) {
  const store = overrides.store ?? new MemoryRegistryStore();
  store.contexts.set(capabilityHash("rrg_token"), {
    runId: "run-1",
    deadlineAt: new Date(NOW.getTime() + DAY),
    allowlist: overrides.allowlist ?? { fake: ["app"] },
    policy: {},
  });
  const registry = new RegistryService({
    adapters: new Map([["fake", fakeAdapter]]),
    store,
    audit: {
      audit:
        overrides.audit ??
        (async () => ({
          withheld: (version: string) => ((overrides.withheld ?? []).includes(version) ? ["GHSA-x"] : []),
          reported: () => [],
        })),
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

  it("never crashes the process when the fetch-record write fails during a fire-and-forget idle timeout", async () => {
    // fail() is invoked fire-and-forget (`void fail(...)`) off the idle
    // timer's setTimeout callback: nothing awaits its returned promise. If
    // fail() let a rejected store.recordFetch() propagate, that would be an
    // unhandled rejection — which terminates the whole process under Node
    // 24, not just this request. This test only passes if fail() truly
    // never rejects and still errors the stream instead of leaving the
    // client hanging.
    const inner = new MemoryRegistryStore();
    inner.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { fake: ["app"] },
      policy: {},
    });
    const store: RegistryStore = {
      findRunByRegistryTokenHash: (hash, now) => inner.findRunByRegistryTokenHash(hash, now),
      isAllowedDependency: (runId, ecosystem, name) => inner.isAllowedDependency(runId, ecosystem, name),
      addAllowances: (runId, ecosystem, names) => inner.addAllowances(runId, ecosystem, names),
      recordFetch: async () => {
        throw new Error("simulated database error");
      },
      usage: (runId) => inner.usage(runId),
      refusalCount: (runId) => inner.refusalCount(runId),
      listFetches: (runId) => inner.listFetches(runId),
      getVersionFacts: (ecosystem, versions) => inner.getVersionFacts(ecosystem, versions),
      putVersionFacts: (ecosystem, facts) => inner.putVersionFacts(ecosystem, facts),
      approveVersions: (runId, ecosystem, versions) => inner.approveVersions(runId, ecosystem, versions),
      findApprovedVersion: (runId, ecosystem, name, version) =>
        inner.findApprovedVersion(runId, ecosystem, name, version),
      refusePlanVersions: (runId, ecosystem, versions) => inner.refusePlanVersions(runId, ecosystem, versions),
      findPlanRefusal: (runId, ecosystem, name, version) => inner.findPlanRefusal(runId, ecosystem, name, version),
    };
    const hangingBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}), // never resolves
    });
    const registry = new RegistryService({
      adapters: new Map([["fake", fakeAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async () => new Response(hangingBody),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 5 },
      now: () => NOW,
    });
    const response = await registry.handle(request("dl/app/1.0.0"));
    if (!("stream" in response)) throw new Error("expected a stream");
    await expect(new Response(response.stream).arrayBuffer()).rejects.toThrow();
  });

  it("guards the same race even with no integrity to check (a served row is never recorded after an idle failure)", async () => {
    // With integrity set, a late `done` resolution after fail() runs still
    // routes into the (already-idempotent) integrity-mismatch call to
    // fail() — so that variant above can't actually prove the post-read
    // `settled` guard matters. With `integrity: null` there is no hash
    // check: without the guard, the late `done` would fall straight into
    // the served branch and record a served row on top of the refused one.
    const hangingBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}), // never resolves
    });
    const { registry, store } = service({
      allowlist: { fake: ["noint"] },
      limits: { idleTimeoutMs: 5 },
      upstream: async () => new Response(hangingBody),
    });
    const response = await registry.handle(request("dl/noint/1.0.0"));
    if (!("stream" in response)) throw new Error("expected a stream");
    await expect(new Response(response.stream).arrayBuffer()).rejects.toThrow();
    const refused = store.fetches.filter(
      (fetch) => fetch.outcome === "refused" && fetch.reason === "wardby_download_idle",
    );
    expect(refused).toHaveLength(1);
    expect(store.fetches.filter((fetch) => fetch.outcome === "served")).toHaveLength(0);
    expect(store.fetches).toHaveLength(1);
  });

  it("records a refused row when a download exceeds the per-run file-count limit", async () => {
    const { registry, store } = service({ limits: { maxFiles: 0 } });
    const response = await registry.handle(request("dl/app/1.0.0"));
    expect(response).toMatchObject({ status: 429 });
    expect(store.fetches.at(-1)).toMatchObject({
      name: "app",
      version: "1.0.0",
      outcome: "refused",
      reason: "wardby_package_limit",
    });
  });

  it("records a refused row when the vulnerability audit is unavailable", async () => {
    const { registry, store } = service({
      audit: async () => {
        throw new RegistryError(503, "wardby_audit_unavailable", 'the vulnerability audit for "app" is unreachable');
      },
    });
    const response = await registry.handle(request("app"));
    expect(response).toMatchObject({ status: 503 });
    expect(store.fetches.at(-1)).toMatchObject({ name: "app", outcome: "refused", reason: "wardby_audit_unavailable" });
  });

  it("enforces the per-run file limit across concurrent downloads via an in-flight reservation, not just a per-request snapshot", async () => {
    // A store.usage() snapshot taken once per request would let all three
    // downloads see the same "0 files served" baseline and all proceed,
    // since none of them has recorded a served row yet. The in-process
    // in-flight reservation must be what stops the third — before any of
    // the three streams is even read.
    const { registry, store } = service({ limits: { maxFiles: 2 } });
    const [first, second, third] = await Promise.all([
      registry.handle(request("dl/app/1.0.0")),
      registry.handle(request("dl/app/1.0.0")),
      registry.handle(request("dl/app/1.0.0")),
    ]);
    expect(first).toMatchObject({ status: 200 });
    expect(second).toMatchObject({ status: 200 });
    expect(third).toMatchObject({ status: 429 });
    const refused = store.fetches.filter(
      (fetch) => fetch.outcome === "refused" && fetch.reason === "wardby_package_limit",
    );
    expect(refused).toHaveLength(1);
  });

  it("holds a download's reservation until its served record actually lands, not just until its bytes finish (round 2 ordering)", async () => {
    // If release() ran before the served recordFetch resolved, there would
    // be a window — between the release and the row actually landing in the
    // store — where neither `inFlight` nor store.usage() counts this file,
    // and a concurrent request could be admitted past maxFiles. Gating the
    // served recordFetch call lets this test hold open exactly that window
    // and prove nothing slips through it.
    let releaseRecord: () => void = () => {};
    const recordGate = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    let recordCalled: () => void = () => {};
    const recordCalledPromise = new Promise<void>((resolve) => {
      recordCalled = resolve;
    });
    class GatedStore extends MemoryRegistryStore {
      async recordFetch(record: RegistryFetchRecord): Promise<void> {
        if (record.outcome === "served") {
          recordCalled();
          await recordGate;
        }
        return super.recordFetch(record);
      }
    }
    const store = new GatedStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { fake: ["app"] },
      policy: {},
    });
    const registry = new RegistryService({
      adapters: new Map([["fake", fakeAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async () => new Response(tarball),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 1, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });

    const responseA = await registry.handle(request("dl/app/1.0.0"));
    if (!("stream" in responseA)) throw new Error("expected a stream");
    const bodyAPromise = new Response(responseA.stream).arrayBuffer();

    // Download A has read all of its bytes and is now blocked inside the
    // gated served recordFetch call — release() has not run yet.
    await recordCalledPromise;
    const responseB = await registry.handle(request("dl/app/1.0.0"));
    expect(responseB).toMatchObject({ status: 429 });

    releaseRecord();
    expect(new Uint8Array(await bodyAPromise)).toEqual(tarball);
  });
});

describe("RegistryService reservations on HEAD and client abort", () => {
  it("answers HEAD from metadata without fetching the file, reserving, or recording", async () => {
    const urls: string[] = [];
    const { registry, store } = service({
      limits: { maxFiles: 1 },
      upstream: async (url) => {
        urls.push(url);
        return new Response(tarball);
      },
    });
    const head = await registry.handle({ ...request("dl/app/1.0.0"), method: "HEAD" });
    expect(head).toMatchObject({ status: 200, body: "" });
    expect(urls).toEqual([]);
    expect(store.fetches).toEqual([]);
    // In-flight usage is back at zero: the only file slot is still free.
    const get = await registry.handle(request("dl/app/1.0.0"));
    if (!("stream" in get)) throw new Error("expected a stream");
    await new Response(get.stream).arrayBuffer();
    expect(store.fetches.map((fetch) => fetch.outcome)).toEqual(["served"]);
  });

  it("releases the reservation and records nothing when the client aborts mid-stream", async () => {
    const { registry, store } = service({
      limits: { maxFiles: 1 },
      upstream: async (_url, init) => {
        // First chunk now, then hang until the client's signal aborts.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(tarball.subarray(0, 4));
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return new Response(body);
      },
    });
    const client = new AbortController();
    const response = await registry.handle({ ...request("dl/app/1.0.0"), signal: client.signal });
    if (!("stream" in response)) throw new Error("expected a stream");
    const reader = response.stream.getReader();
    await reader.read();
    const pending = reader.read();
    client.abort();
    await expect(pending).rejects.toThrow();
    expect(store.fetches).toEqual([]);
    const next = await registry.handle(request("dl/app/1.0.0"));
    expect(next).toMatchObject({ status: 200 });
    if ("stream" in next) await next.stream.cancel();
  });

  it("releases the reservation when the consumer cancels the stream", async () => {
    const { registry, store } = service({
      limits: { maxFiles: 1 },
      upstream: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(tarball.subarray(0, 4));
            },
          }),
        ),
    });
    const response = await registry.handle(request("dl/app/1.0.0"));
    if (!("stream" in response)) throw new Error("expected a stream");
    const reader = response.stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(store.fetches).toEqual([]);
    await expect(registry.handle(request("dl/app/1.0.0"))).resolves.toMatchObject({ status: 200 });
  });
});

describe("RegistryService refusal-record cap", () => {
  it("records at most 500 refused rows per run but still refuses every request", async () => {
    const { registry, store } = service();
    for (let i = 0; i < 510; i += 1) {
      const response = await registry.handle(request("stranger"));
      expect(response).toMatchObject({ status: 403 });
    }
    expect(store.fetches.filter((fetch) => fetch.outcome === "refused")).toHaveLength(500);
  });

  it("seeds the count from the store, so a restarted proxy keeps the cap", async () => {
    const store = new MemoryRegistryStore();
    for (let i = 0; i < 4; i += 1)
      await store.recordFetch({ runId: "run-1", ecosystem: "fake", name: "x", outcome: "refused", reason: "r" });
    const { registry } = service({ store, limits: { maxRefusalRecords: 5 } });
    await Promise.all([registry.handle(request("stranger")), registry.handle(request("stranger"))]);
    await registry.handle(request("stranger"));
    expect(store.fetches.filter((fetch) => fetch.outcome === "refused")).toHaveLength(5);
  });

  it("still records served rows after the refusal cap is reached", async () => {
    const { registry, store } = service({ limits: { maxRefusalRecords: 1 } });
    await registry.handle(request("stranger"));
    await registry.handle(request("stranger"));
    const response = await registry.handle(request("dl/app/1.0.0"));
    if (!("stream" in response)) throw new Error("expected a stream");
    await new Response(response.stream).arrayBuffer();
    expect(store.fetches.map((fetch) => fetch.outcome)).toEqual(["refused", "served"]);
  });
});

describe("RegistryService metadata fetch safety and cache", () => {
  function counted(overrides: { metadataCacheEntries?: number; metadataTtlMs?: number; now?: () => Date } = {}) {
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const adapter: RegistryAdapter = {
      ...fakeAdapter,
      fetchMetadata: async (name) => {
        calls.push(name);
        if (gated) await gate;
        return catalog[name];
      },
    };
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { fake: ["app", "dep", "noint"] },
      policy: {},
    });
    const registry = new RegistryService({
      adapters: new Map([["fake", adapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async () => new Response(tarball),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: overrides.now ?? (() => NOW),
      metadataCacheEntries: overrides.metadataCacheEntries,
      metadataTtlMs: overrides.metadataTtlMs,
    });
    return {
      registry,
      calls,
      gate: () => {
        gated = true;
      },
      release,
    };
  }

  it("shares one upstream fetch between concurrent misses for the same package", async () => {
    const { registry, calls, gate, release } = counted();
    gate();
    const both = Promise.all([registry.handle(request("app")), registry.handle(request("app"))]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const [first, second] = await both;
    expect(first).toMatchObject({ status: 200 });
    expect(second).toMatchObject({ status: 200 });
    expect(calls).toEqual(["app"]);
  });

  it("is a bounded LRU: the least recently used package is evicted first", async () => {
    const { registry, calls } = counted({ metadataCacheEntries: 2 });
    await registry.handle(request("app"));
    await registry.handle(request("dep"));
    await registry.handle(request("app")); // app is now most recently used
    await registry.handle(request("noint")); // evicts dep
    await registry.handle(request("app")); // still cached
    await registry.handle(request("dep")); // fetched again
    expect(calls).toEqual(["app", "dep", "noint", "dep"]);
  });

  it("drops expired entries on access", async () => {
    let now = NOW;
    const { registry, calls } = counted({ metadataTtlMs: 1_000, now: () => now });
    await registry.handle(request("app"));
    now = new Date(NOW.getTime() + 1_001);
    await registry.handle(request("app"));
    expect(calls).toEqual(["app", "app"]);
  });

  it("answers a metadata timeout with 504 wardby_upstream_unavailable", async () => {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { npm: ["react"] },
      policy: {},
    });
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: (_url, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error))),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => NOW,
      metadataTimeoutMs: 20,
    });
    const response = await registry.handle({ ...request("react"), ecosystem: "npm" });
    expect(response).toMatchObject({ status: 504 });
    expect("body" in response && response.body).toContain("wardby_upstream_unavailable");
  });

  it("refuses and records an oversized metadata document", async () => {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { npm: ["react"] },
      policy: {},
    });
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async () => new Response("x".repeat(4096)),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => NOW,
      maxMetadataBytes: 1024,
    });
    const response = await registry.handle({ ...request("react"), ecosystem: "npm" });
    expect(response).toMatchObject({ status: 502 });
    expect("body" in response && response.body).toContain("wardby_metadata_too_large");
    expect(store.fetches).toMatchObject([{ name: "react", outcome: "refused", reason: "wardby_metadata_too_large" }]);
  });
});

describe("RegistryService served-byte tally and per-adapter hosts", () => {
  it("counts a download that finished after another one started toward the byte limit", async () => {
    // Sizes are undeclared, so bytes are reserved only as they stream. A
    // streams and completes while B waits for its first chunk; when B's
    // bytes arrive, A's reservation is gone and A's row has landed. B must
    // see A's served bytes, not a usage snapshot from before A finished.
    let openB: () => void = () => {};
    const bGate = new Promise<void>((resolve) => {
      openB = resolve;
    });
    let calls = 0;
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { fake: ["noint"] },
      policy: {},
    });
    const undeclared: RegistryAdapter = {
      ...fakeAdapter,
      resolveDownload: (route, m) => {
        const file = m.versions.get(route.version)?.files[0];
        return file ? { ...file, sizeBytes: null } : null;
      },
    };
    const registry = new RegistryService({
      adapters: new Map([["fake", undeclared]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async () => {
        calls += 1;
        if (calls === 1) return new Response(tarball);
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await bGate;
              controller.enqueue(tarball);
              controller.close();
            },
          }),
        );
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: {
        maxFileBytes: 1_000_000,
        maxTotalBytes: Math.floor(tarball.byteLength * 1.5),
        maxFiles: 10,
        idleTimeoutMs: 1_000,
      },
      now: () => NOW,
    });
    const a = await registry.handle(request("dl/noint/1.0.0"));
    const b = await registry.handle(request("dl/noint/1.0.0"));
    if (!("stream" in a) || !("stream" in b)) throw new Error("expected streams");
    await new Response(a.stream).arrayBuffer();
    openB();
    await expect(new Response(b.stream).arrayBuffer()).rejects.toThrow();
    expect(store.fetches.map((fetch) => [fetch.outcome, fetch.reason])).toEqual([
      ["served", undefined],
      ["refused", "wardby_package_limit"],
    ]);
  });

  it("seeds served usage from the store", async () => {
    const store = new MemoryRegistryStore();
    await store.recordFetch({
      runId: "run-1",
      ecosystem: "fake",
      name: "app",
      version: "1.0.0",
      sizeBytes: tarball.byteLength,
      outcome: "served",
    });
    const { registry } = service({ store, limits: { maxFiles: 1 } });
    await expect(registry.handle(request("dl/app/1.0.0"))).resolves.toMatchObject({ status: 429 });
  });

  it("refuses and records a file hosted outside the adapter's own upstream hosts", async () => {
    const urls: string[] = [];
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { fake: ["app"] },
      policy: {},
    });
    const elsewhere: RegistryAdapter = {
      ...fakeAdapter,
      // files.pythonhosted.org is allowed for PyPI, never for this adapter.
      resolveDownload: (route, m) => {
        const file = m.versions.get(route.version)?.files[0];
        return file ? { ...file, upstreamUrl: "https://files.pythonhosted.org/evil.tgz" } : null;
      },
    };
    const registry = new RegistryService({
      adapters: new Map([["fake", elsewhere]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async (url) => {
        urls.push(url);
        return new Response(tarball);
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    const response = await registry.handle(request("dl/app/1.0.0"));
    expect(response).toMatchObject({ status: 502 });
    expect("body" in response && response.body).toContain("wardby_upstream_host_not_allowed");
    expect(urls).toEqual([]);
    expect(store.fetches).toMatchObject([{ outcome: "refused", reason: "wardby_upstream_host_not_allowed" }]);
  });
});

describe("RegistryService with the PyPI adapter: malformed paths", () => {
  it.each(["simple/%E0%A4%A/", "files/demo/demo-1.0-py3-none-any%E0%A4%A.whl", "simple/-bad-/", "simple/a%20b/"])(
    "answers %s with a recorded 400 wardby_bad_request",
    async (subpath) => {
      const store = new MemoryRegistryStore();
      store.contexts.set(capabilityHash("rrg_token"), {
        runId: "run-1",
        deadlineAt: new Date(NOW.getTime() + DAY),
        allowlist: { pypi: ["demo"] },
        policy: {},
      });
      const registry = new RegistryService({
        adapters: new Map([["pypi", pypiAdapter]]),
        store,
        audit: { audit: async () => NO_ADVISORIES },
        upstream: async () => {
          throw new Error("no upstream call expected");
        },
        proxyBase: "http://wardby-proxy:8787/registry/",
        limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
        now: () => NOW,
      });
      const response = await registry.handle({ ...request(subpath), ecosystem: "pypi" });
      expect(response).toMatchObject({ status: 400 });
      expect("body" in response && response.body).toContain("wardby_bad_request");
      expect(store.fetches).toMatchObject([{ outcome: "refused", reason: "wardby_bad_request" }]);
    },
  );
});

describe("RegistryService with the npm adapter: names are case-exact", () => {
  const old = new Date(NOW.getTime() - 30 * DAY).toISOString();
  const packument = (name: string, dependencies: Record<string, string> = {}) => ({
    name,
    time: { "1.0.0": old },
    versions: {
      "1.0.0": { dist: { tarball: `https://registry.npmjs.org/${name}/-/x-1.0.0.tgz` }, dependencies },
    },
  });

  function npmService(allowlist: string[]) {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { npm: allowlist },
      policy: {},
    });
    const urls: string[] = [];
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async (url) => {
        urls.push(url);
        const name = decodeURIComponent(url.slice("https://registry.npmjs.org/".length));
        return Response.json(packument(name, name === "app" ? { JSONStream: "^1" } : {}));
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    const get = (subpath: string) => registry.handle({ ...request(subpath), ecosystem: "npm" });
    return { get, urls, store };
  }

  it("allowing JSONStream does not allow jsonstream", async () => {
    const { get, urls } = npmService(["JSONStream"]);
    await expect(get("jsonstream")).resolves.toMatchObject({ status: 403 });
    await expect(get("JSONStream")).resolves.toMatchObject({ status: 200 });
    // Fetched twice, never as jsonstream: once trimmed by the graph walk
    // that refused jsonstream, then again with render data to serve it.
    expect(urls).toEqual(["https://registry.npmjs.org/JSONStream", "https://registry.npmjs.org/JSONStream"]);
  });

  it("allowing jsonstream does not allow JSONStream", async () => {
    const { get, urls } = npmService(["jsonstream"]);
    await expect(get("JSONStream")).resolves.toMatchObject({ status: 403 });
    await expect(get("jsonstream")).resolves.toMatchObject({ status: 200 });
    // Walk (trimmed) then render fetch, both of jsonstream only.
    expect(urls).toEqual(["https://registry.npmjs.org/jsonstream", "https://registry.npmjs.org/jsonstream"]);
  });

  it("a JSONStream dependency is allowed exactly and fetched from /JSONStream", async () => {
    const { get, urls, store } = npmService(["app"]);
    await expect(get("app")).resolves.toMatchObject({ status: 200 });
    expect(await store.isAllowedDependency("run-1", "npm", "JSONStream")).toBe(true);
    await expect(get("jsonstream")).resolves.toMatchObject({ status: 403 });
    await expect(get("JSONStream")).resolves.toMatchObject({ status: 200 });
    // JSONStream is fetched trimmed by the walk that refused jsonstream,
    // then with render data to serve it; never as jsonstream.
    expect(urls).toEqual([
      "https://registry.npmjs.org/app",
      "https://registry.npmjs.org/JSONStream",
      "https://registry.npmjs.org/JSONStream",
    ]);
  });
});

describe("RegistryService with the PyPI adapter: release age applies per file", () => {
  const wheelBytes = new TextEncoder().encode("wheel bytes");
  const sha256 = createHash("sha256").update(wheelBytes).digest("hex");
  const oldWheel = "demo-1.0-py3-none-any.whl";
  const newWheel = "demo-1.0-cp313-cp313-manylinux_2_17_x86_64.whl";
  const file = (filename: string, ageDays: number) => ({
    filename,
    url: `https://files.pythonhosted.org/packages/xx/${filename}`,
    hashes: { sha256 },
    "upload-time": new Date(NOW.getTime() - ageDays * DAY).toISOString(),
    size: wheelBytes.byteLength,
    "core-metadata": true,
  });

  function pypiService() {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { pypi: ["demo"] },
      policy: {},
    });
    const urls: string[] = [];
    const registry = new RegistryService({
      adapters: new Map([["pypi", pypiAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async (url) => {
        urls.push(url);
        if (url === "https://pypi.org/simple/demo/")
          // An old release (first uploaded 100 days ago) that gained a
          // brand-new wheel yesterday.
          return Response.json({ name: "demo", files: [file(oldWheel, 100), file(newWheel, 1)] });
        if (url.endsWith(".metadata"))
          return new Response("Metadata-Version: 2.1\nName: demo\nVersion: 1.0\nRequires-Dist: Werkzeug>=3\n");
        return new Response(wheelBytes);
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    const get = (subpath: string) => registry.handle({ ...request(subpath), ecosystem: "pypi" });
    return { get, urls, store };
  }

  it("hides the new wheel from the index and serves the old one", async () => {
    const { get } = pypiService();
    const index = await get("simple/demo/");
    if (!("body" in index)) throw new Error("expected a body");
    const listed = (JSON.parse(index.body) as { files: { filename: string }[] }).files.map((f) => f.filename);
    expect(listed).toEqual([oldWheel]);

    const served = await get(`files/demo/${oldWheel}`);
    if (!("stream" in served)) throw new Error("expected a stream");
    expect(new Uint8Array(await new Response(served.stream).arrayBuffer())).toEqual(wheelBytes);
  });

  it("serves the kept wheel's PEP 658 metadata and allows its dependencies", async () => {
    const { get, urls, store } = pypiService();
    const response = await get(`files/demo/${oldWheel}.metadata`);
    expect(response).toMatchObject({ status: 200, contentType: "text/plain" });
    if (!("stream" in response)) throw new Error("expected a stream");
    expect(await new Response(response.stream).text()).toContain("Requires-Dist: Werkzeug>=3");
    expect(urls).toContain(`https://files.pythonhosted.org/packages/xx/${oldWheel}.metadata`);
    expect(await store.isAllowedDependency("run-1", "pypi", "werkzeug")).toBe(true);
    expect(store.fetches).toMatchObject([{ outcome: "served", filename: `${oldWheel}.metadata` }]);
  });

  it("refuses and records the new wheel and its metadata file like a filtered version", async () => {
    const { get, urls, store } = pypiService();
    const refused = await get(`files/demo/${newWheel}`);
    expect(refused).toMatchObject({ status: 404 });
    expect("body" in refused && refused.body).toContain("wardby_version_filtered");
    await expect(get(`files/demo/${newWheel}.metadata`)).resolves.toMatchObject({ status: 404 });
    expect(urls.some((url) => url.endsWith(newWheel) || url.endsWith(`${newWheel}.metadata`))).toBe(false);
    expect(store.fetches.map((fetch) => [fetch.outcome, fetch.reason])).toEqual([
      ["refused", "wardby_version_filtered"],
      ["refused", "wardby_version_filtered"],
    ]);
  });
});

describe("RegistryService resolves the approved graph on demand (npm lockfile installs)", () => {
  const old = new Date(NOW.getTime() - 30 * DAY).toISOString();
  const fresh = new Date(NOW.getTime() - 1 * DAY).toISOString();
  const leafBytes = new TextEncoder().encode("leaf tarball");
  const leafIntegrity = `sha512-${createHash("sha512").update(leafBytes).digest("base64")}`;
  const version = (name: string, v: string, dependencies: Record<string, string> = {}) => ({
    dist: {
      tarball: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${v}.tgz`,
      integrity: leafIntegrity,
    },
    dependencies,
  });
  // app@^1 is allowlisted. 1.0.0 (old) depends on mid, which depends on
  // leaf: leaf is two levels deep. 2.0.0 is outside the root range and
  // 1.1.0 is newer than the release-age cutoff, so their dependencies
  // (ranged-out, too-new) are never part of the approved graph.
  const packuments: Record<string, unknown> = {
    app: {
      name: "app",
      time: { "1.0.0": old, "1.1.0": fresh, "2.0.0": old },
      versions: {
        "1.0.0": version("app", "1.0.0", { mid: "^1" }),
        "1.1.0": version("app", "1.1.0", { mid: "^1", "too-new": "^1" }),
        "2.0.0": version("app", "2.0.0", { "ranged-out": "^1" }),
      },
    },
    // mid@1.0.0 and mid@1.1.0 satisfy app's "^1"; mid@2.0.0 does not, so
    // only its dependency (mid-two-only) is outside the approved graph.
    mid: {
      name: "mid",
      time: { "1.0.0": old, "1.1.0": old, "2.0.0": old },
      versions: {
        "1.0.0": version("mid", "1.0.0", { leaf: "^1" }),
        "1.1.0": version("mid", "1.1.0", { "leaf-new": "^1" }),
        "2.0.0": version("mid", "2.0.0", { "mid-two-only": "^1" }),
      },
    },
    "leaf-new": { name: "leaf-new", time: { "1.0.0": old }, versions: { "1.0.0": version("leaf-new", "1.0.0") } },
    "mid-two-only": {
      name: "mid-two-only",
      time: { "1.0.0": old },
      versions: { "1.0.0": version("mid-two-only", "1.0.0") },
    },
    // Aliases mid under another key: the alias carries its own range.
    aliaser: {
      name: "aliaser",
      time: { "1.0.0": old },
      versions: { "1.0.0": version("aliaser", "1.0.0", { "mid-alias": "npm:mid@^2" }) },
    },
    // Asks for mid with a range no kept version satisfies.
    unsatisfied: {
      name: "unsatisfied",
      time: { "1.0.0": old },
      versions: { "1.0.0": version("unsatisfied", "1.0.0", { mid: "^9" }) },
    },
    // Asks for mid by dist-tag: not a range, so every kept version counts.
    tagged: {
      name: "tagged",
      time: { "1.0.0": old },
      versions: { "1.0.0": version("tagged", "1.0.0", { mid: "latest" }) },
    },
    leaf: { name: "leaf", time: { "1.0.0": old }, versions: { "1.0.0": version("leaf", "1.0.0") } },
    "ranged-out": {
      name: "ranged-out",
      time: { "1.0.0": old },
      versions: { "1.0.0": version("ranged-out", "1.0.0") },
    },
    "too-new": { name: "too-new", time: { "1.0.0": old }, versions: { "1.0.0": version("too-new", "1.0.0") } },
    stranger: { name: "stranger", time: { "1.0.0": old }, versions: { "1.0.0": version("stranger", "1.0.0") } },
  };

  function graphService(
    overrides: {
      allowlist?: string[];
      maxGraphPackages?: number;
      graphTimeoutMs?: number;
      hang?: string;
      gate?: Promise<void>;
      /** Upstream metadata failures per package name: a count of failing
       *  calls before it succeeds, or Infinity for always. */
      upstreamFailures?: Record<string, number>;
      /** Audit failures per package name, the same way. */
      auditFailures?: Record<string, number>;
      withheld?: Record<string, string[]>;
      store?: MemoryRegistryStore;
      now?: () => Date;
      maxGraphConcurrency?: number;
      /** Other runs sharing the same service: token -> npm allowlist. */
      otherRuns?: Record<string, string[]>;
      upstreamDelayMs?: number;
    } = {},
  ) {
    const store = overrides.store ?? new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { npm: overrides.allowlist ?? ["app@^1"] },
      policy: {},
    });
    for (const [token, allowlist] of Object.entries(overrides.otherRuns ?? {})) {
      store.contexts.set(capabilityHash(token), {
        runId: `run-${token}`,
        deadlineAt: new Date(NOW.getTime() + DAY),
        allowlist: { npm: allowlist },
        policy: {},
      });
    }
    const urls: string[] = [];
    const audited: string[] = [];
    const upstreamFailures = { ...overrides.upstreamFailures };
    const auditFailures = { ...overrides.auditFailures };
    let inFlight = 0;
    const concurrency = { max: 0 };
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: {
        audit: async (_adapter, name) => {
          audited.push(name);
          if ((auditFailures[name] ?? 0) > 0) {
            auditFailures[name] -= 1;
            throw new RegistryError(503, "wardby_audit_unavailable", `the audit for "${name}" is unreachable`);
          }
          const withheld = overrides.withheld?.[name] ?? [];
          return { withheld: (v: string) => (withheld.includes(v) ? ["GHSA-x"] : []), reported: () => [] };
        },
      },
      upstream: async (url, init) => {
        urls.push(url);
        if (url.endsWith(".tgz")) return new Response(leafBytes);
        const name = decodeURIComponent(url.slice("https://registry.npmjs.org/".length));
        if (name === overrides.hang)
          return new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error)),
          );
        if (overrides.gate) await overrides.gate;
        inFlight += 1;
        concurrency.max = Math.max(concurrency.max, inFlight);
        try {
          if (overrides.upstreamDelayMs) await new Promise((resolve) => setTimeout(resolve, overrides.upstreamDelayMs));
          if ((upstreamFailures[name] ?? 0) > 0) {
            upstreamFailures[name] -= 1;
            return new Response("busy", { status: 503 });
          }
          return packuments[name] ? Response.json(packuments[name]) : new Response("not found", { status: 404 });
        } finally {
          inFlight -= 1;
        }
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: overrides.now ?? (() => NOW),
      maxGraphConcurrency: overrides.maxGraphConcurrency,
      // No metadata caching, so an upstream call not made proves the walk
      // itself was memoized, not merely answered from the metadata cache.
      metadataTtlMs: 0,
      metadataTimeoutMs: 1_000,
      maxGraphPackages: overrides.maxGraphPackages,
      graphTimeoutMs: overrides.graphTimeoutMs,
    });
    const get = (subpath: string, token = "rrg_token") =>
      registry.handle({ ...request(subpath, token), ecosystem: "npm" });
    return { get, urls, audited, store, concurrency };
  }

  it("serves a transitive dependency's tarball, two levels deep, with no prior metadata request", async () => {
    const { get, store } = graphService();
    const response = await get("leaf/-/leaf-1.0.0.tgz");
    if (!("stream" in response)) throw new Error(`expected a stream, got ${JSON.stringify(response)}`);
    expect(new Uint8Array(await new Response(response.stream).arrayBuffer())).toEqual(leafBytes);
    expect(await store.isAllowedDependency("run-1", "npm", "mid")).toBe(true);
    expect(await store.isAllowedDependency("run-1", "npm", "leaf")).toBe(true);
    expect(store.fetches).toMatchObject([{ name: "leaf", version: "1.0.0", outcome: "served" }]);
  });

  it("refuses and records a package outside the graph", async () => {
    const { get, store } = graphService();
    const response = await get("stranger/-/stranger-1.0.0.tgz");
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed");
    expect("body" in response && response.body).not.toContain("cut short");
    expect(store.fetches).toMatchObject([
      { name: "stranger", outcome: "refused", reason: "wardby_package_not_allowed" },
    ]);
  });

  it.each([
    ["ranged-out", "a version outside the root range"],
    ["too-new", "a version newer than the release-age cutoff"],
  ])("refuses %s, reachable only through %s", async (name) => {
    const { get, store } = graphService();
    await expect(get(`${name}/-/${name}-1.0.0.tgz`)).resolves.toMatchObject({ status: 403 });
    await expect(get(name)).resolves.toMatchObject({ status: 403 });
    expect(await store.isAllowedDependency("run-1", "npm", name)).toBe(false);
  });

  it("answers a definitive 403 wardby_graph_limit, never not-allowed and never a retryable 503, when the package bound trips", async () => {
    // app and mid fit in the bound; leaf, a third package, does not.
    const { get, store } = graphService({ maxGraphPackages: 2 });
    const response = await get("leaf/-/leaf-1.0.0.tgz");
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_graph_limit");
    expect("body" in response && response.body).toContain("retrying will not help");
    expect("body" in response && response.body).not.toContain("wardby_package_not_allowed");
    expect(store.fetches).toMatchObject([{ name: "leaf", outcome: "refused", reason: "wardby_graph_limit" }]);
    // The bound is permanent for the run: a retry gets the same definitive answer.
    await expect(get("leaf/-/leaf-1.0.0.tgz")).resolves.toMatchObject({ status: 403 });
    // mid was found before the bound tripped, so it stays allowed.
    await expect(get("mid")).resolves.toMatchObject({ status: 200 });
  });

  it("answers 503 wardby_graph_incomplete, never not-allowed, when the walk times out", async () => {
    const { get } = graphService({ hang: "mid", graphTimeoutMs: 30 });
    const response = await get("leaf");
    expect(response).toMatchObject({ status: 503 });
    expect("body" in response && response.body).toContain("wardby_graph_incomplete");
    expect("body" in response && response.body).toContain("cut short by its time limit");
    expect("body" in response && response.body).not.toContain("wardby_package_not_allowed");
    expect("body" in response && response.body).not.toContain("not found");
  });

  it("serves a name on retry once a timed-out walk resumes and reaches it", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { get, store } = graphService({ gate, graphTimeoutMs: 30 });
    await expect(get("leaf/-/leaf-1.0.0.tgz")).resolves.toMatchObject({ status: 503 });
    open();
    const retried = await get("leaf/-/leaf-1.0.0.tgz");
    if (!("stream" in retried)) throw new Error(`expected a stream, got ${JSON.stringify(retried)}`);
    await new Response(retried.stream).arrayBuffer();
    expect(store.fetches).toMatchObject([
      { name: "leaf", outcome: "refused", reason: "wardby_graph_incomplete" },
      { name: "leaf", outcome: "served" },
    ]);
  });

  it("shares one walk between concurrent misses", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { get, audited } = graphService({ gate });
    const both = Promise.all([get("stranger"), get("stranger"), get("leaf")]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    open();
    const [first, second, third] = await both;
    expect(first).toMatchObject({ status: 403 });
    expect(second).toMatchObject({ status: 403 });
    expect(third, JSON.stringify(third)).toMatchObject({ status: 200 });
    // Each node of the graph was expanded (and audited) once; the extra
    // "leaf" is the served request's own metadata path.
    expect(audited.filter((name) => name === "app")).toHaveLength(1);
    expect(audited.filter((name) => name === "mid")).toHaveLength(1);
  });

  it("memoizes the walk: a second miss makes no upstream calls", async () => {
    const { get, urls } = graphService();
    await expect(get("stranger")).resolves.toMatchObject({ status: 403 });
    const before = urls.length;
    expect(before).toBeGreaterThan(0);
    await expect(get("stranger")).resolves.toMatchObject({ status: 403 });
    await expect(get("other-stranger/-/other-stranger-1.0.0.tgz")).resolves.toMatchObject({ status: 403 });
    expect(urls).toHaveLength(before);
  });

  it("does not start a walk from a scoped wildcard root", async () => {
    const { get, urls } = graphService({ allowlist: ["@scope/*"] });
    await expect(get("stranger")).resolves.toMatchObject({ status: 403 });
    expect(urls).toEqual([]);
  });

  it("retries a node whose metadata fails once, and finds the name", async () => {
    const { get } = graphService({ upstreamFailures: { mid: 1 } });
    await expect(get("leaf")).resolves.toMatchObject({ status: 200 });
  });

  it("retries a node whose audit fails once, and finds the name", async () => {
    const { get } = graphService({ auditFailures: { mid: 1 } });
    await expect(get("leaf")).resolves.toMatchObject({ status: 200 });
  });

  it("answers 502 wardby_upstream_error, not package_not_allowed, when a node's metadata stays unavailable", async () => {
    const { get, store } = graphService({ upstreamFailures: { mid: Infinity } });
    const response = await get("leaf/-/leaf-1.0.0.tgz");
    expect(response).toMatchObject({ status: 502 });
    const body = "body" in response ? response.body : "";
    expect(body).toContain("wardby_upstream_error");
    expect(body).toContain("try again");
    expect(body).not.toContain("wardby_package_not_allowed");
    expect(store.fetches).toMatchObject([{ name: "leaf", outcome: "refused", reason: "wardby_upstream_error" }]);
  });

  it("answers 503 wardby_audit_unavailable when a node's audit stays unavailable", async () => {
    const { get, store } = graphService({ auditFailures: { mid: Infinity } });
    const response = await get("leaf");
    expect(response).toMatchObject({ status: 503 });
    expect("body" in response && response.body).toContain("wardby_audit_unavailable");
    expect(store.fetches).toMatchObject([{ name: "leaf", outcome: "refused", reason: "wardby_audit_unavailable" }]);
  });

  it("retries a failed node on a later miss, with a per-run cap on attempts", async () => {
    const { get, urls } = graphService({ upstreamFailures: { mid: 2 } });
    // Two attempts in the first walk both fail; the next miss retries and finds it.
    await expect(get("leaf")).resolves.toMatchObject({ status: 502 });
    await expect(get("leaf")).resolves.toMatchObject({ status: 200 });
    const always = graphService({ upstreamFailures: { mid: Infinity } });
    for (let i = 0; i < 5; i += 1) await always.get("leaf");
    expect(always.urls.filter((url) => url.endsWith("/mid")).length).toBeLessThanOrEqual(4);
    expect(urls.filter((url) => url.endsWith("/mid")).length).toBe(3);
  });

  it("does not follow the dependencies of a version withheld by the audit", async () => {
    const { get, store } = graphService({ withheld: { mid: ["1.0.0"] } });
    await expect(get("leaf")).resolves.toMatchObject({ status: 403 });
    expect(await store.isAllowedDependency("run-1", "npm", "leaf")).toBe(false);
  });

  it("keeps walk state per run: another run's allowlist does not widen this one", async () => {
    const { get } = graphService({ allowlist: ["stranger"], otherRuns: { rrg_other: ["app@^1"] } });
    await expect(get("leaf", "rrg_other")).resolves.toMatchObject({ status: 200 });
    await expect(get("leaf")).resolves.toMatchObject({ status: 403 });
    await expect(get("mid")).resolves.toMatchObject({ status: 403 });
  });

  it("re-queues the batch and returns the error when an allowance write fails", async () => {
    const store = new MemoryRegistryStore();
    const addAllowances = store.addAllowances.bind(store);
    let failWrites = true;
    store.addAllowances = async (...args) => {
      if (failWrites) throw new Error("database down");
      return addAllowances(...args);
    };
    const { get } = graphService({ store });
    const failed = await get("leaf");
    expect(failed).toMatchObject({ status: 502 });
    failWrites = false;
    await expect(get("leaf")).resolves.toMatchObject({ status: 200 });
    expect(await store.isAllowedDependency("run-1", "npm", "mid")).toBe(true);
  });

  it("uses the injected clock for the walk deadline", async () => {
    let tick = 0;
    const { get, urls } = graphService({
      graphTimeoutMs: 1_000,
      now: () => new Date(NOW.getTime() + (tick += 5_000)),
    });
    const response = await get("leaf");
    expect(response).toMatchObject({ status: 503 });
    expect("body" in response && response.body).toContain("cut short by its time limit");
    expect(urls).toEqual([]);
  });

  it("caps concurrent walk fetches across every run", async () => {
    const { get, concurrency } = graphService({
      allowlist: ["app@^1", "mid", "leaf", "ranged-out", "too-new"],
      otherRuns: { rrg_other: ["app@^1", "mid", "leaf", "ranged-out", "too-new"] },
      maxGraphConcurrency: 2,
      upstreamDelayMs: 5,
    });
    await Promise.all([get("stranger"), get("stranger", "rrg_other")]);
    expect(concurrency.max).toBeLessThanOrEqual(2);
  });

  it("does not allow the dependencies of a dependency's version outside the declared range", async () => {
    const { get, store } = graphService();
    await expect(get("mid-two-only/-/mid-two-only-1.0.0.tgz")).resolves.toMatchObject({ status: 403 });
    expect(await store.isAllowedDependency("run-1", "npm", "mid-two-only")).toBe(false);
  });

  it("allows the dependencies of every in-range version, so a lockfile pinned to an older one still works", async () => {
    const { get, store } = graphService();
    // mid@1.1.0 is the newest in-range version; a lockfile may pin mid@1.0.0.
    await expect(get("leaf-new/-/leaf-new-1.0.0.tgz")).resolves.toMatchObject({ status: 200 });
    await expect(get("leaf/-/leaf-1.0.0.tgz")).resolves.toMatchObject({ status: 200 });
    expect(await store.isAllowedDependency("run-1", "npm", "leaf")).toBe(true);
  });

  it("follows an alias to its target under the alias's own range", async () => {
    const { get, store } = graphService({ allowlist: ["aliaser"] });
    await expect(get("mid-two-only")).resolves.toMatchObject({ status: 200 });
    // ^2 excludes mid 1.x, so their dependencies are not in this graph.
    await expect(get("leaf")).resolves.toMatchObject({ status: 403 });
    await expect(get("leaf-new")).resolves.toMatchObject({ status: 403 });
    expect(await store.isAllowedDependency("run-1", "npm", "mid")).toBe(true);
    expect(await store.isAllowedDependency("run-1", "npm", "mid-alias")).toBe(false);
  });

  it("contributes nothing for a range no kept version satisfies", async () => {
    const { get, store } = graphService({ allowlist: ["unsatisfied"] });
    await expect(get("leaf")).resolves.toMatchObject({ status: 403 });
    expect(await store.isAllowedDependency("run-1", "npm", "mid")).toBe(false);
  });

  it("treats a dist-tag (or any non-range spec) as every kept version", async () => {
    const { get } = graphService({ allowlist: ["tagged"] });
    await expect(get("mid-two-only")).resolves.toMatchObject({ status: 200 });
    await expect(get("leaf")).resolves.toMatchObject({ status: 200 });
  });

  it("expands each version of a package once, however many ranges reach it", async () => {
    const { get, audited } = graphService({ allowlist: ["app@^1", "tagged", "aliaser"] });
    await expect(get("stranger")).resolves.toMatchObject({ status: 403 });
    // mid is reached under ^1, latest and ^2: three edges, but its node is
    // expanded (and audited) once per range and its versions never twice.
    expect(audited.filter((name) => name === "leaf")).toHaveLength(1);
  });

  it("makes no walk calls for PyPI, whose index carries no dependencies", async () => {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { pypi: ["demo"] },
      policy: {},
    });
    const urls: string[] = [];
    const registry = new RegistryService({
      adapters: new Map([["pypi", pypiAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async (url) => {
        urls.push(url);
        return new Response("unexpected", { status: 500 });
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    const response = await registry.handle({ ...request("simple/stranger/"), ecosystem: "pypi" });
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed");
    expect(urls).toEqual([]);
  });
});

describe("RegistryService graph walk hardening", () => {
  it("never follows a dependency key that is not a valid package name", async () => {
    const old = new Date(NOW.getTime() - 30 * DAY).toISOString();
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { npm: ["app"] },
      policy: {},
    });
    const urls: string[] = [];
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async (url) => {
        urls.push(url);
        return Response.json({
          name: "app",
          time: { "1.0.0": old },
          versions: {
            "1.0.0": {
              dist: { tarball: "https://registry.npmjs.org/app/-/app-1.0.0.tgz" },
              dependencies: { "../../evil": "1", "a b": "1" },
            },
          },
        });
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    await expect(registry.handle({ ...request("stranger"), ecosystem: "npm" })).resolves.toMatchObject({
      status: 403,
    });
    expect(urls).toEqual(["https://registry.npmjs.org/app"]);
  });
});

describe("RegistryService metadata path dependency names", () => {
  it("records neither invalid names nor alias keys as allowances, only the alias target", async () => {
    const old = new Date(NOW.getTime() - 30 * DAY).toISOString();
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { npm: ["app"] },
      policy: {},
    });
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async () =>
        Response.json({
          name: "app",
          time: { "1.0.0": old },
          versions: {
            "1.0.0": {
              dist: { tarball: "https://registry.npmjs.org/app/-/app-1.0.0.tgz" },
              dependencies: {
                "../../evil": "1",
                "string-width-cjs": "npm:string-width@^4",
                local: "file:../local",
                ok: "^1",
              },
            },
          },
        }),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    await expect(registry.handle({ ...request("app"), ecosystem: "npm" })).resolves.toMatchObject({ status: 200 });
    expect([...store.allowances].map((key) => key.split("\0")[2]).sort()).toEqual(["ok", "string-width"]);
  });
});

describe("RegistryService memory: nothing retains a parsed packument, and run state is released", () => {
  const old = new Date(NOW.getTime() - 30 * DAY).toISOString();
  /** A packument with bulk the proxy never reads (readmes, license texts,
   *  maintainers) on every version. */
  const packument = (name: string, dependencies: Record<string, string> = {}) => {
    const versions: Record<string, unknown> = {};
    const time: Record<string, string> = {};
    for (let minor = 0; minor < 50; minor += 1) {
      const version = `1.${minor}.0`;
      time[version] = old;
      versions[version] = {
        name,
        version,
        description: "d".repeat(1_000),
        licenseText: "l".repeat(20_000),
        maintainers: [{ name: "someone", email: "someone@example.test" }],
        scripts: { test: "vitest" },
        dependencies,
        dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, shasum: "a".repeat(40) },
      };
    }
    return { name, readme: "r".repeat(50_000), time, versions };
  };
  const packuments: Record<string, unknown> = {
    app: packument("app", { mid: "^1" }),
    mid: packument("mid", { leaf: "^1" }),
    leaf: packument("leaf"),
  };

  function memoryService(deadlineAt = new Date(NOW.getTime() + DAY), now: () => Date = () => NOW) {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt,
      allowlist: { npm: ["app"] },
      policy: {},
    });
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async (url) => {
        const name = decodeURIComponent(url.slice("https://registry.npmjs.org/".length));
        return Response.json(packuments[name]);
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now,
    });
    const get = (subpath: string) => registry.handle({ ...request(subpath), ecosystem: "npm" });
    const internals = registry as unknown as {
      metadataCache: Map<string, { bytes: number; meta: PackageMetadata }>;
      tallies: Map<string, { graphs?: Map<string, { released?: boolean }> }>;
    };
    return { registry, get, internals };
  }

  it("lets every object of each parsed packument be collected after a walk and a metadata request", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    // Weakly track every object in every document the adapter parses.
    const parsed: WeakRef<object>[] = [];
    const track = (value: unknown) => {
      if (value === null || typeof value !== "object") return;
      parsed.push(new WeakRef(value));
      for (const child of Object.values(value)) track(child);
    };
    // Patched by hand, not vi.spyOn: a spy keeps every result it returned.
    const prototype = Response.prototype as { json: () => Promise<unknown> };
    const json = prototype.json;
    prototype.json = async function (this: Response) {
      const doc: unknown = await json.call(this);
      track(doc);
      return doc;
    };
    try {
      const { get, internals } = memoryService();
      // Serving leaf's document walks the graph (trimmed fetches of app and
      // mid, then a render fetch of leaf); serving app's re-fetches it to
      // render.
      await expect(get("leaf")).resolves.toMatchObject({ status: 200 });
      await expect(get("app")).resolves.toMatchObject({ status: 200 });
      expect(internals.metadataCache.size).toBe(3);
      expect(parsed.length).toBeGreaterThan(4 * 50);
      // WeakRef targets stay alive until the job that created them ends.
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
      expect(parsed.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
      // The cache holds only trimmed facts, and render data only for the
      // two documents served.
      for (const [key, { meta }] of internals.metadataCache) {
        for (const info of meta.versions.values()) {
          expect(Object.keys(info).sort()).toEqual(["dependencies", "dependencySpecs", "files", "version"]);
          for (const file of info.files)
            expect(Object.keys(file).sort()).toEqual(
              ["allowed", "filename", "integrity", "publishedAt", "sizeBytes", "upstreamUrl", "version"].sort(),
            );
        }
        expect(meta.raw === undefined).toBe(key === "npm:mid");
      }
    } finally {
      prototype.json = json;
    }
  });

  it("releases a run's walk state when its deadline passes, with no other request", async () => {
    let clock = NOW;
    const { get, internals } = memoryService(new Date(NOW.getTime() + 50), () => clock);
    // No real-time race: while the injected clock stays at NOW, a timer that
    // fires early only re-arms (scheduleRelease checks this.now() against the
    // deadline), so the walk below cannot be released mid-walk however slow
    // the machine is.
    await expect(get("leaf")).resolves.toMatchObject({ status: 200 });
    const walk = internals.tallies.get("run-1")?.graphs?.get("npm");
    expect(walk).toBeDefined();
    clock = new Date(NOW.getTime() + 60);
    // The release timer fires at the deadline (50 ms); poll, since a loaded
    // test machine may run it late.
    for (let waited = 0; internals.tallies.size > 0 && waited < 2_000; waited += 20)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(internals.tallies.size).toBe(0);
    expect(walk?.released).toBe(true);
  });

  it("bounds the metadata cache by bytes as well as entries", async () => {
    const { registry, get, internals } = memoryService();
    (registry as unknown as { metadataCacheBytes: number }).metadataCacheBytes = 1;
    await expect(get("app")).resolves.toMatchObject({ status: 200 });
    // One entry is larger than the whole budget: it is served, not cached.
    expect(internals.metadataCache.size).toBe(0);
  });
});
