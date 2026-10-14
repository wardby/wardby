import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../../core/db.js";
import { LocalBlobStore } from "../../storage/local.js";
import { MemoryProxyLedger } from "../memory-ledger.js";
import { CodingProxy } from "../proxy.js";
import { PrismaRegistryStore } from "../registry/prisma-store.js";
import { startCodingProxyServer } from "../server.js";
import { PrismaDependencyCacheStore } from "./prisma-store.js";
import { DependencyCacheService } from "./service.js";
import { POLICY_ANY, type NewSnapshot } from "./store.js";

const db = createPrismaClient();
const hex = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!process.env.DATABASE_URL)("PrismaDependencyCacheStore (database)", () => {
  const agentIds: string[] = [];
  const runIds: string[] = [];
  const repositories: string[] = [];

  afterAll(async () => {
    await db.dependencySnapshot.deleteMany({ where: { repository: { in: repositories } } });
    await db.codingRun.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
  });

  async function seedRun(suffix: string = randomUUID(), dependencyCache = true) {
    const agentId = `cache-agent-${suffix}`;
    const runId = `cache-run-${suffix}`;
    const repository = `owner/cache-${suffix}`;
    agentIds.push(agentId);
    runIds.push(runId);
    repositories.push(repository);
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
    });
    await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
    await db.codingRun.create({
      data: {
        runId,
        task: "test",
        repository,
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 60,
        protectedPaths: [],
        budgetReservedUsd: 0.0002,
        workerImage: "worker:1",
        dependencyCache,
      },
    });
    await db.codingProxySession.create({
      data: {
        runId,
        capabilityHash: `capability-${suffix}`,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: ["gpt-5.6-luna"],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 0.0002,
        status: "active",
        registryTokenHash: `registry-${suffix}`,
      },
    });
    return { runId, repository, tokenHash: `registry-${suffix}` };
  }

  const snapshot = (
    repository: string,
    runId: string,
    lock: string,
    extra: Partial<NewSnapshot> = {},
  ): NewSnapshot => ({
    ecosystem: "npm",
    repository,
    projectPath: ".",
    lockHash: hex(lock),
    workerImage: "worker:1",
    blobKey: `dependency-cache/npm/${hex(repository)}/${hex(lock)}-${randomUUID()}.tgz`,
    sha256: hex(`${lock} bytes`),
    sizeBytes: 3_000_000_000,
    archiveScanVersion: null,
    archiveEntries: null,
    unpackedBytes: null,
    createdByRunId: runId,
    ...extra,
  });

  it("records approved lockfile hashes only while unsealed, once each, within the cap", async () => {
    const { runId, tokenHash } = await seedRun();
    const registry = new PrismaRegistryStore(db);
    const cache = new PrismaDependencyCacheStore(db);
    expect(await registry.findRunByRegistryTokenHash(tokenHash, new Date())).toMatchObject({
      cacheImage: "worker:1",
      dependencyCache: true,
    });
    await registry.recordDependencyCacheLockHash(runId, hex("a"), 2);
    await registry.recordDependencyCacheLockHash(runId, hex("a"), 2);
    await registry.recordDependencyCacheLockHash(runId, hex("b"), 2);
    await registry.recordDependencyCacheLockHash(runId, hex("c"), 2);
    expect((await cache.session(runId))?.lockHashes).toEqual([hex("a"), hex("b")]);

    const first = new Date("2026-10-12T01:00:00Z");
    await cache.seal(runId, first);
    await cache.seal(runId, new Date("2026-10-12T02:00:00Z"));
    const session = await cache.session(runId);
    expect(session?.sealedAt).toEqual(first);
    expect(session?.createdAt).toBeInstanceOf(Date);

    const { runId: other } = await seedRun();
    await cache.seal(other, first);
    await registry.recordDependencyCacheLockHash(other, hex("a"), 8);
    expect((await cache.session(other))?.lockHashes).toEqual([]);
    expect(await cache.session("no-such-run")).toBeNull();
  });

  it("seals on a model request only a run with the cache on, once", async () => {
    const cache = new PrismaDependencyCacheStore(db);
    const { runId } = await seedRun();
    const first = new Date("2026-10-12T01:00:00Z");
    await cache.sealForModelRequest(runId, first);
    await cache.sealForModelRequest(runId, new Date("2026-10-12T02:00:00Z"));
    expect((await cache.session(runId))?.sealedAt).toEqual(first);
    const { runId: off } = await seedRun(randomUUID(), false);
    await cache.sealForModelRequest(off, first);
    expect((await cache.session(off))?.sealedAt).toBeNull();
  });

  it("inserts a snapshot once, answering a concurrent duplicate as exists", async () => {
    const { runId, repository } = await seedRun();
    const cache = new PrismaDependencyCacheStore(db);
    const outcomes = await Promise.all([
      cache.insert(snapshot(repository, runId, "lock")),
      cache.insert(snapshot(repository, runId, "lock")),
    ]);
    expect(outcomes.sort()).toEqual(["exists", "inserted"]);
    const row = await cache.findByIdentity(snapshot(repository, runId, "lock"));
    expect(row).toMatchObject({ sha256: hex("lock bytes"), sizeBytes: 3_000_000_000, createdByRunId: runId });
    expect(await cache.hasUploaded(runId, "npm", ".")).toBe(true);
    expect(await cache.hasUploaded(runId, "npm", "web")).toBe(false);
  });

  it("finds the most recent snapshot of the same scope with another lockfile", async () => {
    const { runId, repository } = await seedRun();
    const cache = new PrismaDependencyCacheStore(db);
    await cache.insert(snapshot(repository, runId, "older"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await cache.insert(snapshot(repository, runId, "newer"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await cache.insert(snapshot(repository, runId, "current"));
    await cache.insert(snapshot(repository, runId, "other project", { projectPath: "web" }));
    await cache.insert(snapshot(repository, runId, "other image", { workerImage: "worker:2" }));
    // Shaped like a derived key (extra fields), as the service passes it.
    const scope = {
      ecosystem: "npm",
      repository,
      projectPath: ".",
      workerImage: "worker:1",
      blobKey: "ignored",
      keyId: "ignored",
    };
    expect((await cache.findNearest(scope, hex("current")))?.lockHash).toBe(hex("newer"));
    expect((await cache.findNearest(scope, hex("newer")))?.lockHash).toBe(hex("current"));
    expect(await cache.findNearest({ ...scope, workerImage: "worker:3" }, hex("current"))).toBeNull();
  });

  it("writes every row with POLICY_ANY and never matches a row stored under a real policy hash", async () => {
    const { runId, repository } = await seedRun();
    const cache = new PrismaDependencyCacheStore(db);
    // A row written before the policy left the key.
    const { createdByRunId: _run, ...legacy } = snapshot(repository, runId, "legacy");
    await db.dependencySnapshot.create({
      data: { ...legacy, policyHash: hex("old policy"), sizeBytes: BigInt(legacy.sizeBytes) },
    });
    expect(await cache.findByIdentity(snapshot(repository, runId, "legacy"))).toBeNull();
    expect(await cache.findNearest(snapshot(repository, runId, "current"), hex("current"))).toBeNull();
    // The same identity stores alongside it, under POLICY_ANY.
    expect(await cache.insert(snapshot(repository, runId, "legacy"))).toBe("inserted");
    const rows = await db.dependencySnapshot.findMany({ where: { repository }, select: { policyHash: true } });
    expect(rows.map((row) => row.policyHash).sort()).toEqual([POLICY_ANY, hex("old policy")].sort());
    expect(await cache.findByIdentity(snapshot(repository, runId, "legacy"))).not.toHaveProperty("policyHash");
  });

  it("touches, lists and deletes rows for eviction", async () => {
    const { runId, repository } = await seedRun();
    const cache = new PrismaDependencyCacheStore(db);
    await cache.insert(snapshot(repository, runId, "evict me"));
    const row = (await cache.findByIdentity(snapshot(repository, runId, "evict me")))!;
    const later = new Date(row.lastUsedAt.getTime() + 60_000);
    await cache.touch(row.id, later);
    const listed = (await cache.listForEviction()).find((entry) => entry.id === row.id);
    expect(listed).toEqual({
      id: row.id,
      repository,
      blobKey: row.blobKey,
      sizeBytes: 3_000_000_000,
      createdAt: row.createdAt,
      lastUsedAt: later,
    });
    await cache.delete(row.id);
    await cache.delete(row.id);
    expect(await cache.findByIdentity(snapshot(repository, runId, "evict me"))).toBeNull();
  });

  it("deletes a row by id only while it still points at the given blob key", async () => {
    const { runId, repository } = await seedRun();
    const cache = new PrismaDependencyCacheStore(db);
    await cache.insert(snapshot(repository, runId, "guarded"));
    const row = (await cache.findByIdentity(snapshot(repository, runId, "guarded")))!;
    expect(await cache.deleteIfBlob(row.id, `${row.blobKey}-other`)).toBe(false);
    expect(await cache.findByIdentity(row)).not.toBeNull();
    expect(await cache.deleteIfBlob(row.id, row.blobKey)).toBe(true);
    expect(await cache.deleteIfBlob(row.id, row.blobKey)).toBe(false);
    expect(await cache.findByIdentity(row)).toBeNull();
  });

  it("lets one eviction pass hold the lock at a time", async () => {
    const cache = new PrismaDependencyCacheStore(db);
    const otherClient = createPrismaClient();
    const other = new PrismaDependencyCacheStore(otherClient);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const first = cache.withEvictionLock(async () => {
      entered();
      await held;
    });
    await inside;
    let ran = false;
    expect(await other.withEvictionLock(async () => void (ran = true))).toBe(false);
    expect(ran).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await other.withEvictionLock(async () => void (ran = true))).toBe(true);
    expect(ran).toBe(true);
    await otherClient.$disconnect();
  });

  it("serves the whole flow over HTTP against Postgres: plan hash, upload, lookup, download, seal", async () => {
    const token = `rrg_${randomUUID()}`;
    const tokenHash = createHash("sha256").update(token).digest("base64url");
    const suffix = randomUUID();
    const { runId } = await seedRun(suffix);
    await db.codingProxySession.update({ where: { runId }, data: { registryTokenHash: tokenHash } });
    const registry = new PrismaRegistryStore(db);
    const lock = hex("the lockfile");
    await registry.recordDependencyCacheLockHash(runId, lock, 8);
    const dir = await mkdtemp(join(tmpdir(), "dep-cache-db-"));
    const server = await startCodingProxyServer(
      new CodingProxy({ ledger: new MemoryProxyLedger(), credentials: { resolve: async () => "UNUSED" } }),
      {
        host: "127.0.0.1",
        port: 0,
        dependencyCache: new DependencyCacheService({
          registry,
          store: new PrismaDependencyCacheStore(db),
          blobs: new LocalBlobStore(dir),
          maxSnapshotBytes: 1024,
          uploadMs: 60_000,
        }),
      },
    );
    try {
      const base = `http://127.0.0.1:${server.port}/cache/npm`;
      const headers = { authorization: `Bearer ${token}` };
      const bytes = new TextEncoder().encode("archive");
      expect((await fetch(`${base}/lookup?lock=${hex("unplanned")}`, { headers })).status).toBe(409);
      const put = await fetch(`${base}/blob?lock=${lock}`, { method: "PUT", headers, body: bytes });
      expect([put.status, await put.json()]).toEqual([201, { stored: true, sha256: hex("archive"), sizeBytes: 7 }]);
      const lookup = (await (await fetch(`${base}/lookup?lock=${lock}`, { headers })).json()) as {
        key: string;
        hit: boolean;
      };
      expect(lookup.hit).toBe(true);
      const download = await fetch(`${base}/blob/${lookup.key}?lock=${lock}`, { headers });
      expect(download.headers.get("x-wardby-sha256")).toBe(hex("archive"));
      expect(await download.text()).toBe("archive");
      expect((await fetch(`${base}/seal`, { method: "POST", headers })).status).toBe(200);
      expect((await fetch(`${base}/lookup?lock=${lock}`, { headers })).status).toBe(409);
      const row = await db.dependencySnapshot.findFirst({ where: { createdByRunId: runId } });
      expect(row).toMatchObject({ sha256: hex("archive"), sizeBytes: 7n, workerImage: "worker:1" });
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
