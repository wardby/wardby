import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalBlobStore } from "../../storage/local.js";
import { MemoryProxyLedger } from "../memory-ledger.js";
import { CodingProxy, capabilityHash } from "../proxy.js";
import { MemoryRegistryStore, type RegistryRunContext } from "../registry/store.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "../server.js";
import { deriveSnapshotKey, newBlobKey } from "./key.js";
import { DependencyCacheService } from "./service.js";
import { MemoryDependencyCacheStore } from "./store.js";

const TOKEN = "rrg_cache_token";
const OTHER_TOKEN = "rrg_other_token";
const hex = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const LOCK = hex("lockfile one");
const LOCK_TWO = hex("lockfile two");
const IMAGE = "ghcr.io/wardby/worker@sha256:1111";
const ALLOWLIST = { npm: ["react"] };
const POLICY = { minReleaseAgeDays: 3 };

function fakeProxy(): CodingProxy {
  return new CodingProxy({ ledger: new MemoryProxyLedger(), credentials: { resolve: async () => "UNUSED" } });
}

function context(overrides: Partial<RegistryRunContext> = {}): RegistryRunContext {
  return {
    runId: "run-1",
    deadlineAt: new Date(Date.now() + 3_600_000),
    allowlist: ALLOWLIST,
    policy: POLICY,
    repository: "owner/repo",
    cacheImage: IMAGE,
    dependencyCache: true,
    packageAudit: null,
    ...overrides,
  };
}

