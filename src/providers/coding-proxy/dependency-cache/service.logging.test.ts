import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../../core/logger.js", () => ({ logger: { child: () => log, ...log } }));

const { LocalBlobStore } = await import("../../storage/local.js");
const { MemoryProxyLedger } = await import("../memory-ledger.js");
const { CodingProxy, capabilityHash } = await import("../proxy.js");
const { MemoryRegistryStore } = await import("../registry/store.js");
const { startCodingProxyServer } = await import("../server.js");
const { deriveSnapshotKey } = await import("./key.js");
const { DependencyCacheService } = await import("./service.js");
const { MemoryDependencyCacheStore } = await import("./store.js");

const TOKEN = "rrg_secret_cache_token";
const LOCK = "b".repeat(64);
const servers: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];
beforeEach(() => Object.values(log).forEach((fn) => fn.mockClear()));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const registry = new MemoryRegistryStore();
  registry.contexts.set(capabilityHash(TOKEN), {
    runId: "run-1",
    deadlineAt: new Date(Date.now() + 3_600_000),
    allowlist: {},
    policy: {},
    repository: "owner/repo",
    cacheImage: "worker:1",
    dependencyCache: true,
    packageAudit: null,
  });
  registry.cacheSessions.set("run-1", { lockHashes: [LOCK], sealedAt: null, createdAt: new Date() });
  const store = new MemoryDependencyCacheStore(registry.cacheSessions);
  const dir = await mkdtemp(join(tmpdir(), "dep-cache-log-"));
  dirs.push(dir);
  const blobs = new LocalBlobStore(dir);
  const cache = new DependencyCacheService({ registry, store, blobs, maxSnapshotBytes: 1024, uploadMs: 900_000 });
  const proxy = new CodingProxy({ ledger: new MemoryProxyLedger(), credentials: { resolve: async () => "UNUSED" } });
  const server = await startCodingProxyServer(proxy, { host: "127.0.0.1", port: 0, dependencyCache: cache });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}/cache/npm`;
  const call = (path: string, init: RequestInit = {}, token = TOKEN) =>
    fetch(`${base}/${path}`, { ...init, headers: { authorization: `Bearer ${token}` } }).then(
      (response) => response.status,
    );
  const keyId = deriveSnapshotKey({
    repository: "owner/repo",
    projectPath: ".",
    lockHash: LOCK,
    workerImage: "worker:1",
  }).keyId;
  return { registry, store, blobs, call, keyId };
}

const refusals = () =>
  log.info.mock.calls.map(([fields]) => fields).filter((fields) => fields.event === "dependency_cache.refused");

describe("dependency cache logging", () => {
  it("logs one line per refusal with the route and code, and the run once the token names one", async () => {
    const { call, registry } = await setup();
    expect(await call(`lookup?lock=${LOCK}`, {}, "rrg_unknown_token")).toBe(401);
    expect(await call("nowhere")).toBe(404);
    expect(await call(`lookup?lock=${"c".repeat(64)}`)).toBe(409);
    registry.cacheSessions.get("run-1")!.sealedAt = new Date();
    expect(await call(`blob?lock=${LOCK}`, { method: "PUT", body: "bytes" })).toBe(409);
    expect(refusals()).toEqual([
      { event: "dependency_cache.refused", route: "lookup", status: 401, code: "invalid_capability" },
      { event: "dependency_cache.refused", route: "unknown", status: 404, code: "not_found" },
      { event: "dependency_cache.refused", runId: "run-1", route: "lookup", status: 409, code: "plan_required" },
      { event: "dependency_cache.refused", runId: "run-1", route: "upload", status: 409, code: "sealed" },
    ]);
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("rrg_unknown_token");
    expect(logged).not.toContain(LOCK);
  });

  it("logs a row dropped for its missing blob", async () => {
    const { call, store, blobs, keyId } = await setup();
    expect(await call(`blob?lock=${LOCK}`, { method: "PUT", body: "bytes" })).toBe(201);
    const row = store.rows[0];
    await blobs.delete(row.blobKey);
    expect(await call(`blob/${keyId}?lock=${LOCK}`)).toBe(404);
    expect(log.info).toHaveBeenCalledWith(
      { event: "dependency_cache.blob_missing", runId: "run-1", snapshotId: row.id },
      expect.any(String),
    );
    expect(refusals()).toEqual([
      { event: "dependency_cache.refused", runId: "run-1", route: "download", status: 404, code: "not_found" },
    ]);
  });
});
