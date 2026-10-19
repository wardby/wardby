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
import { refusalHint } from "../../../coding/registry/refusal-hints.js";
import { capabilityHash } from "../proxy.js";
import { auditAdvisoryOf, splitWaived, type WithheldAdvisory } from "./audit.js";
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
  // Not allowlisted, too new to pass the default release age.
  fresh: meta("fresh", { "1.0.0": { ageDays: 1 } }),
  // Not allowlisted, with a dependency of its own.
  parent: meta("parent", { "1.0.0": { ageDays: 10, deps: ["child"] } }),
  child: meta("child", { "1.0.0": { ageDays: 10 } }),
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
  withheld: (version: string, accepted?: ReadonlySet<string>, auditAll?: boolean) => readonly string[];
  waived: (version: string, accepted: ReadonlySet<string>) => readonly string[];
  reported: (version: string) => readonly string[];
  audited?: (
    version: string,
    accepted: ReadonlySet<string>,
  ) => readonly { id: string; severity: string; summary: string }[];
};
const NO_ADVISORIES: AdvisoryIndex = { withheld: () => [], waived: () => [], reported: () => [] };

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
    audit?: (adapter: unknown, name: string) => Promise<AdvisoryIndex>;
    policy?: unknown;
    packageAudit?: "audit" | "full" | null;
    adapter?: RegistryAdapter;
  } = {},
) {
  const store = overrides.store ?? new MemoryRegistryStore();
  store.contexts.set(capabilityHash("rrg_token"), {
    runId: "run-1",
    deadlineAt: new Date(NOW.getTime() + DAY),
    allowlist: overrides.allowlist ?? { fake: ["app"] },
    policy: overrides.policy ?? {},
    repository: "owner/repo",
    cacheImage: null,
    dependencyCache: false,
    packageAudit: overrides.packageAudit ?? null,
  });
  const registry = new RegistryService({
    adapters: new Map([["fake", overrides.adapter ?? fakeAdapter]]),
    store,
    audit: {
      audit:
        overrides.audit ??
        (async () => ({
          withheld: (version: string) => ((overrides.withheld ?? []).includes(version) ? ["GHSA-x"] : []),
          waived: () => [],
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
    });
    const store: RegistryStore = {
      findRunByRegistryTokenHash: (hash, now) => inner.findRunByRegistryTokenHash(hash, now),
      isAllowedDependency: (runId, ecosystem, name) => inner.isAllowedDependency(runId, ecosystem, name),
      findAllowance: (runId, ecosystem, name) => inner.findAllowance(runId, ecosystem, name),
      addAllowances: (runId, ecosystem, names) => inner.addAllowances(runId, ecosystem, names),
      addAuditedAllowances: (runId, ecosystem, names, via) => inner.addAuditedAllowances(runId, ecosystem, names, via),
      recordAudit: (record) => inner.recordAudit(record),
      allowedExtras: (runId, ecosystem, name) => inner.allowedExtras(runId, ecosystem, name),
      addExtraAllowances: (runId, ecosystem, dependencies) => inner.addExtraAllowances(runId, ecosystem, dependencies),
      recordFetch: async () => {
        throw new Error("simulated database error");
      },
      usage: (runId) => inner.usage(runId),
      refusalCount: (runId) => inner.refusalCount(runId),
      listFetches: (runId) => inner.listFetches(runId),
      listRecentRefusals: (runId, since, limit) => inner.listRecentRefusals(runId, since, limit),
      getVersionFacts: (ecosystem, versions) => inner.getVersionFacts(ecosystem, versions),
      putVersionFacts: (ecosystem, facts) => inner.putVersionFacts(ecosystem, facts),
      approveVersions: (runId, ecosystem, versions) => inner.approveVersions(runId, ecosystem, versions),
      findApprovedVersion: (runId, ecosystem, name, version) =>
        inner.findApprovedVersion(runId, ecosystem, name, version),
      refusePlanVersions: (runId, ecosystem, versions) => inner.refusePlanVersions(runId, ecosystem, versions),
      findPlanRefusal: (runId, ecosystem, name, version) => inner.findPlanRefusal(runId, ecosystem, name, version),
      recordDependencyCacheLockHash: (runId, lockHash, max) =>
        inner.recordDependencyCacheLockHash(runId, lockHash, max),
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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

describe("RegistryService file-metadata misses", () => {
  it("refuses a file-metadata request for a reachable name at once, without walking", async () => {
    // An adapter that walks (dependencies in metadata) and serves per-file
    // metadata: dep is reachable through the root app.
    const fetched: string[] = [];
    const adapter: RegistryAdapter = {
      ...fakeAdapter,
      route: (method, subpath, headers) => {
        const match = subpath.match(/^fm\/([^/]+)\/([^/]+)$/);
        return match
          ? { kind: "file-metadata", name: match[1], filename: match[2] }
          : fakeAdapter.route(method, subpath, headers);
      },
      fetchMetadata: async (name) => {
        fetched.push(name);
        return catalog[name];
      },
    };
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { fake: ["app"] },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
    });
    const registry = new RegistryService({
      adapters: new Map([["fake", adapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async () => new Response(tarball),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    const response = await registry.handle(request("fm/dep/1.0.0.tgz"));
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed:");
    expect(fetched).toEqual([]);
    // A download of the same name still walks (through app) and is served.
    const download = await registry.handle(request("dl/dep/1.0.0"));
    expect(download).toMatchObject({ status: 200 });
    if ("stream" in download) await download.stream.cancel();
    expect(fetched).toContain("app");
  });
});

describe("RegistryService accepted advisories (packagePolicy.acceptedAdvisories)", () => {
  /** An advisory index over fixed blocking advisories per `name@version`,
   *  waiving through audit.ts's own splitWaived (malware never waived). */
  const advisoryIndex =
    (byVersion: Record<string, WithheldAdvisory[]>) =>
    async (_adapter: unknown, name: string): Promise<AdvisoryIndex> => {
      const of = (version: string) => byVersion[`${name}@${version}`] ?? [];
      return {
        withheld: (version, accepted) => splitWaived(of(version), accepted).withheld.map(({ id }) => id),
        waived: (version, accepted) => splitWaived(of(version), accepted).waived.map(({ id }) => id),
        reported: () => [],
      };
    };
  const high = (id: string, aliases: string[] = []): WithheldAdvisory => ({ id, malware: false, aliases });
  const accepting = (...ids: string[]) => ({ acceptedAdvisories: ids });
  const drain = async (response: Awaited<ReturnType<RegistryService["handle"]>>) => {
    if (!("stream" in response)) throw new Error(`expected a stream, got ${response.status}`);
    return new Uint8Array(await new Response(response.stream).arrayBuffer());
  };

  it("refuses a HIGH-only version without the policy, and records no waiver", async () => {
    const { registry, store } = service({ audit: advisoryIndex({ "app@1.0.0": [high("GHSA-high")] }) });
    await expect(registry.handle(request("app"))).resolves.toMatchObject({ status: 404 });
    await expect(registry.handle(request("dl/app/1.0.0"))).resolves.toMatchObject({ status: 404 });
    expect(store.fetches.at(-1)).toMatchObject({ outcome: "refused", reason: "wardby_version_filtered" });
    expect(store.fetches.some((fetch) => fetch.outcome === "served")).toBe(false);
  });

  it("serves it when the policy accepts the advisory (by id or alias), recording the waiver on the served row", async () => {
    for (const accepted of ["GHSA-high", "CVE-2026-1"]) {
      const { registry, store } = service({
        audit: advisoryIndex({ "app@1.0.0": [high("GHSA-high", ["CVE-2026-1"])] }),
        policy: accepting(accepted),
      });
      await expect(registry.handle(request("app"))).resolves.toMatchObject({
        status: 200,
        body: JSON.stringify(["1.0.0"]),
      });
      expect(await drain(await registry.handle(request("dl/app/1.0.0")))).toEqual(tarball);
      expect(store.fetches.at(-1)).toEqual({
        runId: "run-1",
        ecosystem: "fake",
        name: "app",
        version: "1.0.0",
        filename: "1.0.0.tgz",
        integrity: `sha512:${sha512}`,
        sizeBytes: tarball.byteLength,
        outcome: "served",
        reason: "accepted advisories: GHSA-high",
        createdAt: expect.any(Date),
      });
    }
  });

  it("records no reason for a served version that needed no waiver, whatever the policy accepts", async () => {
    const { registry, store } = service({ audit: advisoryIndex({}), policy: accepting("GHSA-high") });
    await drain(await registry.handle(request("dl/app/1.0.0")));
    expect(store.fetches.at(-1)).toMatchObject({ outcome: "served" });
    expect(store.fetches.at(-1)).not.toHaveProperty("reason");
  });

  it("never serves malware, even when the policy lists its id or alias", async () => {
    const malware: WithheldAdvisory = { id: "GHSA-mal", malware: true, aliases: ["MAL-2026-1"] };
    const { registry, store } = service({
      audit: advisoryIndex({ "app@1.0.0": [malware] }),
      policy: accepting("GHSA-mal"),
    });
    await expect(registry.handle(request("app"))).resolves.toMatchObject({ status: 404 });
    const download = await registry.handle(request("dl/app/1.0.0"));
    expect(download).toMatchObject({ status: 404 });
    expect("body" in download && download.body).toContain("wardby_version_filtered");
    expect(store.fetches.some((fetch) => fetch.outcome === "served")).toBe(false);
  });

  it("still refuses a version with two advisories when only one is accepted", async () => {
    const { registry, store } = service({
      audit: advisoryIndex({ "app@1.0.0": [high("GHSA-one"), high("GHSA-two")] }),
      policy: accepting("GHSA-one"),
    });
    const download = await registry.handle(request("dl/app/1.0.0"));
    expect(download).toMatchObject({ status: 404 });
    expect("body" in download && download.body).toContain("wardby_version_filtered");
    expect(store.fetches.at(-1)).toMatchObject({ outcome: "refused", reason: "wardby_version_filtered" });
  });

  it("without the policy, the graph walk does not follow a withheld version's dependencies", async () => {
    const { registry, store } = service({ audit: advisoryIndex({ "app@1.0.0": [high("GHSA-high")] }) });
    await expect(registry.handle(request("dl/dep/1.0.0"))).resolves.toMatchObject({ status: 403 });
    expect(await store.isAllowedDependency("run-1", "fake", "dep")).toBe(false);
  });

  it("waives in the graph walk too: a dependency kept only by a waiver is in the approved graph", async () => {
    // dep is reachable only through app@1.0.0, which carries an accepted
    // advisory; without the policy the walk never reaches it.
    const { registry, store } = service({
      audit: advisoryIndex({ "app@1.0.0": [high("GHSA-high")] }),
      policy: accepting("GHSA-high"),
    });
    // Straight to dep's download (a lockfile install): the walk must find it via app@1.0.0.
    const response = await registry.handle(request("dl/dep/1.0.0"));
    expect(await drain(response)).toEqual(tarball);
    expect(await store.isAllowedDependency("run-1", "fake", "dep")).toBe(true);
    // dep itself needed no waiver: its served row carries no reason.
    expect(store.fetches.at(-1)).toMatchObject({ name: "dep", outcome: "served" });
    expect(store.fetches.at(-1)).not.toHaveProperty("reason");
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
        repository: "owner/repo",
        cacheImage: null,
        dependencyCache: false,
        packageAudit: null,
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
    // jsonstream is refused without any upstream call; JSONStream is
    // fetched once, to serve it.
    expect(urls).toEqual(["https://registry.npmjs.org/JSONStream"]);
  });

  it("allowing jsonstream does not allow JSONStream", async () => {
    const { get, urls } = npmService(["jsonstream"]);
    await expect(get("JSONStream")).resolves.toMatchObject({ status: 403 });
    await expect(get("jsonstream")).resolves.toMatchObject({ status: 200 });
    // Only jsonstream is ever fetched.
    expect(urls).toEqual(["https://registry.npmjs.org/jsonstream"]);
  });

  it("a JSONStream dependency is allowed exactly and fetched from /JSONStream", async () => {
    const { get, urls, store } = npmService(["app"]);
    await expect(get("app")).resolves.toMatchObject({ status: 200 });
    expect(await store.isAllowedDependency("run-1", "npm", "JSONStream")).toBe(true);
    await expect(get("jsonstream")).resolves.toMatchObject({ status: 403 });
    await expect(get("JSONStream")).resolves.toMatchObject({ status: 200 });
    // jsonstream is refused without any upstream call; never fetched.
    expect(urls).toEqual(["https://registry.npmjs.org/app", "https://registry.npmjs.org/JSONStream"]);
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

  function pypiService(indexFiles?: () => unknown[]) {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { pypi: ["demo"] },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
          return Response.json({ name: "demo", files: indexFiles?.() ?? [file(oldWheel, 100), file(newWheel, 1)] });
        if (url.endsWith(".metadata"))
          return new Response("Metadata-Version: 2.1\nName: demo\nVersion: 1.0\nRequires-Dist: Werkzeug>=3\n");
        return new Response(wheelBytes);
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    const get = (subpath: string) => registry.handle({ ...request(subpath), ecosystem: "pypi" });
    return { get, urls, store, registry };
  }

  const listed = (refusals: Awaited<ReturnType<RegistryService["refusals"]>>) =>
    JSON.parse(refusals.body) as { refusals: { name: string; code: string; hint?: string }[] };

  it("records an index whose kept versions have no wheel to serve, and still answers it (sdists listed, never served)", async () => {
    const sdist = { ...file("demo-1.0.tar.gz", 100) };
    const { get, store, urls } = pypiService(() => [sdist]);
    const index = await get("simple/demo/");
    expect(index).toMatchObject({ status: 200 });
    if (!("body" in index)) throw new Error("expected a body");
    const listed = JSON.parse(index.body) as { files: { filename: string; "core-metadata"?: unknown }[] };
    expect(listed.files.map((entry) => entry.filename)).toEqual(["demo-1.0.tar.gz"]);
    expect(listed.files[0]["core-metadata"]).toBeUndefined();
    expect(store.fetches.map((fetch) => [fetch.outcome, fetch.name, fetch.reason])).toEqual([
      ["refused", "demo", "wardby_file_not_allowed"],
    ]);
    await expect(get("files/demo/demo-1.0.tar.gz")).resolves.toMatchObject({ status: 403 });
    expect(urls.some((url) => url.endsWith(".tar.gz"))).toBe(false);

    const tooNew = pypiService(() => [file(newWheel, 1)]);
    await tooNew.get("simple/demo/");
    expect(tooNew.store.fetches.map((fetch) => fetch.reason)).toEqual(["wardby_version_filtered"]);
  });

  it("records nothing for an index that still lists a wheel", async () => {
    const { get, store } = pypiService();
    await get("simple/demo/");
    expect(store.fetches).toEqual([]);
  });

  it("lists the run's recent refusals once each, with the shared hint, for the run's token only", async () => {
    const { get, registry } = pypiService(() => [file("demo-1.0.tar.gz", 100)]);
    await get("simple/demo/");
    await get("simple/demo/");
    await get("simple/flask/");
    const answer = await registry.refusals({ token: "rrg_token" });
    expect(answer).toMatchObject({ status: 200, contentType: "application/json" });
    expect(listed(answer).refusals).toEqual([
      {
        ecosystem: "pypi",
        name: "flask",
        code: "wardby_package_not_allowed",
        hint: refusalHint("wardby_package_not_allowed"),
      },
      {
        ecosystem: "pypi",
        name: "demo",
        code: "wardby_file_not_allowed",
        hint: refusalHint("wardby_file_not_allowed"),
      },
    ]);
    // Only refusals at or after `since`.
    expect(
      listed(await registry.refusals({ token: "rrg_token", since: new Date(Date.now() + 60_000) })).refusals,
    ).toEqual([]);
    await expect(registry.refusals({ token: "nope" })).resolves.toMatchObject({ status: 401 });
  });

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

describe("RegistryService with the PyPI adapter: allowlisted extras", () => {
  const body = new TextEncoder().encode("wheel bytes");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const wheel = (name: string) => `${name.replace(/-/g, "_")}-1.0-py3-none-any.whl`;
  // psycopg's real extra-gated Requires-Dist shapes; app needs uvicorn with
  // its "standard" extra; uvicorn's own metadata says what that extra adds.
  const metadata: Record<string, string> = {
    psycopg: [
      "Name: psycopg",
      'Requires-Dist: typing-extensions>=4.6; python_version < "3.13"',
      'Requires-Dist: psycopg-binary==1.0; implementation_name != "pypy" and extra == "binary"',
      'Requires-Dist: psycopg-c==1.0; implementation_name != "pypy" and extra == "c"',
      'Requires-Dist: psycopg-pool; extra == "pool"',
    ].join("\n"),
    app: "Name: app\nRequires-Dist: uvicorn[standard]>=0.30",
    fastapi:
      'Name: fastapi\nRequires-Dist: uvicorn[standard]>=0.30\nRequires-Dist: email-validator; extra == "standard"',
    uvicorn: [
      "Name: uvicorn",
      "Requires-Dist: h11>=0.8",
      'Requires-Dist: websockets>=10.4; extra == "standard"',
      'Requires-Dist: watchfiles; extra == "reload"',
    ].join("\n"),
  };

  function extrasService(allowlist: string[]) {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { pypi: allowlist },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
    });
    const registry = new RegistryService({
      adapters: new Map([["pypi", pypiAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async (url) => {
        const index = url.match(/^https:\/\/pypi\.org\/simple\/([^/]+)\/$/);
        if (index)
          return Response.json({
            name: index[1],
            files: [
              {
                filename: wheel(index[1]),
                url: `https://files.pythonhosted.org/packages/xx/${wheel(index[1])}`,
                hashes: { sha256 },
                "upload-time": new Date(NOW.getTime() - 100 * DAY).toISOString(),
                size: body.byteLength,
                "core-metadata": true,
              },
            ],
          });
        const file = url.match(/\/packages\/xx\/([^/]+?)-1\.0-py3-none-any\.whl\.metadata$/);
        if (file) return new Response(metadata[file[1].replace(/_/g, "-")] ?? `Name: ${file[1]}\n`);
        return new Response(body);
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 20, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    const get = async (name: string) => {
      const response = await registry.handle({
        ...request(`files/${encodeURIComponent(name)}/${encodeURIComponent(wheel(name))}.metadata`),
        ecosystem: "pypi",
      });
      if ("stream" in response) await new Response(response.stream).text();
      return response;
    };
    const allowed = (name: string) => store.isAllowedDependency("run-1", "pypi", name);
    return { get, allowed, store };
  }

  it("follows only the requested extra of an allowlisted package", async () => {
    const { get, allowed } = extrasService(["psycopg[binary]>=1"]);
    await expect(get("psycopg")).resolves.toMatchObject({ status: 200 });
    expect(await allowed("psycopg-binary")).toBe(true);
    expect(await allowed("typing-extensions")).toBe(true);
    expect(await allowed("psycopg-c")).toBe(false);
    expect(await allowed("psycopg-pool")).toBe(false);
    await expect(get("psycopg-binary")).resolves.toMatchObject({ status: 200 });
    const refused = await get("psycopg-c");
    expect(refused).toMatchObject({ status: 403 });
    expect("body" in refused && refused.body).toContain("wardby_package_not_allowed");
  });

  it("follows no extra for a plain entry (unchanged)", async () => {
    const { get, allowed } = extrasService(["psycopg"]);
    await expect(get("psycopg")).resolves.toMatchObject({ status: 200 });
    expect(await allowed("typing-extensions")).toBe(true);
    expect(await allowed("psycopg-binary")).toBe(false);
    await expect(get("psycopg-binary")).resolves.toMatchObject({ status: 403 });
  });

  it("follows no dependency's extras below a plain entry", async () => {
    // fastapi's metadata asks for uvicorn[standard], but the allowlist entry is plain.
    const { get, allowed, store } = extrasService(["fastapi"]);
    await get("fastapi");
    expect(await allowed("uvicorn")).toBe(true);
    expect(await store.allowedExtras("run-1", "pypi", "uvicorn")).toEqual([]);
    await expect(get("uvicorn")).resolves.toMatchObject({ status: 200 });
    expect(await allowed("h11")).toBe(true);
    expect(await allowed("websockets")).toBe(false);
    await expect(get("websockets")).resolves.toMatchObject({ status: 403 });
  });

  it("propagates the extras a dependency line names below an entry that names extras", async () => {
    const { get, allowed, store } = extrasService(["fastapi[standard]"]);
    await get("fastapi");
    expect(await allowed("uvicorn")).toBe(true);
    expect(await allowed("email-validator")).toBe(true);
    expect(await store.allowedExtras("run-1", "pypi", "uvicorn")).toEqual(["standard"]);
    expect(await store.allowedExtras("run-1", "pypi", "h11")).toEqual([]);
    // The extra marker is not itself a package the run may fetch.
    expect(await allowed("uvicorn[standard]")).toBe(false);
    await expect(get("uvicorn")).resolves.toMatchObject({ status: 200 });
    expect(await allowed("h11")).toBe(true);
    expect(await allowed("websockets")).toBe(true);
    expect(await allowed("watchfiles")).toBe(false);
    // websockets reached through an extra gets only its own plain deps.
    await expect(get("websockets")).resolves.toMatchObject({ status: 200 });
  });

  it("never treats an extra-marker spelling as a package request", async () => {
    const { get, store } = extrasService(["app"]);
    await get("app");
    const response = await get("uvicorn[standard]");
    expect(response).toMatchObject({ status: 400 });
    expect(store.fetches.some((fetch) => fetch.outcome === "served" && fetch.name.includes("["))).toBe(false);
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
    // A root whose dependency (aliaser) reaches mid under ^2 one level
    // deeper than app reaches it under ^1.
    grand: {
      name: "grand",
      time: { "1.0.0": old },
      versions: { "1.0.0": version("grand", "1.0.0", { aliaser: "^1" }) },
    },
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
      /** Upstream metadata held per package name until the promise settles. */
      held?: Record<string, Promise<void>>;
    } = {},
  ) {
    const store = overrides.store ?? new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { npm: overrides.allowlist ?? ["app@^1"] },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
    });
    for (const [token, allowlist] of Object.entries(overrides.otherRuns ?? {})) {
      store.contexts.set(capabilityHash(token), {
        runId: `run-${token}`,
        deadlineAt: new Date(NOW.getTime() + DAY),
        allowlist: { npm: allowlist },
        policy: {},
        repository: "owner/repo",
        cacheImage: null,
        dependencyCache: false,
        packageAudit: null,
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
          return {
            withheld: (v: string) => (withheld.includes(v) ? ["GHSA-x"] : []),
            waived: () => [],
            reported: () => [],
          };
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
        if (overrides.held?.[name]) await overrides.held[name];
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
    return { get, urls, audited, store, concurrency, registry };
  }
  /** A version's tarball path: only a download (a lockfile install's
   *  request) walks the graph; a metadata miss is refused at once. */
  const tgz = (name: string) => `${name}/-/${name}-1.0.0.tgz`;

  it("serves a transitive dependency's tarball, two levels deep, with no prior metadata request", async () => {
    const { get, store } = graphService();
    const response = await get("leaf/-/leaf-1.0.0.tgz");
    if (!("stream" in response)) throw new Error(`expected a stream, got ${JSON.stringify(response)}`);
    expect(new Uint8Array(await new Response(response.stream).arrayBuffer())).toEqual(leafBytes);
    expect(await store.isAllowedDependency("run-1", "npm", "mid")).toBe(true);
    expect(await store.isAllowedDependency("run-1", "npm", "leaf")).toBe(true);
    expect(store.fetches).toMatchObject([{ name: "leaf", version: "1.0.0", outcome: "served" }]);
  });

  it("refuses a metadata request for a reachable name with no allowance at once, without walking", async () => {
    // leaf is in the approved graph, but nothing declaring it was resolved
    // yet: a package manager resolving top-down never asks for it first.
    const { get, store, urls, audited, registry } = graphService();
    const response = await get("leaf");
    expect(response).toMatchObject({ status: 403 });
    const body = "body" in response ? response.body : "";
    expect(body).toContain("wardby_package_not_allowed:");
    expect(body).not.toContain("pending");
    expect(store.fetches).toMatchObject([{ name: "leaf", outcome: "refused", reason: "wardby_package_not_allowed" }]);
    expect(urls).toEqual([]);
    expect(audited).toEqual([]);
    const internals = registry as unknown as { tallies: Map<string, { graphs?: Map<string, unknown> }> };
    expect(internals.tallies.get("run-1")?.graphs).toBeUndefined();
    expect(await store.isAllowedDependency("run-1", "npm", "leaf")).toBe(false);
  });

  it("refuses a HEAD on a metadata route for a reachable name at once, without walking", async () => {
    const { registry, store, urls } = graphService();
    const response = await registry.handle({ ...request("leaf"), method: "HEAD", ecosystem: "npm" });
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed:");
    expect(urls).toEqual([]);
    expect(store.fetches).toMatchObject([{ name: "leaf", outcome: "refused", reason: "wardby_package_not_allowed" }]);
  });

  it("resolves top-down through metadata (app, then mid, then leaf) with no walk", async () => {
    const { get, urls, registry } = graphService();
    await expect(get("app")).resolves.toMatchObject({ status: 200 });
    await expect(get("mid")).resolves.toMatchObject({ status: 200 });
    await expect(get("leaf")).resolves.toMatchObject({ status: 200 });
    // One render fetch per document served; nothing fetched by a walk.
    expect(urls).toEqual([
      "https://registry.npmjs.org/app",
      "https://registry.npmjs.org/mid",
      "https://registry.npmjs.org/leaf",
    ]);
    const internals = registry as unknown as { tallies: Map<string, { graphs?: Map<string, unknown> }> };
    expect(internals.tallies.get("run-1")?.graphs).toBeUndefined();
  });

  it("still walks for a tarball download of a reachable version with no allowance (a lockfile install)", async () => {
    const { get, urls, store } = graphService();
    const response = await get("leaf/-/leaf-1.0.0.tgz");
    if (!("stream" in response)) throw new Error(`expected a stream, got ${JSON.stringify(response)}`);
    await new Response(response.stream).arrayBuffer();
    // The walk read app and mid to prove leaf is in the graph.
    expect(urls).toEqual(expect.arrayContaining(["https://registry.npmjs.org/app", "https://registry.npmjs.org/mid"]));
    expect(await store.isAllowedDependency("run-1", "npm", "leaf")).toBe(true);
    expect(store.fetches).toMatchObject([{ name: "leaf", outcome: "served" }]);
  });

  it('answers the final 403 wardby_package_not_allowed, with "the owner must allowlist it", only once the walk has completed', async () => {
    const { get, store } = graphService();
    const response = await get("stranger/-/stranger-1.0.0.tgz");
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed:");
    expect("body" in response && response.body).toContain(
      "stranger (npm) is not on this agent's allowlist, and no allowlisted package this run resolved depends on it",
    );
    expect("body" in response && response.body).toContain("owner must allowlist it; retrying will not help");
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

  it("graph_limit carries the owner-must-allowlist wording and the limit", async () => {
    // app and mid fit in the bound; leaf, a third package, does not.
    const { get, store } = graphService({ maxGraphPackages: 2 });
    const response = await get("leaf/-/leaf-1.0.0.tgz");
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_graph_limit");
    expect("body" in response && response.body).toContain("limit of 2 packages");
    expect("body" in response && response.body).toContain("REGISTRY_MAX_GRAPH_PACKAGES");
    expect("body" in response && response.body).toContain("retrying will not help");
    expect("body" in response && response.body).toContain("owner must allowlist leaf directly");
    expect("body" in response && response.body).not.toContain("wardby_package_not_allowed");
    expect(store.fetches).toMatchObject([{ name: "leaf", outcome: "refused", reason: "wardby_graph_limit" }]);
    // The bound is permanent for the run: a retry gets the same definitive answer.
    await expect(get("leaf/-/leaf-1.0.0.tgz")).resolves.toMatchObject({ status: 403 });
    // mid was found before the bound tripped, so it stays allowed.
    await expect(get("mid")).resolves.toMatchObject({ status: 200 });
  });

  it("answers 403 wardby_package_not_allowed_pending, never a retryable 503, for a name the timed-out walk has not reached", async () => {
    const { get, store } = graphService({ hang: "mid", graphTimeoutMs: 30 });
    const response = await get(tgz("stranger"));
    expect(response).toMatchObject({ status: 403 });
    const body = "body" in response ? response.body : "";
    expect(body).toContain("wardby_package_not_allowed_pending:");
    expect(body).toContain("after 1 package,");
    expect(body).toContain("at least 1 more queued");
    expect(body).toContain("owner must allowlist stranger directly");
    expect(body).toContain("retrying rarely helps");
    expect(body).not.toContain("wardby_graph_incomplete");
    expect(store.fetches).toMatchObject([
      { name: "stranger", outcome: "refused", reason: "wardby_package_not_allowed_pending" },
    ]);
  });

  it("answers the timed-out walk's pending 403 for a reachable name it has not reached yet, never not-allowed", async () => {
    // leaf is in the graph, but mid (its parent) never answers: the walk
    // has not seen leaf, so it gets the pending answer, not the final one.
    const { get } = graphService({ hang: "mid", graphTimeoutMs: 30 });
    const response = await get(tgz("leaf"));
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed_pending:");
    expect("body" in response && response.body).not.toContain("wardby_package_not_allowed:");
    expect("body" in response && response.body).not.toContain("wardby_package_not_found");
  });

  it("keeps 503 wardby_graph_incomplete for a name an expanded version declares while its own versions are still being checked", async () => {
    const { get, store } = graphService({ hang: "leaf", graphTimeoutMs: 30 });
    const response = await get(tgz("leaf"));
    expect(response).toMatchObject({ status: 503 });
    const body = "body" in response ? response.body : "";
    expect(body).toContain("wardby_graph_incomplete:");
    expect(body).toContain("is still being checked against the allowed packages' dependency graph after 2 packages");
    expect(body).toContain("Please try again");
    expect(body).not.toContain("wardby_package_not_allowed");
    expect(store.fetches).toMatchObject([{ name: "leaf", outcome: "refused", reason: "wardby_graph_incomplete" }]);
  });

  it("a pending answer becomes final once a later request completes the walk", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { get, store } = graphService({ gate, graphTimeoutMs: 30 });
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    open();
    const final = await get(tgz("stranger"));
    expect(final).toMatchObject({ status: 403 });
    expect("body" in final && final.body).toContain("wardby_package_not_allowed:");
    expect(store.fetches).toMatchObject([
      { name: "stranger", outcome: "refused", reason: "wardby_package_not_allowed_pending" },
      { name: "stranger", outcome: "refused", reason: "wardby_package_not_allowed" },
    ]);
  });

  it("resumes across requests: the second request continues the first walk without re-fetching packages it already expanded", async () => {
    const { get, urls } = graphService({ hang: "mid", graphTimeoutMs: 30 });
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    const retry = await get(tgz("stranger"));
    expect(retry).toMatchObject({ status: 403 });
    expect(urls.filter((url) => url.endsWith("/app"))).toHaveLength(1);
    // The retry went on from where the first walk stopped (app expanded,
    // mid queued), and app was not walked again.
    expect("body" in retry && retry.body).toContain("after 1 package, at least 1 more queued");
  });

  it("a new run starts its own walk", async () => {
    // Walks are per run on purpose: another run's allowlist must never
    // widen this one's graph, so the second run fetches app again.
    const { get, urls } = graphService({ hang: "mid", graphTimeoutMs: 30, otherRuns: { rrg_other: ["app@^1"] } });
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    await expect(get(tgz("stranger"), "rrg_other")).resolves.toMatchObject({ status: 403 });
    expect(urls.filter((url) => url.endsWith("/app"))).toHaveLength(2);
  });

  it("the pending answer counts only names not yet expanded as queued", async () => {
    // The first walk stops once it finds mid (expanded under ^1 and its
    // dist-tag together), leaving edges queued for leaf (by range), already
    // expanded as a root, and for leaf-new and mid-two-only. Then leaf-new
    // stops answering (leaf is memoized, so it needs no upstream call).
    const options: Parameters<typeof graphService>[0] = { allowlist: ["app@^1", "leaf", "tagged"], graphTimeoutMs: 30 };
    const { get } = graphService(options);
    await expect(get(tgz("mid"))).resolves.toMatchObject({ status: 200 });
    options.hang = "leaf-new";
    const response = await get(tgz("stranger"));
    expect(response).toMatchObject({ status: 403 });
    const body = "body" in response ? response.body : "";
    expect(body).toContain("wardby_package_not_allowed_pending:");
    // app, leaf, tagged and mid were expanded; of the three queued edges
    // (leaf@^1, leaf-new@^1, mid-two-only@^1) leaf is not a new package.
    expect(body).toContain("after 4 packages, at least 2 more queued");
  });

  it("serves a name on retry once a timed-out walk resumes and reaches it", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { get, store } = graphService({ gate, graphTimeoutMs: 30 });
    // Nothing was expanded yet, so leaf is not in the frontier: pending.
    await expect(get("leaf/-/leaf-1.0.0.tgz")).resolves.toMatchObject({ status: 403 });
    open();
    const retried = await get("leaf/-/leaf-1.0.0.tgz");
    if (!("stream" in retried)) throw new Error(`expected a stream, got ${JSON.stringify(retried)}`);
    await new Response(retried.stream).arrayBuffer();
    expect(store.fetches).toMatchObject([
      { name: "leaf", outcome: "refused", reason: "wardby_package_not_allowed_pending" },
      { name: "leaf", outcome: "served" },
    ]);
  });

  it("shares one walk between concurrent misses", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { get, audited } = graphService({ gate });
    const both = Promise.all([get(tgz("stranger")), get(tgz("stranger")), get(tgz("leaf"))]);
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
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    const before = urls.length;
    expect(before).toBeGreaterThan(0);
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    await expect(get("other-stranger/-/other-stranger-1.0.0.tgz")).resolves.toMatchObject({ status: 403 });
    expect(urls).toHaveLength(before);
  });

  it("does not start a walk from a scoped wildcard root", async () => {
    const { get, urls } = graphService({ allowlist: ["@scope/*"] });
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    expect(urls).toEqual([]);
  });

  it("retries a node whose metadata fails once, and finds the name", async () => {
    const { get } = graphService({ upstreamFailures: { mid: 1 } });
    await expect(get(tgz("leaf"))).resolves.toMatchObject({ status: 200 });
  });

  it("retries a node whose audit fails once, and finds the name", async () => {
    const { get } = graphService({ auditFailures: { mid: 1 } });
    await expect(get(tgz("leaf"))).resolves.toMatchObject({ status: 200 });
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
    const response = await get(tgz("leaf"));
    expect(response).toMatchObject({ status: 503 });
    expect("body" in response && response.body).toContain("wardby_audit_unavailable");
    expect(store.fetches).toMatchObject([{ name: "leaf", outcome: "refused", reason: "wardby_audit_unavailable" }]);
  });

  it("retries a failed node on a later miss, with a per-run cap on attempts", async () => {
    const { get, urls } = graphService({ upstreamFailures: { mid: 2 } });
    // Two attempts in the first walk both fail; the next miss retries and finds it.
    await expect(get(tgz("leaf"))).resolves.toMatchObject({ status: 502 });
    await expect(get(tgz("leaf"))).resolves.toMatchObject({ status: 200 });
    const always = graphService({ upstreamFailures: { mid: Infinity } });
    for (let i = 0; i < 5; i += 1) await always.get(tgz("leaf"));
    expect(always.urls.filter((url) => url.endsWith("/mid")).length).toBeLessThanOrEqual(4);
    expect(urls.filter((url) => url.endsWith("/mid")).length).toBe(3);
  });

  it("does not follow the dependencies of a version withheld by the audit", async () => {
    const { get, store } = graphService({ withheld: { mid: ["1.0.0"] } });
    await expect(get(tgz("leaf"))).resolves.toMatchObject({ status: 403 });
    expect(await store.isAllowedDependency("run-1", "npm", "leaf")).toBe(false);
  });

  it("keeps walk state per run: another run's allowlist does not widen this one", async () => {
    const { get } = graphService({ allowlist: ["stranger"], otherRuns: { rrg_other: ["app@^1"] } });
    await expect(get(tgz("leaf"), "rrg_other")).resolves.toMatchObject({ status: 200 });
    await expect(get(tgz("leaf"))).resolves.toMatchObject({ status: 403 });
    await expect(get(tgz("mid"))).resolves.toMatchObject({ status: 403 });
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
    const failed = await get(tgz("leaf"));
    expect(failed).toMatchObject({ status: 502 });
    failWrites = false;
    await expect(get(tgz("leaf"))).resolves.toMatchObject({ status: 200 });
    expect(await store.isAllowedDependency("run-1", "npm", "mid")).toBe(true);
  });

  it("uses the injected clock for the walk deadline", async () => {
    let tick = 0;
    const { get, urls } = graphService({
      graphTimeoutMs: 1_000,
      now: () => new Date(NOW.getTime() + (tick += 5_000)),
    });
    const response = await get(tgz("leaf"));
    // The deadline passed before anything was expanded: leaf was never
    // reached, so the answer is the pending 403, with app still queued.
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed_pending:");
    expect("body" in response && response.body).toContain("after 0 packages, at least 1 more queued");
    expect(urls).toEqual([]);
  });

  it("caps concurrent walk fetches across every run", async () => {
    const { get, concurrency } = graphService({
      allowlist: ["app@^1", "mid", "leaf", "ranged-out", "too-new"],
      otherRuns: { rrg_other: ["app@^1", "mid", "leaf", "ranged-out", "too-new"] },
      maxGraphConcurrency: 2,
      upstreamDelayMs: 5,
    });
    await Promise.all([get(tgz("stranger")), get(tgz("stranger"), "rrg_other")]);
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
    await expect(get(tgz("mid-two-only"))).resolves.toMatchObject({ status: 200 });
    // ^2 excludes mid 1.x, so their dependencies are not in this graph.
    await expect(get(tgz("leaf"))).resolves.toMatchObject({ status: 403 });
    await expect(get(tgz("leaf-new"))).resolves.toMatchObject({ status: 403 });
    expect(await store.isAllowedDependency("run-1", "npm", "mid")).toBe(true);
    expect(await store.isAllowedDependency("run-1", "npm", "mid-alias")).toBe(false);
  });

  it("contributes nothing for a range no kept version satisfies", async () => {
    const { get, store } = graphService({ allowlist: ["unsatisfied"] });
    await expect(get(tgz("leaf"))).resolves.toMatchObject({ status: 403 });
    expect(await store.isAllowedDependency("run-1", "npm", "mid")).toBe(false);
  });

  it("treats a dist-tag (or any non-range spec) as every kept version", async () => {
    const { get } = graphService({ allowlist: ["tagged"] });
    await expect(get(tgz("mid-two-only"))).resolves.toMatchObject({ status: 200 });
    await expect(get(tgz("leaf"))).resolves.toMatchObject({ status: 200 });
  });

  it("expands each version of a package once, however many ranges reach it", async () => {
    const { get, audited } = graphService({ allowlist: ["app@^1", "tagged", "aliaser"] });
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    expect(audited.filter((name) => name === "leaf")).toHaveLength(1);
  });

  it("expands all of a package's pending ranges in one node", async () => {
    // mid is reached under ^1 (app), latest (tagged) and ^2 (aliaser).
    const { get, urls, registry } = graphService({ allowlist: ["app@^1", "tagged", "aliaser"] });
    const internals = registry as unknown as { graphNode: (...args: unknown[]) => Promise<unknown> };
    const graphNode = internals.graphNode.bind(registry);
    const midRanges: string[][] = [];
    internals.graphNode = (...args: unknown[]) => {
      // (adapter, context, entries, name, edges); an edge object before grouping.
      const [name, edges] =
        typeof args[3] === "string"
          ? [args[3], args[4] as { range: string }[]]
          : [(args[3] as { name: string }).name, [args[3] as { range: string }]];
      if (name === "mid") midRanges.push(edges.map((edge) => edge.range));
      return graphNode(...args);
    };
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    // The ranges pending together when mid's node runs share it.
    expect(midRanges.some((ranges) => ranges.length > 1)).toBe(true);
    // (A dist-tag is followed as "*", every kept version.)
    expect(midRanges.flat().sort()).toEqual(["*", "^1", "^2"]);
    // One packument load for mid in the walk (metadataTtlMs is 0 here).
    expect(urls.filter((url) => url.endsWith("/mid"))).toHaveLength(1);
  });

  it("expands the requested name's pending edges before the rest of the queue", async () => {
    // app is the first of 31 roots; mid, its dependency, is the target.
    // Breadth first, mid would wait behind 30 roots; target first, it is
    // the next node after app.
    const others = Array.from({ length: 30 }, (_, index) => `root-${index}`);
    // A clock that moves with real time, so the walk's deadline is real.
    const start = Date.now();
    const { get } = graphService({
      now: () => new Date(NOW.getTime() + Date.now() - start),
      allowlist: ["app@^1", ...others],
      maxGraphConcurrency: 1,
      upstreamDelayMs: 20,
      graphTimeoutMs: 300,
    });
    const response = await get(tgz("mid"));
    expect(response, JSON.stringify(response)).toMatchObject({ status: 200 });
  });

  it("answers a waiting request from its own walk's end, even if another miss starts a walk in the same tick", async () => {
    // leaf is in the frontier when the walk times out (leaf never answers).
    // A second miss starts the next walk before the first request reads
    // the answer, and that walk takes leaf off the queue at once.
    const { get, registry } = graphService({ hang: "leaf", graphTimeoutMs: 30 });
    const internals = registry as unknown as {
      walkGraph: (...args: unknown[]) => Promise<unknown>;
      resolveInGraph: (...args: unknown[]) => Promise<unknown>;
    };
    const walkGraph = internals.walkGraph.bind(registry);
    let second: Promise<unknown> | undefined;
    let interleaved = false;
    internals.walkGraph = (...args: unknown[]) => {
      const walk = walkGraph(...args);
      if (!interleaved) {
        interleaved = true;
        void walk.then(() =>
          // Queued behind the walk's own `.finally`: runs once `running` is
          // cleared, before the waiting request resumes.
          queueMicrotask(() => {
            const [adapter, context, entries] = args;
            second = internals.resolveInGraph(adapter, context, entries, "leaf");
          }),
        );
      }
      return walk;
    };
    const response = await get(tgz("leaf"));
    expect(second).toBeDefined();
    await second;
    expect(response).toMatchObject({ status: 503 });
    expect("body" in response && response.body).toContain("wardby_graph_incomplete:");
  });

  it("reuses an expanded package across requests within the memo's lifetime", async () => {
    // Walk 1 expands app, grand, mid (^1) and aliaser, then times out on
    // leaf; mid@^2 (from aliaser) is still queued. Walk 2 expands it from
    // the memo, with no metadata cache to help (metadataTtlMs is 0).
    let release: () => void = () => {};
    const leaf = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { get, urls, store } = graphService({ allowlist: ["app@^1", "grand"], held: { leaf }, graphTimeoutMs: 30 });
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    expect(urls.filter((url) => url.endsWith("/mid"))).toHaveLength(1);
    release();
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    expect(urls.filter((url) => url.endsWith("/mid"))).toHaveLength(1);
    // mid@^2's own dependency joined the graph from the memoized versions.
    expect(await store.isAllowedDependency("run-1", "npm", "mid-two-only")).toBe(true);
  });

  it("re-reads a package after the memo TTL", async () => {
    let clock = NOW;
    let release: () => void = () => {};
    const leaf = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { get, urls } = graphService({
      allowlist: ["app@^1", "grand"],
      held: { leaf },
      graphTimeoutMs: 30,
      now: () => clock,
    });
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    expect(urls.filter((url) => url.endsWith("/mid"))).toHaveLength(1);
    release();
    clock = new Date(NOW.getTime() + 15 * 60_000 + 1);
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    expect(urls.filter((url) => url.endsWith("/mid"))).toHaveLength(2);
  });

  it("bounds the memo by bytes and drops a run's entries when the run is released", async () => {
    type Memo = Map<string, { bytes: number }>;
    const { get, registry } = graphService({ allowlist: ["app@^1", "tagged", "aliaser"] });
    const internals = registry as unknown as { graphMemo: Memo; graphMemoBytes: number; graphMemoTotal: number };
    await expect(get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    expect(internals.graphMemo.size).toBeGreaterThan(0);
    for (const key of internals.graphMemo.keys()) expect(key.startsWith("run-1\0npm\0")).toBe(true);
    expect(internals.graphMemoTotal).toBe([...internals.graphMemo.values()].reduce((sum, e) => sum + e.bytes, 0));
    registry.close();
    expect(internals.graphMemo.size).toBe(0);
    expect(internals.graphMemoTotal).toBe(0);

    // A budget smaller than any entry keeps nothing, and the walk still
    // reaches the same answers.
    const small = graphService({ allowlist: ["app@^1", "tagged", "aliaser"] });
    const smallInternals = small.registry as unknown as { graphMemo: Memo; graphMemoBytes: number };
    smallInternals.graphMemoBytes = 1;
    await expect(small.get(tgz("leaf"))).resolves.toMatchObject({ status: 200 });
    await expect(small.get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    expect(smallInternals.graphMemo.size).toBe(0);
    // A budget for about one entry keeps the total within it.
    const one = graphService({ allowlist: ["app@^1", "tagged", "aliaser"] });
    const oneInternals = one.registry as unknown as { graphMemo: Memo; graphMemoBytes: number; graphMemoTotal: number };
    oneInternals.graphMemoBytes = 400;
    await expect(one.get(tgz("stranger"))).resolves.toMatchObject({ status: 403 });
    expect(oneInternals.graphMemoTotal).toBeLessThanOrEqual(400);
    expect(oneInternals.graphMemo.size).toBeGreaterThan(0);
  });

  it("PyPI, which does not walk, answers the final wording", async () => {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { pypi: ["demo"] },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
    expect("body" in response && response.body).toContain("wardby_package_not_allowed:");
    expect("body" in response && response.body).toContain("stranger (pypi) is not on this agent's allowlist");
    expect("body" in response && response.body).toContain("owner must allowlist it; retrying will not help");
    // PyPI never walks, so it never answers "pending".
    expect("body" in response && response.body).not.toContain("pending");
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
    // A download walks the graph (a metadata request would not).
    await expect(
      registry.handle({ ...request("stranger/-/stranger-1.0.0.tgz"), ecosystem: "npm" }),
    ).resolves.toMatchObject({ status: 403 });
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
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
    // A HEAD of a tarball walks the graph (only a download does) without
    // fetching the tarball itself.
    const head = (subpath: string) => registry.handle({ ...request(subpath), method: "HEAD", ecosystem: "npm" });
    const internals = registry as unknown as {
      metadataCache: Map<string, { bytes: number; meta: PackageMetadata }>;
      tallies: Map<string, { graphs?: Map<string, { released?: boolean }> }>;
    };
    return { registry, get, head, internals };
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
      const { get, head, internals } = memoryService();
      // A HEAD of leaf's tarball walks the graph (trimmed fetches of app
      // and mid, then of leaf); serving leaf's and app's documents re-fetches
      // them to render.
      await expect(head("leaf/-/leaf-1.0.0.tgz")).resolves.toMatchObject({ status: 200 });
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
    const { head, internals } = memoryService(new Date(NOW.getTime() + 50), () => clock);
    // No real-time race: while the injected clock stays at NOW, a timer that
    // fires early only re-arms (scheduleRelease checks this.now() against the
    // deadline), so the walk below cannot be released mid-walk however slow
    // the machine is.
    await expect(head("leaf/-/leaf-1.0.0.tgz")).resolves.toMatchObject({ status: 200 });
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

describe("RegistryService graph walk at scale", () => {
  // A synthetic npm registry: 1,200 packages p0..p1199, 20 versions each
  // (1.0.0..1.19.0, all old enough). Each package depends on 6 others a
  // little further on (so the graph is deep, not a star), and each version
  // declares them under its own range. Four roots. The injected clock
  // advances 350 ms per packument and 300 ms per audit, so a request's
  // default 180 s walk covers a few hundred packages.
  const SIZE = 1200;
  const VERSIONS = 20;
  const FANOUT = 6;
  const WINDOW = 60;
  const POPULAR_FANOUT = 2;
  const ROOTS = ["p0", "p1", "p2", "p3"];
  /** Measured with ~20% headroom (see the scale test below). */
  const REQUESTS_BOUND = 6;
  const LOADS_BOUND = 1_650;
  const old = new Date(NOW.getTime() - 30 * DAY).toISOString();
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  let seed = 330;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Per package: dependencies a little further on (the graph's depth),
   *  then dependencies on popular packages (p4..p103), which edges keep
   *  reaching under new ranges from every depth, as utility packages do. */
  const children: number[][] = [];
  const popular: number[][] = [];
  for (let index = 0; index < SIZE; index += 1) {
    const targets = new Set<number>();
    for (let tries = 0; targets.size < FANOUT - POPULAR_FANOUT && tries < 100; tries += 1) {
      const target = index + 1 + Math.floor(random() * WINDOW);
      if (target < SIZE) targets.add(target);
    }
    const shared = new Set<number>();
    while (shared.size < POPULAR_FANOUT) {
      const target = 4 + Math.floor(random() * 100);
      if (target !== index && !targets.has(target)) shared.add(target);
    }
    children.push([...targets]);
    popular.push([...shared]);
  }
  const bodies = new Map<string, string>();
  const packumentBody = (index: number): string => {
    const name = `p${index}`;
    let body = bodies.get(name);
    if (body) return body;
    const time: Record<string, string> = {};
    const versions: Record<string, unknown> = {};
    for (let minor = 0; minor < VERSIONS; minor += 1) {
      const version = `1.${minor}.0`;
      time[version] = old;
      const dependencies: Record<string, string> = {};
      for (const child of children[index]) dependencies[`p${child}`] = `^1.${4 * Math.floor(random() * 5)}.0`;
      for (const child of popular[index])
        dependencies[`p${child}`] = `^1.${Math.floor(random() * VERSIONS)}.${Math.floor(random() * 10)}`;
      versions[version] = {
        name,
        version,
        dependencies,
        dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity },
      };
    }
    body = JSON.stringify({ name, time, versions });
    bodies.set(name, body);
    return body;
  };
  for (let index = 0; index < SIZE; index += 1) packumentBody(index);
  // Breadth-first depth of every reachable package from the roots.
  const depth = new Map<string, number>(ROOTS.map((root) => [root, 0]));
  for (const queue = [0, 1, 2, 3]; queue.length > 0;) {
    const index = queue.shift() as number;
    for (const child of [...children[index], ...popular[index]]) {
      if (depth.has(`p${child}`)) continue;
      depth.set(`p${child}`, (depth.get(`p${index}`) ?? 0) + 1);
      queue.push(child);
    }
  }

  function scaleService(overrides: { maxGraphPackages?: number } = {}) {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { npm: ROOTS },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
    });
    const clock = { ms: NOW.getTime() };
    const counts = { loads: 0 };
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: {
        audit: async () => {
          clock.ms += 300;
          return NO_ADVISORIES;
        },
      },
      upstream: async (url) => {
        if (url.endsWith(".tgz")) return new Response(tarball);
        const name = decodeURIComponent(url.slice("https://registry.npmjs.org/".length));
        const match = name.match(/^p(\d+)$/);
        if (!match) return new Response("not found", { status: 404 });
        clock.ms += 350;
        counts.loads += 1;
        return new Response(packumentBody(Number(match[1])), { headers: { "content-type": "application/json" } });
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
      now: () => new Date(clock.ms),
      maxGraphPackages: overrides.maxGraphPackages,
    });
    // Each request is a download of the name's 1.0.0 tarball: only a
    // download walks the graph.
    const get = async (name: string) => {
      const response = await registry.handle({ ...request(`${name}/-/${name}-1.0.0.tgz`), ecosystem: "npm" });
      if ("stream" in response) await new Response(response.stream).arrayBuffer();
      return { status: response.status, body: "body" in response ? response.body : "" };
    };
    const walk = () =>
      (
        registry as unknown as {
          tallies: Map<string, { graphs?: Map<string, unknown> }>;
        }
      ).tallies
        .get("run-1")
        ?.graphs?.get("npm");
    return { get, clock, counts, registry, walk };
  }

  const walkedIn = (body: string) => Number(body.match(/after ([\d,]+) packages?/)?.[1].replace(/,/g, "") ?? NaN);

  /** Requests `name` until the answer is no longer pending, `gapMs` apart. */
  async function untilSettled(scale: ReturnType<typeof scaleService>, name: string, gapMs: number) {
    const progress: number[] = [];
    for (let requests = 1; requests <= 60; requests += 1) {
      const answer = await scale.get(name);
      if (!answer.body.includes("wardby_package_not_allowed_pending:")) return { requests, progress, answer };
      progress.push(walkedIn(answer.body));
      scale.clock.ms += gapMs;
    }
    throw new Error(`still pending after 60 requests: ${JSON.stringify(progress)}`);
  }

  it("reaches the final answer for an absent name within a bounded number of requests, reporting growing progress", async () => {
    const scale = scaleService();
    const { requests, progress, answer } = await untilSettled(scale, "not-a-dep", 5 * 60_000);
    const numbers = `requests=${requests} loads=${scale.counts.loads} progress=${JSON.stringify(progress)}`;
    expect(answer.status, numbers).toBe(403);
    expect(answer.body, numbers).toContain("wardby_package_not_allowed:");
    expect(progress.length, numbers).toBeGreaterThan(0);
    for (let index = 1; index < progress.length; index += 1)
      expect(progress[index], numbers).toBeGreaterThan(progress[index - 1]);
    expect(requests, numbers).toBeLessThanOrEqual(REQUESTS_BOUND);
    expect(scale.counts.loads, numbers).toBeLessThanOrEqual(LOADS_BOUND);
    scale.registry.close();
  });

  it("ends in wardby_graph_limit, not pending, when the bound trips first", async () => {
    const scale = scaleService({ maxGraphPackages: 600 });
    const { progress, answer } = await untilSettled(scale, "not-a-dep", 5 * 60_000);
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("wardby_graph_limit:");
    expect(answer.body).toContain("limit of 600 packages");
    for (let index = 1; index < progress.length; index += 1)
      expect(progress[index]).toBeGreaterThan(progress[index - 1]);
    expect(Math.max(...progress)).toBeLessThan(600);
    scale.registry.close();
  });

  it("finds a deep dependency in one request once it is in the frontier", async () => {
    const scale = scaleService();
    const first = await scale.get("not-a-dep");
    expect(first.body).toContain("wardby_package_not_allowed_pending:");
    // The deepest package the first walk reached but did not expand.
    const walk = scale.walk() as {
      pending?: Map<string, unknown>;
      queue?: { name: string }[];
      expandedVersions: Map<string, unknown>;
    };
    const frontier = [...(walk.pending?.keys() ?? (walk.queue ?? []).map((edge) => edge.name))].filter(
      (name) => !walk.expandedVersions.has(name),
    );
    const target = frontier.reduce((deepest, name) =>
      (depth.get(name) ?? 0) > (depth.get(deepest) ?? 0) ? name : deepest,
    );
    expect(depth.get(target)).toBeGreaterThanOrEqual(6);
    scale.clock.ms += 5 * 60_000;
    const before = scale.counts.loads;
    const found = await scale.get(target);
    expect(found.status, found.body).toBe(200);
    // Its own node, then (if not cached) its document for the download.
    expect(scale.counts.loads - before).toBeLessThanOrEqual(2);
    scale.registry.close();
  });
});

describe("RegistryService package audit mode", () => {
  /** Fixed blocking advisories per `name@version`, split by audit.ts's own
   *  splitWaived (malware is never waived or audited). */
  const advisoryIndex =
    (byVersion: Record<string, WithheldAdvisory[]>) =>
    async (_adapter: unknown, name: string): Promise<AdvisoryIndex> => {
      const of = (version: string) => byVersion[`${name}@${version}`] ?? [];
      return {
        withheld: (version, accepted, auditAll) =>
          splitWaived(of(version), accepted, { auditAll }).withheld.map(({ id }) => id),
        waived: (version, accepted) => splitWaived(of(version), accepted).waived.map(({ id }) => id),
        reported: () => [],
        audited: (version, accepted) =>
          splitWaived(of(version), accepted, { auditAll: true }).audited.map(auditAdvisoryOf),
      };
    };
  const high: WithheldAdvisory = { id: "GHSA-high", malware: false, aliases: [], severity: "HIGH", summary: "bad" };
  const drain = async (response: Awaited<ReturnType<RegistryService["handle"]>>) => {
    if (!("stream" in response)) throw new Error(`expected a stream, got ${response.status}`);
    return new Uint8Array(await new Response(response.stream).arrayBuffer());
  };
  /** The fake adapter, counting the metadata it reads: a graph walk reads the roots'. */
  const counted = () => {
    const reads: string[] = [];
    const adapter: RegistryAdapter = {
      ...fakeAdapter,
      fetchMetadata: async (name, ...rest) => {
        reads.push(name);
        return fakeAdapter.fetchMetadata(name, ...rest);
      },
    };
    return { adapter, reads };
  };

  it("audit: serves a package outside the allowlist without a walk and records it top-level", async () => {
    const { adapter, reads } = counted();
    const { registry, store } = service({ packageAudit: "audit", adapter });
    await expect(registry.handle(request("stranger"))).resolves.toMatchObject({ status: 200 });
    expect(await drain(await registry.handle(request("dl/stranger/1.0.0")))).toEqual(tarball);
    expect(store.audits).toEqual([
      {
        runId: "run-1",
        ecosystem: "fake",
        name: "stranger",
        version: "1.0.0",
        relation: "top-level",
        sizeBytes: tarball.byteLength,
        advisories: [],
        createdAt: expect.any(Date),
      },
    ]);
    expect(store.fetches.some((fetch) => fetch.outcome === "refused")).toBe(false);
    // Only stranger's own metadata was read: no walk from the allowlist root.
    expect(reads).not.toContain("app");
  });

  it("audit: a dependency of an audited package is allowed via it and recorded transitive", async () => {
    const { registry, store } = service({ packageAudit: "audit" });
    await expect(registry.handle(request("parent"))).resolves.toMatchObject({ status: 200 });
    expect(await store.findAllowance("run-1", "fake", "child")).toEqual({ auditedVia: "parent" });
    await expect(registry.handle(request("child"))).resolves.toMatchObject({ status: 200 });
    await drain(await registry.handle(request("dl/child/1.0.0")));
    expect(store.audits).toMatchObject([{ name: "child", relation: "transitive", via: "parent" }]);
  });

  it("audit: a download with no metadata first is recorded unknown, without a walk", async () => {
    const { adapter, reads } = counted();
    const { registry, store } = service({ packageAudit: "audit", adapter });
    await drain(await registry.handle(request("dl/stranger/1.0.0")));
    expect(store.audits).toMatchObject([{ name: "stranger", relation: "unknown" }]);
    expect(store.audits[0]).not.toHaveProperty("via");
    expect(reads).toEqual(["stranger"]);
  });

  it("audit: a HIGH advisory still withholds the version unless the policy accepts it", async () => {
    const audit = advisoryIndex({ "stranger@1.0.0": [high] });
    const refused = service({ packageAudit: "audit", audit });
    const response = await refused.registry.handle(request("dl/stranger/1.0.0"));
    expect(response).toMatchObject({ status: 404 });
    expect("body" in response && response.body).toContain("wardby_version_filtered");
    expect(refused.store.audits).toEqual([]);

    const accepted = service({ packageAudit: "audit", audit, policy: { acceptedAdvisories: ["GHSA-high"] } });
    await drain(await accepted.registry.handle(request("dl/stranger/1.0.0")));
    expect(accepted.store.fetches.at(-1)).toMatchObject({
      outcome: "served",
      reason: "accepted advisories: GHSA-high",
    });
    expect(accepted.store.audits).toMatchObject([{ name: "stranger", relation: "unknown", advisories: [] }]);
  });

  it("full: serves past a HIGH advisory and records it, on an audited and on an allowlisted package", async () => {
    const audit = advisoryIndex({ "stranger@1.0.0": [high], "app@1.0.0": [high] });
    const { registry, store } = service({ packageAudit: "full", audit });
    await drain(await registry.handle(request("dl/stranger/1.0.0")));
    await drain(await registry.handle(request("dl/app/1.0.0")));
    expect(store.audits).toMatchObject([
      {
        name: "stranger",
        relation: "unknown",
        advisories: [{ id: "GHSA-high", severity: "HIGH", summary: "bad" }],
      },
      {
        name: "app",
        relation: "allowed",
        advisories: [{ id: "GHSA-high", severity: "HIGH", summary: "bad" }],
      },
    ]);
    // The served rows themselves carry no waiver reason: full mode is not an accepted advisory.
    expect(store.fetches.filter((fetch) => fetch.outcome === "served").map((fetch) => fetch.reason)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("never serves malware, in any mode, on an audited or an allowlisted package", async () => {
    const flagged: WithheldAdvisory = { id: "GHSA-mal", malware: true, aliases: [] };
    const aliased: WithheldAdvisory = { id: "GHSA-mal2", malware: false, aliases: ["MAL-2026-1"] };
    for (const packageAudit of [null, "audit", "full"] as const)
      for (const malware of [flagged, aliased]) {
        const audit = advisoryIndex({ "stranger@1.0.0": [malware], "app@1.0.0": [malware] });
        const { registry, store } = service({ packageAudit, audit, policy: { acceptedAdvisories: [malware.id] } });
        for (const name of ["stranger", "app"]) {
          const response = await registry.handle(request(`dl/${name}/1.0.0`));
          expect(response, `${packageAudit} ${name} ${malware.id}`).not.toHaveProperty("stream");
          expect(response.status).toBeGreaterThanOrEqual(400);
        }
        expect(store.fetches.some((fetch) => fetch.outcome === "served")).toBe(false);
        expect(store.audits).toEqual([]);
      }
  });

  it("enforces the release age in every mode", async () => {
    for (const packageAudit of [null, "audit", "full"] as const) {
      const { registry, store } = service({ packageAudit });
      await expect(registry.handle(request("dl/app/2.0.0"))).resolves.toMatchObject({ status: 404 });
      if (packageAudit) {
        await expect(registry.handle(request("fresh"))).resolves.toMatchObject({ status: 404 });
        await expect(registry.handle(request("dl/fresh/1.0.0"))).resolves.toMatchObject({ status: 404 });
      }
      expect(store.audits).toEqual([]);
    }
  });

  it("leaves normal enforcement unchanged when the mode is off", async () => {
    const { registry, store } = service({ packageAudit: null });
    const response = await registry.handle(request("stranger"));
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed");
    expect(store.audits).toEqual([]);
  });

  it("records nothing for a package allowed through the allowlist graph in an audit-mode run", async () => {
    const { registry, store } = service({ packageAudit: "audit" });
    await expect(registry.handle(request("app"))).resolves.toMatchObject({ status: 200 });
    await drain(await registry.handle(request("dl/dep/1.0.0")));
    await drain(await registry.handle(request("dl/app/1.0.0")));
    expect(store.fetches.filter((fetch) => fetch.outcome === "served")).toHaveLength(2);
    expect(store.audits).toEqual([]);
  });

  it("records nothing for HEAD", async () => {
    const { registry, store } = service({ packageAudit: "audit" });
    await expect(registry.handle({ ...request("dl/stranger/1.0.0"), method: "HEAD" })).resolves.toMatchObject({
      status: 200,
    });
    expect(store.audits).toEqual([]);
  });

  it("errors the stream when the audit record cannot be written (never installed unrecorded)", async () => {
    class FailingAudit extends MemoryRegistryStore {
      override async recordAudit(): Promise<void> {
        throw new Error("simulated database error");
      }
    }
    const { registry } = service({ packageAudit: "audit", store: new FailingAudit() });
    const response = await registry.handle(request("dl/stranger/1.0.0"));
    if (!("stream" in response)) throw new Error("expected a stream");
    await expect(new Response(response.stream).arrayBuffer()).rejects.toThrow();
  });
});

describe("RegistryService package audit mode with the PyPI adapter", () => {
  const body = new TextEncoder().encode("wheel bytes");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const wheel = (name: string) => `${name.replace(/-/g, "_")}-1.0-py3-none-any.whl`;

  function auditService() {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: { pypi: ["app"] },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: "audit",
    });
    const registry = new RegistryService({
      adapters: new Map([["pypi", pypiAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async (url) => {
        const index = url.match(/^https:\/\/pypi\.org\/simple\/([^/]+)\/$/);
        if (index)
          return Response.json({
            name: index[1],
            files: [
              {
                filename: wheel(index[1]),
                url: `https://files.pythonhosted.org/packages/xx/${wheel(index[1])}`,
                hashes: { sha256 },
                "upload-time": new Date(NOW.getTime() - 100 * DAY).toISOString(),
                size: body.byteLength,
                "core-metadata": true,
              },
            ],
          });
        if (url.endsWith(".metadata")) return new Response("Name: stranger\nRequires-Dist: werkzeug>=3\n");
        return new Response(body);
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 20, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    const get = async (subpath: string) => {
      const response = await registry.handle({ ...request(subpath), ecosystem: "pypi" });
      if ("stream" in response) await new Response(response.stream).arrayBuffer();
      return response;
    };
    return { get, store };
  }

  it("serves a wheel outside the allowlist, records it top-level, and allows its Requires-Dist via it", async () => {
    const { get, store } = auditService();
    await expect(get("simple/stranger/")).resolves.toMatchObject({ status: 200 });
    await expect(get(`files/stranger/${wheel("stranger")}.metadata`)).resolves.toMatchObject({ status: 200 });
    await expect(get(`files/stranger/${wheel("stranger")}`)).resolves.toMatchObject({ status: 200 });
    expect(store.audits).toMatchObject([
      { ecosystem: "pypi", name: "stranger", version: "1.0", relation: "top-level" },
    ]);
    expect(await store.findAllowance("run-1", "pypi", "werkzeug")).toEqual({ auditedVia: "stranger" });
    await expect(get("simple/werkzeug/")).resolves.toMatchObject({ status: 200 });
    await expect(get(`files/werkzeug/${wheel("werkzeug")}`)).resolves.toMatchObject({ status: 200 });
    expect(store.audits.at(-1)).toMatchObject({ name: "werkzeug", relation: "transitive", via: "stranger" });
  });
});

describe("RegistryService: an allowlist entry's own range holds in every package audit mode", () => {
  const old = new Date(NOW.getTime() - 30 * DAY).toISOString();
  const npmBody = new TextEncoder().encode("npm bytes");
  const npmIntegrity = `sha512-${createHash("sha512").update(npmBody).digest("base64")}`;
  const wheelBody = new TextEncoder().encode("wheel bytes");
  const wheelSha = createHash("sha256").update(wheelBody).digest("hex");
  const pypiWheel = (version: string) => `foo-${version}-py3-none-any.whl`;

  function rangedService(ecosystem: "npm" | "pypi", packageAudit: "audit" | "full" | null) {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_token"), {
      runId: "run-1",
      deadlineAt: new Date(NOW.getTime() + DAY),
      allowlist: ecosystem === "npm" ? { npm: ["foo@^1"] } : { pypi: ["foo>=1,<2"] },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit,
    });
    const registry = new RegistryService({
      adapters: new Map(ecosystem === "npm" ? [["npm", npmAdapter]] : [["pypi", pypiAdapter]]),
      store,
      audit: { audit: async () => NO_ADVISORIES },
      upstream: async (url) => {
        if (url === "https://registry.npmjs.org/foo")
          return Response.json({
            name: "foo",
            "dist-tags": { latest: "2.0.0" },
            time: { "1.0.0": old, "2.0.0": old },
            versions: Object.fromEntries(
              ["1.0.0", "2.0.0"].map((version) => [
                version,
                {
                  name: "foo",
                  version,
                  dist: { tarball: `https://registry.npmjs.org/foo/-/foo-${version}.tgz`, integrity: npmIntegrity },
                },
              ]),
            ),
          });
        // bar is outside the allowlist and declares foo outside the entry's range.
        if (url === "https://registry.npmjs.org/bar")
          return Response.json({
            name: "bar",
            "dist-tags": { latest: "1.0.0" },
            time: { "1.0.0": old },
            versions: {
              "1.0.0": {
                name: "bar",
                version: "1.0.0",
                dependencies: { foo: "^2.0.0" },
                dist: { tarball: "https://registry.npmjs.org/bar/-/bar-1.0.0.tgz", integrity: npmIntegrity },
              },
            },
          });
        if (url === "https://pypi.org/simple/bar/")
          return Response.json({
            name: "bar",
            files: [
              {
                filename: "bar-1.0-py3-none-any.whl",
                url: "https://files.pythonhosted.org/packages/xx/bar-1.0-py3-none-any.whl",
                hashes: { sha256: wheelSha },
                "upload-time": old,
                size: wheelBody.byteLength,
                "core-metadata": true,
              },
            ],
          });
        if (url.endsWith("bar-1.0-py3-none-any.whl.metadata"))
          return new Response("Name: bar\nRequires-Dist: foo>=2\n");
        if (url === "https://pypi.org/simple/foo/")
          return Response.json({
            name: "foo",
            files: ["1.0", "2.0"].map((version) => ({
              filename: pypiWheel(version),
              url: `https://files.pythonhosted.org/packages/xx/${pypiWheel(version)}`,
              hashes: { sha256: wheelSha },
              "upload-time": old,
              size: wheelBody.byteLength,
            })),
          });
        return new Response(ecosystem === "npm" ? npmBody : wheelBody);
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 20, idleTimeoutMs: 1_000 },
      now: () => NOW,
    });
    const get = (subpath: string) => registry.handle({ ...request(subpath), ecosystem });
    return { get, store };
  }

  for (const packageAudit of ["audit", "full"] as const) {
    it(`npm: an audited package declaring foo@^2 does not widen foo@^1 (${packageAudit})`, async () => {
      const { get, store } = rangedService("npm", packageAudit);
      await expect(get("bar")).resolves.toMatchObject({ status: 200 });
      const metadata = await get("foo");
      if (!("body" in metadata)) throw new Error("expected a body");
      expect(Object.keys((JSON.parse(metadata.body) as { versions: object }).versions)).toEqual(["1.0.0"]);
      const download = await get("-/tarball/foo/2.0.0");
      expect(download).toMatchObject({ status: 404 });
      expect("body" in download && download.body).toContain("wardby_version_filtered");
      expect(store.audits).toEqual([]);
    });

    it(`pypi: an audited package requiring foo>=2 does not widen foo>=1,<2 (${packageAudit})`, async () => {
      const { get, store } = rangedService("pypi", packageAudit);
      await expect(get("simple/bar/")).resolves.toMatchObject({ status: 200 });
      const file = await get("files/bar/bar-1.0-py3-none-any.whl.metadata");
      if ("stream" in file) await new Response(file.stream).text();
      expect(store.audits).toMatchObject([{ name: "bar", relation: "top-level" }]);
      const index = await get("simple/foo/");
      if (!("body" in index)) throw new Error("expected a body");
      expect((JSON.parse(index.body) as { files: { filename: string }[] }).files.map((f) => f.filename)).toEqual([
        pypiWheel("1.0"),
      ]);
      const download = await get(`files/foo/${pypiWheel("2.0")}`);
      expect(download).toMatchObject({ status: 404 });
      expect("body" in download && download.body).toContain("wardby_version_filtered");
      expect(store.audits.map((a) => a.name)).toEqual(["bar"]);
    });
  }

  for (const packageAudit of [null, "audit", "full"] as const) {
    it(`npm foo@^1 in mode ${packageAudit}: hides 2.0.0 from metadata and refuses its download`, async () => {
      const { get, store } = rangedService("npm", packageAudit);
      const metadata = await get("foo");
      if (!("body" in metadata)) throw new Error("expected a body");
      expect(Object.keys((JSON.parse(metadata.body) as { versions: object }).versions)).toEqual(["1.0.0"]);
      const download = await get("-/tarball/foo/2.0.0");
      expect(download).toMatchObject({ status: 404 });
      expect("body" in download && download.body).toContain("wardby_version_filtered");
      expect(store.audits).toEqual([]);
    });

    it(`pypi foo>=1,<2 in mode ${packageAudit}: hides 2.0 from the index and refuses its wheel`, async () => {
      const { get, store } = rangedService("pypi", packageAudit);
      const index = await get("simple/foo/");
      if (!("body" in index)) throw new Error("expected a body");
      expect((JSON.parse(index.body) as { files: { filename: string }[] }).files.map((f) => f.filename)).toEqual([
        pypiWheel("1.0"),
      ]);
      const download = await get(`files/foo/${pypiWheel("2.0")}`);
      expect(download).toMatchObject({ status: 404 });
      expect("body" in download && download.body).toContain("wardby_version_filtered");
      expect(store.audits).toEqual([]);
    });
  }
});