const servers: CodingProxyServerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(
  options: {
    configured?: boolean;
    run?: Partial<RegistryRunContext>;
    maxSnapshotBytes?: number;
    uploadMs?: number;
    now?: () => Date;
    lockHashes?: string[];
    requestMs?: number;
    expectedHost?: string;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "dep-cache-"));
  dirs.push(dir);
  const blobs = new LocalBlobStore(dir);
  const registry = new MemoryRegistryStore();
  registry.contexts.set(capabilityHash(TOKEN), context(options.run));
  registry.contexts.set(
    capabilityHash(OTHER_TOKEN),
    context({ runId: "run-2", repository: "other/repo", ...options.run }),
  );
  for (const runId of ["run-1", "run-2"])
    registry.cacheSessions.set(runId, {
      lockHashes: [...(options.lockHashes ?? [LOCK])],
      sealedAt: null,
      createdAt: new Date(),
    });
  const store = new MemoryDependencyCacheStore(registry.cacheSessions);
  /** One proxy replica over the shared store and blob store. */
  const startPod = async () => {
    const cache = new DependencyCacheService({
      registry,
      store,
      blobs,
      maxSnapshotBytes: options.maxSnapshotBytes ?? 1024 * 1024,
      uploadMs: options.uploadMs ?? 900_000,
      now: options.now,
    });
    const server = await startCodingProxyServer(fakeProxy(), {
      host: "127.0.0.1",
      port: 0,
      requestMs: options.requestMs,
      ...(options.expectedHost ? { expectedHost: options.expectedHost } : {}),
      ...(options.configured === false ? {} : { dependencyCache: cache }),
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  };
  const base = await startPod();
  const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
  const query = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) if (value !== undefined) search.set(name, value);
    const text = search.toString();
    return text ? `?${text}` : "";
  };
  const json = async (response: Response) => ({ status: response.status, body: await response.json() });
  return {
    dir,
    blobs,
    store,
    registry,
    base,
    startPod,
    lookup: (params: Record<string, string | undefined> = { lock: LOCK }, token?: string) =>
      fetch(`${base}/cache/npm/lookup${query(params)}`, { headers: auth(token) }).then(json),
    upload: (
      body: Uint8Array,
      params: Record<string, string | undefined> = { lock: LOCK },
      token?: string,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${base}/cache/npm/blob${query(params)}`, {
        method: "PUT",
        headers: { ...auth(token), ...headers },
        body,
      }).then(json),
    download: (id: string, params: Record<string, string | undefined> = { lock: LOCK }, token?: string) =>
      fetch(`${base}/cache/npm/blob/${id}${query(params)}`, { headers: auth(token) }),
    seal: (token?: string) => fetch(`${base}/cache/npm/seal`, { method: "POST", headers: auth(token) }).then(json),
    derived: (projectPath = ".", lockHash = LOCK, repository = "owner/repo") =>
      deriveSnapshotKey({ repository, projectPath, lockHash, workerImage: IMAGE }),
  };
}

const archive = new TextEncoder().encode("gzip tar bytes of node_modules");

/** A chunked upload sent in two parts, so a test can act while it streams. */
function streamingUpload(base: string, token: string, first: string) {
  let body = "";
  let status = 0;
  let finish!: (rest: string) => void;
  const done = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = httpRequest(
      `${base}/cache/npm/blob?lock=${LOCK}`,
      { method: "PUT", headers: { authorization: `Bearer ${token}`, "transfer-encoding": "chunked" } },
      (response) => {
        status = response.statusCode ?? 0;
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status, body: JSON.parse(body) }));
      },
    );
    request.on("error", reject);
    request.write(first);
    finish = (rest) => request.end(rest);
  });
  return {
    finish: (rest: string) => {
      finish(rest);
      return done;
    },
  };
}

async function storedFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

/** Polls until `ready` holds (or fails the test after `timeoutMs`). */
async function waitFor(ready: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > until) throw new Error("waitFor: condition not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("dependency cache routes: switches and authentication", () => {
  it("answers 404 for every route when the cache is not configured", async () => {
    const { base } = await setup({ configured: false });
    for (const [method, path] of [
      ["GET", "/cache/npm/lookup"],
      ["PUT", "/cache/npm/blob"],
      ["GET", "/cache/npm/blob/x"],
      ["POST", "/cache/npm/seal"],
    ]) {
      const response = await fetch(`${base}${path}?lock=${LOCK}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(404);
    }
  });

  it("answers 404 for a run whose agent has the cache off, or with no recorded image", async () => {
    for (const run of [{ dependencyCache: false }, { cacheImage: null }]) {
      const { lookup, seal } = await setup({ run });
      expect(await lookup()).toEqual({ status: 404, body: { error: "not_found" } });
      expect((await seal()).status).toBe(404);
    }
  });

  it("refuses an unknown registry token, an unknown route and a wrong method", async () => {
    const { lookup, base } = await setup();
    expect(await lookup({ lock: LOCK }, "rrg_nope")).toEqual({ status: 401, body: { error: "invalid_capability" } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${base}/cache/npm/other`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/cache/pypi/lookup?lock=${LOCK}`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/cache/npm/lookup?lock=${LOCK}`, { method: "DELETE", headers: auth })).status).toBe(
      405,
    );
  });
});

describe("dependency cache lookup", () => {
  it("reports the milliseconds left in the run's upload window", async () => {
    const created = new Date("2026-01-01T00:00:00Z");
    let clock = created.getTime() + 100_000;
    const { lookup, registry } = await setup({ uploadMs: 900_000, now: () => new Date(clock) });
    for (const session of registry.cacheSessions.values()) session.createdAt = created;
    expect((await lookup()).body).toMatchObject({ uploadExpiresInMs: 800_000 });
    clock = created.getTime() + 2_000_000;
    expect((await lookup()).body).toMatchObject({ uploadExpiresInMs: 0 });
  });

  it("requires a lockfile the run's plan approved", async () => {
    const { lookup } = await setup();
    expect(await lookup({ lock: LOCK_TWO })).toEqual({ status: 409, body: { error: "plan_required" } });
    expect(await lookup({})).toEqual({ status: 409, body: { error: "plan_required" } });
    expect(await lookup({ lock: "../../etc" })).toEqual({ status: 409, body: { error: "plan_required" } });
  });

  it("refuses an invalid project path", async () => {
    const { lookup, upload } = await setup();
    for (const project of ["../x", "a/node_modules", ".git", "a/b/c/d", "/abs"]) {
      expect(await lookup({ lock: LOCK, project })).toEqual({ status: 400, body: { error: "invalid_project" } });
      expect(await upload(archive, { lock: LOCK, project })).toEqual({
        status: 400,
        body: { error: "invalid_project" },
      });
    }
  });

  it("derives the key on the proxy, ignoring anything else the client sends", async () => {
    const { lookup, derived } = await setup();
    const { status, body } = await lookup({
      lock: LOCK,
      repository: "evil/repo",
      image: "evil:latest",
      policy: "{}",
      key: "dependency-cache/npm/x",
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      key: derived().keyId,
      hit: false,
      maxBytes: 1024 * 1024,
      uploadExpiresInMs: expect.any(Number),
    });
  });

  it("refuses a repeated query parameter", async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/cache/npm/lookup?lock=${LOCK}&lock=${LOCK_TWO}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(400);
  });
});

describe("dependency cache upload and download", () => {
  it("stores the upload under the derived key with its sha256, then serves it", async () => {
    const { upload, lookup, download, store, blobs, derived } = await setup();
    expect(await upload(archive)).toEqual({
      status: 201,
      body: { stored: true, sha256: hex(archive), sizeBytes: archive.byteLength },
    });
    const key = derived();
    expect(store.rows).toEqual([
      expect.objectContaining({
        ecosystem: "npm",
        repository: "owner/repo",
        projectPath: ".",
        lockHash: LOCK,
        workerImage: IMAGE,
        blobKey: expect.stringMatching(/^dependency-cache\/npm\/.+-[0-9a-f-]{36}\.tgz$/),
        sha256: hex(archive),
        sizeBytes: archive.byteLength,
        createdByRunId: "run-1",
      }),
    ]);
    expect(await blobs.head(store.rows[0].blobKey)).toMatchObject({ sizeBytes: archive.byteLength });

    expect((await lookup()).body).toEqual({
      key: key.keyId,
      hit: true,
      maxBytes: 1024 * 1024,
      uploadExpiresInMs: expect.any(Number),
    });
    const before = store.rows[0].lastUsedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await download(key.keyId);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-wardby-sha256")).toBe(hex(archive));
    expect(response.headers.get("content-length")).toBe(String(archive.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(archive);
    expect(store.rows[0].lastUsedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("returns a digest-bound manifest only for uploads with complete validated metadata", async () => {
    const { upload, lookup, store } = await setup();
    const headers = {
      "x-wardby-archive-scan-version": "1",
      "x-wardby-archive-entries": "42",
      "x-wardby-archive-unpacked-bytes": "123456",
    };
    expect((await upload(archive, { lock: LOCK }, undefined, headers)).status).toBe(201);
    expect(store.rows[0]).toMatchObject({ archiveScanVersion: 1, archiveEntries: 42, unpackedBytes: 123456 });
    expect((await lookup()).body).toMatchObject({
      hit: true,
      manifest: { scanVersion: 1, sha256: hex(archive), entries: 42, unpackedBytes: 123456 },
    });
  });

  it("returns no manifest for a row without validation metadata (a legacy snapshot), hit or nearest", async () => {
    const { upload, lookup, store } = await setup({ lockHashes: [LOCK, LOCK_TWO] });
    expect((await upload(archive)).status).toBe(201);
    expect(store.rows[0]).toMatchObject({ archiveScanVersion: null, archiveEntries: null, unpackedBytes: null });
    const hit = (await lookup()).body as Record<string, unknown>;
    expect(hit.hit).toBe(true);
    expect(hit).not.toHaveProperty("manifest");
    const near = (await lookup({ lock: LOCK_TWO })).body as { nearest: Record<string, unknown> };
    expect(near).toMatchObject({ hit: false, nearest: { id: store.rows[0].id } });
    expect(near).not.toHaveProperty("manifest");
    expect(near.nearest).not.toHaveProperty("manifest");
  });

  it("returns nearest.manifest for a nearest row uploaded with validation metadata", async () => {
    const { upload, lookup, store } = await setup({ lockHashes: [LOCK, LOCK_TWO] });
    const headers = {
      "x-wardby-archive-scan-version": "1",
      "x-wardby-archive-entries": "7",
      "x-wardby-archive-unpacked-bytes": "4096",
    };
    expect((await upload(archive, { lock: LOCK_TWO }, undefined, headers)).status).toBe(201);
    const { body } = await lookup({ lock: LOCK });
    expect(body).toMatchObject({
      hit: false,
      nearest: {
        id: store.rows[0].id,
        manifest: { scanVersion: 1, sha256: hex(archive), entries: 7, unpackedBytes: 4096 },
      },
    });
    // The manifest belongs to the nearest snapshot, not to the (missing) hit.
    expect(body).not.toHaveProperty("manifest");
  });

  it("binds the manifest to the row's recorded sha256, never to a client value", async () => {
    const manifestSha256 = (body: unknown) => (body as { manifest: { sha256: string } }).manifest.sha256;
    const { upload, lookup, store } = await setup();
    const headers = {
      "x-wardby-archive-scan-version": "1",
      "x-wardby-archive-entries": "3",
      "x-wardby-archive-unpacked-bytes": "10",
      // Not part of the protocol: a client cannot choose the digest.
      "x-wardby-archive-sha256": "0".repeat(64),
      "x-wardby-sha256": "0".repeat(64),
    };
    expect((await upload(archive, { lock: LOCK }, undefined, headers)).status).toBe(201);
    expect(store.rows[0].sha256).toBe(hex(archive));
    expect(manifestSha256((await lookup()).body)).toBe(hex(archive));
    // The manifest follows what the database recorded for the row.
    store.rows[0].sha256 = "f".repeat(64);
    expect(manifestSha256((await lookup()).body)).toBe("f".repeat(64));
  });

  it("refuses partial or malformed validation metadata", async () => {
    const { upload, store } = await setup();
    expect(await upload(archive, { lock: LOCK }, undefined, { "x-wardby-archive-scan-version": "1" })).toEqual({
      status: 400,
      body: { error: "bad_request" },
    });
    expect(
      await upload(archive, { lock: LOCK }, undefined, {
        "x-wardby-archive-scan-version": "1",
        "x-wardby-archive-entries": "0",
        "x-wardby-archive-unpacked-bytes": "1",
      }),
    ).toEqual({ status: 400, body: { error: "bad_request" } });
    expect(store.rows).toEqual([]);
  });

  it("accepts one upload per project per run; another project is allowed", async () => {
    const { upload } = await setup();
    expect((await upload(archive)).status).toBe(201);
    expect(await upload(new TextEncoder().encode("different"))).toEqual({
      status: 409,
      body: { error: "already_uploaded" },
    });
    expect((await upload(archive, { lock: LOCK, project: "packages/web" })).status).toBe(201);
  });

  it("answers an upload for a key already stored as success without storing it again", async () => {
    const { upload, store } = await setup();
    // Same repository, lock and image in another run: the same key.
    expect((await upload(archive)).status).toBe(201);
    const otherSameRepo = await setup();
    otherSameRepo.store.rows.push(...store.rows.map((row) => ({ ...row, createdByRunId: "run-earlier" })));
    expect(await otherSameRepo.upload(archive)).toEqual({ status: 200, body: { stored: false, reason: "exists" } });
    expect(otherSameRepo.store.rows).toHaveLength(1);
  });

  it("enforces maxBytes, from content-length and while streaming", async () => {
    const { upload, store, dir, base } = await setup({ maxSnapshotBytes: 16 });
    expect(await upload(new Uint8Array(17))).toEqual({ status: 413, body: { error: "too_large" } });
    // Chunked (no content-length): refused while streaming.
    const status = await new Promise<number | "reset">((resolve) => {
      const request = httpRequest(
        `${base}/cache/npm/blob?lock=${LOCK}`,
        { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "transfer-encoding": "chunked" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", () => resolve("reset"));
      request.write(new Uint8Array(10));
      request.write(new Uint8Array(10));
      request.end();
    });
    expect([413, "reset"]).toContain(status);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.rows).toEqual([]);
    expect(
      await readdir(dir, { recursive: true, withFileTypes: true }).then((e) => e.filter((x) => x.isFile())),
    ).toEqual([]);
  });

  it("refuses an upload past the upload window", async () => {
    let now = new Date();
    const { upload, store } = await setup({ uploadMs: 60_000, now: () => now });
    now = new Date(now.getTime() + 61_000);
    expect(await upload(archive)).toEqual({ status: 409, body: { error: "upload_expired" } });
    expect(store.rows).toEqual([]);
  });

  it("refuses a download of another repository's key or of an unrelated id", async () => {
    const { upload, download, derived, store } = await setup();
    expect((await upload(archive, { lock: LOCK }, OTHER_TOKEN)).status).toBe(201);
    const otherKey = derived(".", LOCK, "other/repo");
    expect((await download(otherKey.keyId)).status).toBe(404);
    expect((await download(store.rows[0].id)).status).toBe(404);
    expect((await download("cunrelated000000000000000")).status).toBe(404);
    expect((await download("..%2F..%2Fsecret")).status).toBe(404);
    // Its owner can.
    expect((await download(otherKey.keyId, { lock: LOCK }, OTHER_TOKEN)).status).toBe(200);
  });

  it("offers and serves the nearest snapshot of the same project for a different lockfile", async () => {
    const { upload, lookup, download, store } = await setup({ lockHashes: [LOCK, LOCK_TWO] });
    expect((await upload(archive, { lock: LOCK_TWO })).status).toBe(201);
    expect((await upload(archive, { lock: LOCK_TWO, project: "web" })).status).toBe(201);
    const nearest = store.rows.find((row) => row.projectPath === ".")!;
    const elsewhere = store.rows.find((row) => row.projectPath === "web")!;
    const { body } = await lookup({ lock: LOCK });
    expect(body).toMatchObject({ hit: false, nearest: { id: nearest.id } });
    const response = await download(nearest.id, { lock: LOCK });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-wardby-sha256")).toBe(hex(archive));
    await response.arrayBuffer();
    // Another project's snapshot is never the nearest.
    expect((await download(elsewhere.id, { lock: LOCK })).status).toBe(404);
  });

  it("drops a row whose blob is gone", async () => {
    const { upload, download, derived, store, blobs } = await setup();
    await upload(archive);
    await blobs.delete(store.rows[0].blobKey);
    expect((await download(derived().keyId)).status).toBe(404);
    expect(store.rows).toEqual([]);
  });

  describe("a blob that fails its row's checksum", () => {
    const broken = async (replacement: Uint8Array | null) => {
      const env = await setup();
      await env.upload(archive);
      const row = env.store.rows[0];
      if (replacement) await env.blobs.put(row.blobKey, Buffer.from(replacement));
      return { ...env, row };
    };
    const fetchBlob = (base: string, id: string) =>
      fetch(`${base}/cache/npm/blob/${id}?lock=${LOCK}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      })
        .then((response) => response.arrayBuffer())
        .then(
          () => "complete",
          (error: Error) => (error.name === "TimeoutError" ? "timed out" : "failed"),
        );

    it.each([
      // Every byte was already sent: the client's own sha256 check refuses it.
      ["tampered (same size)", new TextEncoder().encode("GZIP TAR BYTES OF NODE_MODULES"), undefined],
      // Fewer or more bytes than the row: the response fails at once, not at the client's timeout.
      ["truncated", archive.subarray(0, 10), "failed"],
      ["longer", new TextEncoder().encode("gzip tar bytes of node_modules and then some"), "failed"],
    ])("drops the row and the blob after one download of a %s blob", async (_name, bytes, outcome) => {
      const { base, lookup, store, blobs, derived, row } = await broken(bytes);
      const result = await fetchBlob(base, derived().keyId);
      if (outcome) expect(result).toBe(outcome);
      await waitFor(() => store.rows.length === 0);
      await waitFor(async () => (await blobs.head(row.blobKey)) === null);
      expect((await lookup()).body).toMatchObject({ hit: false });
    });

    it("keeps the row when the client aborts mid-stream", async () => {
      const { base, store, blobs, derived, row } = await broken(null);
      const stalled = new Readable({ read() {} });
      stalled.push(archive.subarray(0, 5));
      const spy = vi.spyOn(blobs, "getStream").mockImplementation(async () => stalled);
      const controller = new AbortController();
      const response = await fetch(`${base}/cache/npm/blob/${derived().keyId}?lock=${LOCK}`, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
      const closed = new Promise<void>((resolve) => stalled.on("close", () => resolve()));
      controller.abort();
      // The proxy saw the abort once it destroyed the blob stream.
      await closed;
      spy.mockRestore();
      expect(store.rows).toHaveLength(1);
      expect(await blobs.head(row.blobKey)).not.toBeNull();
    });

    it("does not delete a row that a re-upload replaced while the old blob streamed", async () => {
      const { store, blobs, row } = await broken(null);
      const replaced = { ...row, blobKey: "dependency-cache/npm/other-blob.tgz" };
      expect(await store.deleteIfBlob(row.id, replaced.blobKey)).toBe(false);
      expect(store.rows).toHaveLength(1);
      expect(await blobs.head(row.blobKey)).not.toBeNull();
    });
  });
});

