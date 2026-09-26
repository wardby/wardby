import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RegistryError,
  type Integrity,
  type RegistryAdapter,
  type PackageMetadata,
} from "../../../coding/registry/types.js";
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
          publishedAt: info.ageDays === null ? null : new Date(NOW.getTime() - info.ageDays * DAY),
          dependencies: info.deps ?? [],
          files: [
            {
              filename: `${version}.tgz`,
              version,
              upstreamUrl: `https://upstream.test/${name}/${version}.tgz`,
              integrity: info.integrity === undefined ? { algorithm: "sha512", hex: sha512 } : info.integrity,
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
    limits?: { maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number; idleTimeoutMs?: number };
    upstream?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
    allowlist?: Record<string, string[]>;
    audit?: () => Promise<AdvisoryIndex>;
  } = {},
) {
  const store = new MemoryRegistryStore();
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
      listFetches: (runId) => inner.listFetches(runId),
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