describe("the agent's package policy is not part of the key", () => {
  const THIRD_TOKEN = "rrg_third_token";
  /** Changes run-1's allowlist (the agent's policy was edited between runs). */
  const changePolicy = (registry: MemoryRegistryStore) => {
    const run = registry.contexts.get(capabilityHash(TOKEN))!;
    registry.contexts.set(capabilityHash(TOKEN), { ...run, allowlist: { npm: ["react", "vue"] }, policy: {} });
  };
  /** A run of a second agent on the same repository, with its own allowlist. */
  const addSecondAgent = (registry: MemoryRegistryStore, lockHashes: string[]) => {
    registry.contexts.set(
      capabilityHash(THIRD_TOKEN),
      context({ runId: "run-3", allowlist: { npm: ["lodash"] }, policy: { minReleaseAgeDays: 7 } }),
    );
    registry.cacheSessions.set("run-3", { lockHashes, sealedAt: null, createdAt: new Date() });
  };

  it("restores a snapshot for the same lockfile after the allowlist changes", async () => {
    const { upload, lookup, download, registry, derived } = await setup();
    expect((await upload(archive)).status).toBe(201);
    changePolicy(registry);
    const { body } = await lookup();
    expect(body).toMatchObject({ key: derived().keyId, hit: true });
    const response = await download(derived().keyId);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(archive);
  });

  it("gives a second agent on the same repository, with a different allowlist, the hit", async () => {
    const { upload, lookup, download, registry, derived } = await setup();
    expect((await upload(archive)).status).toBe(201);
    addSecondAgent(registry, [LOCK]);
    expect((await lookup({ lock: LOCK }, THIRD_TOKEN)).body).toMatchObject({ key: derived().keyId, hit: true });
    const response = await download(derived().keyId, { lock: LOCK }, THIRD_TOKEN);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(archive);
  });

  it("offers the nearest snapshot across a policy change", async () => {
    const { upload, lookup, download, registry, store } = await setup({ lockHashes: [LOCK, LOCK_TWO] });
    expect((await upload(archive, { lock: LOCK_TWO })).status).toBe(201);
    changePolicy(registry);
    const { body } = await lookup({ lock: LOCK });
    expect(body).toMatchObject({ hit: false, nearest: { id: store.rows[0].id } });
    const response = await download(store.rows[0].id, { lock: LOCK });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it("still restores nothing for a lockfile the current policy did not approve (the plan gate)", async () => {
    const { upload, lookup, download, registry, derived } = await setup();
    expect((await upload(archive)).status).toBe(201);
    // The second agent's policy refused this lockfile: its plan approved none.
    addSecondAgent(registry, []);
    expect(await lookup({ lock: LOCK }, THIRD_TOKEN)).toEqual({ status: 409, body: { error: "plan_required" } });
    expect((await download(derived().keyId, { lock: LOCK }, THIRD_TOKEN)).status).toBe(409);
  });
});

describe("dependency cache seal", () => {
  it("is idempotent and closes every other route", async () => {
    const { seal, lookup, upload, download, store, registry, derived } = await setup();
    expect((await upload(archive, { lock: LOCK, project: "web" })).status).toBe(201);
    expect(await seal()).toEqual({ status: 200, body: { sealed: true } });
    const sealedAt = registry.cacheSessions.get("run-1")!.sealedAt;
    expect(sealedAt).toBeInstanceOf(Date);
    expect(await seal()).toEqual({ status: 200, body: { sealed: true } });
    expect(registry.cacheSessions.get("run-1")!.sealedAt).toBe(sealedAt);

    expect(await upload(archive)).toEqual({ status: 409, body: { error: "sealed" } });
    expect(await lookup()).toEqual({ status: 409, body: { error: "sealed" } });
    const response = await download(derived("web").keyId, { lock: LOCK, project: "web" });
    expect([response.status, await response.json()]).toEqual([409, { error: "sealed" }]);
    expect(store.rows).toHaveLength(1);
  });

  it("refuses an upload that finishes after the seal, and keeps nothing of it", async () => {
    const { base, seal, store, dir } = await setup();
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        `${base}/cache/npm/blob?lock=${LOCK}`,
        { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "transfer-encoding": "chunked" } },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on("error", reject);
      request.write("first half ");
      setTimeout(() => {
        void seal().then(() => request.end("second half"));
      }, 50);
    });
    expect(await result).toEqual({ status: 409, body: JSON.stringify({ error: "sealed" }) });
    expect(store.rows).toEqual([]);
    expect(
      await readdir(dir, { recursive: true, withFileTypes: true }).then((e) => e.filter((x) => x.isFile())),
    ).toEqual([]);
  });
});

describe("request time limits with the cache on", () => {
  it("lets an upload stream for longer than requestMs, but no other request body", async () => {
    const { base, store } = await setup({ requestMs: 150 });
    const slowUpload = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${base}/cache/npm/blob?lock=${LOCK}`,
        { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "transfer-encoding": "chunked" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.write("part one ");
      setTimeout(() => request.write("part two "), 150);
      setTimeout(() => request.end("part three"), 300);
    });
    expect(slowUpload).toBe(201);
    expect(store.rows).toHaveLength(1);

    const stalled = await new Promise<string>((resolve) => {
      const request = httpRequest(`${base}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "100" },
      });
      request.on("error", () => resolve("closed"));
      request.on("response", (response) => resolve(`status ${response.statusCode}`));
      request.write("{");
      setTimeout(() => resolve("still open"), 3_000);
    });
    expect(stalled).toBe("closed");
  });
});

describe("each upload writes its own blob object", () => {
  it("keeps the winner's bytes when two replicas upload the same key at once, and deletes the loser's", async () => {
    // run-1 and run-2 share a repository, so they derive the same key.
    const { base, startPod, store, dir } = await setup({ run: { repository: "owner/repo" } });
    const otherPod = await startPod();
    const winner = streamingUpload(base, TOKEN, "winner ");
    const loser = streamingUpload(otherPod, OTHER_TOKEN, "loser ");
    await settle(); // both past their checks and streaming
    expect(await winner.finish("bytes")).toEqual({
      status: 201,
      body: { stored: true, sha256: hex("winner bytes"), sizeBytes: 12 },
    });
    expect(await loser.finish("other bytes")).toEqual({ status: 200, body: { stored: false, reason: "exists" } });
    expect(store.rows).toHaveLength(1);
    const files = await storedFiles(dir);
    expect(files).toEqual([join(dir, store.rows[0].blobKey)]);
    const bytes = await readFile(files[0]);
    expect(hex(bytes)).toBe(store.rows[0].sha256);
    expect(bytes.byteLength).toBe(store.rows[0].sizeBytes);
  });

  it("an upload refused after the seal leaves a committed snapshot's blob intact", async () => {
    const { base, startPod, store, dir, seal } = await setup({ run: { repository: "owner/repo" } });
    const otherPod = await startPod();
    const refused = streamingUpload(base, TOKEN, "late ");
    await settle();
    const committed = await fetch(`${otherPod}/cache/npm/blob?lock=${LOCK}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
      body: archive,
    });
    expect(committed.status).toBe(201);
    expect((await seal()).status).toBe(200);
    expect(await refused.finish("bytes")).toEqual({ status: 409, body: { error: "sealed" } });
    expect(store.rows).toHaveLength(1);
    const files = await storedFiles(dir);
    expect(files).toEqual([join(dir, store.rows[0].blobKey)]);
    expect(hex(await readFile(files[0]))).toBe(hex(archive));
    expect(store.rows[0].sha256).toBe(hex(archive));
  });

  it("writes a new object per upload under the key's prefix", async () => {
    const { upload, store, derived } = await setup();
    await upload(archive);
    await upload(archive, { lock: LOCK, project: "web" });
    const [root, web] = store.rows;
    expect(root.blobKey).not.toBe(web.blobKey);
    expect(root.blobKey.slice(0, -41)).toBe(newBlobKey(derived()).slice(0, -41));
  });
});

describe("the per-request body timer before an upload is admitted", () => {
  /** Sends an upload-shaped request and keeps trickling its body; resolves when the server cuts it. */
  function trickle(base: string, headers: Record<string, string>) {
    const started = Date.now();
    return new Promise<{ status: number | null; closedAfterMs: number }>((resolve) => {
      let status: number | null = null;
      const request = httpRequest(`${base}/cache/npm/blob?lock=${LOCK}`, {
        method: "PUT",
        agent: false,
        // keep-alive: a client that asks for close would end the connection by itself.
        headers: { "content-length": "100000", connection: "keep-alive", ...headers },
      });
      const drip = setInterval(() => request.write("x"), 50);
      const done = () => {
        clearInterval(drip);
        resolve({ status, closedAfterMs: Date.now() - started });
      };
      request.on("response", (response) => {
        status = response.statusCode ?? null;
        response.resume();
      });
      request.on("error", done);
      request.on("close", done);
      request.write("x");
      setTimeout(() => {
        request.destroy();
      }, 5_000);
    });
  }

  it("cuts an upload-shaped request with a bad host or bad token at the normal limit", async () => {
    const host = "wardby-proxy:8787";
    const { base } = await setup({ requestMs: 300, expectedHost: host });
    const badHost = await trickle(base, { host: "elsewhere:1", authorization: `Bearer ${TOKEN}` });
    expect(badHost.status).toBe(403);
    expect(badHost.closedAfterMs).toBeLessThan(2_000);
    const badToken = await trickle(base, { host, authorization: "Bearer rrg_nope" });
    expect(badToken.status).toBe(401);
    expect(badToken.closedAfterMs).toBeLessThan(2_000);
    const encoded = await trickle(base, { host, authorization: `Bearer ${TOKEN}`, "content-encoding": "gzip" });
    expect(encoded.status).toBe(400);
    expect(encoded.closedAfterMs).toBeLessThan(2_000);
  });
});
