import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { LocalBlobStore } from "../../storage/local.js";
import type { BlobStore } from "../../storage/types.js";
import { runEviction, selectEvictions, startEviction } from "./eviction.js";
import { MemoryDependencyCacheStore, type EvictionRow } from "./store.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-12T00:00:00Z");
const MB = 1024 * 1024;

function row(id: string, repository: string, sizeMb: number, createdDaysAgo: number, usedDaysAgo: number): EvictionRow {
  return {
    id,
    repository,
    blobKey: `dependency-cache/npm/${id}.tgz`,
    sizeBytes: sizeMb * MB,
    createdAt: new Date(NOW.getTime() - createdDaysAgo * DAY),
    lastUsedAt: new Date(NOW.getTime() - usedDaysAgo * DAY),
  };
}

const limits = { maxAgeMs: 14 * DAY, repoCapBytes: 10 * MB, totalCapBytes: 25 * MB };
const uploadClaimMaxAgeMs = 20 * 60_000;

describe("dependency cache eviction order", () => {
  it("drops expired snapshots, then the least recently used beyond each repo's cap, then beyond the total cap", () => {
    const rows = [
      row("old", "a", 1, 15, 0), // past max age (by creation), however recently used
      row("a1", "a", 4, 5, 3), // repo a: 4+4+4 = 12 MB > 10 MB: a1 (LRU) goes
      row("a2", "a", 4, 5, 1),
      row("a3", "a", 4, 5, 2),
      row("b1", "b", 5, 5, 4), // repo b: exactly at its cap, kept
      row("b2", "b", 5, 5, 0.5),
      row("c1", "c", 7, 5, 5),
      row("d1", "d", 2, 5, 6), // after the repo pass 8+10+7+2 = 27 MB > 25: d1 is the least recently used left
    ];
    expect(selectEvictions(rows, limits, NOW).map((r) => r.id)).toEqual(["old", "a1", "d1"]);
  });

  it("selects nothing within every limit", () => {
    expect(selectEvictions([row("x", "a", 1, 1, 1)], limits, NOW)).toEqual([]);
  });

  it("deletes the blob before the row, and keeps a row whose blob delete failed for the next pass", async () => {
    const store = new MemoryDependencyCacheStore();
    for (const [id, days] of [
      ["s1", 20],
      ["s2", 20],
      ["s3", 1],
    ] as const) {
      store.rows.push({
        ...row(id, "a", 1, days, days),
        ecosystem: "npm",
        projectPath: ".",
        lockHash: id,
        workerImage: "img",
        sha256: "x",
        archiveScanVersion: null,
        archiveEntries: null,
        unpackedBytes: null,
        createdByRunId: null,
      });
    }
    const deleted: string[] = [];
    const blobs = {
      delete: vi.fn(async (key: string) => {
        if (key.includes("s1")) throw new Error("transient");
        deleted.push(key);
      }),
    } as unknown as BlobStore;
    const result = await runEviction({ store, blobs, limits, uploadClaimMaxAgeMs, now: () => NOW });
    expect(result).toEqual({ ran: true, deleted: 1, failed: 1, reclaimed: 0 });
    expect(deleted).toEqual(["dependency-cache/npm/s2.tgz"]);
    expect(store.rows.map((r) => r.id).sort()).toEqual(["s1", "s3"]);
  });

  it("deletes exactly the evicted row's own blob object, nothing else under the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dep-evict-"));
    try {
      const blobs = new LocalBlobStore(dir);
      const store = new MemoryDependencyCacheStore();
      const prefix = "dependency-cache/npm/aa/bb/lock-img-pol";
      const base = {
        ecosystem: "npm",
        repository: "a",
        projectPath: ".",
        lockHash: "lock",
        workerImage: "img",
        sha256: "x",
        archiveScanVersion: null,
        archiveEntries: null,
        unpackedBytes: null,
        createdByRunId: null,
      };
      store.rows.push(
        { ...row("expired", "a", 1, 20, 20), ...base, blobKey: `${prefix}-11111111.tgz` },
        { ...row("fresh", "b", 1, 1, 1), ...base, repository: "b", blobKey: `${prefix}-22222222.tgz` },
      );
      // An object under the same key prefix that no evicted row names (e.g. an upload in flight).
      for (const key of [`${prefix}-11111111.tgz`, `${prefix}-22222222.tgz`, `${prefix}-33333333.tgz`])
        await blobs.putStream(key, Readable.from([Buffer.from(key)]));
      expect(await runEviction({ store, blobs, limits, uploadClaimMaxAgeMs, now: () => NOW })).toEqual({
        ran: true,
        deleted: 1,
        failed: 0,
        reclaimed: 0,
      });
      expect(await blobs.head(`${prefix}-11111111.tgz`)).toBeNull();
      expect(await blobs.head(`${prefix}-22222222.tgz`)).not.toBeNull();
      expect(await blobs.head(`${prefix}-33333333.tgz`)).not.toBeNull();
      expect(store.rows.map((r) => r.id)).toEqual(["fresh"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips a pass while another holds the eviction lock", async () => {
    const store = new MemoryDependencyCacheStore();
    const blobs = { delete: vi.fn() } as unknown as BlobStore;
    let inner: unknown;
    await store.withEvictionLock(async () => {
      inner = await runEviction({ store, blobs, limits, uploadClaimMaxAgeMs, now: () => NOW });
    });
    expect(inner).toEqual({ ran: false, deleted: 0, failed: 0, reclaimed: 0 });
  });

  it("runs on an interval until stopped, and survives a failing pass", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryDependencyCacheStore();
      const list = vi.spyOn(store, "listForEviction").mockRejectedValueOnce(new Error("db down"));
      const handle = startEviction({
        store,
        blobs: { delete: vi.fn() },
        limits,
        uploadClaimMaxAgeMs,
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(list).toHaveBeenCalledTimes(2);
      handle.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dependency cache abandoned uploads", () => {
  const claim = (blobKey: string, ageMs: number, runId = "run-1") => ({
    ecosystem: "npm",
    repository: "a",
    projectPath: ".",
    lockHash: blobKey,
    workerImage: "img",
    blobKey,
    runId,
    ownerId: "proxy-1",
    ageMs,
  });

  /** Puts claims straight in the store, aged as given (claimUpload stamps them with the real clock). */
  function seed(store: MemoryDependencyCacheStore, ...claims: ReturnType<typeof claim>[]) {
    for (const { ageMs, ...held } of claims)
      store.claims.push({ ...held, id: `claim-${held.blobKey}`, createdAt: new Date(NOW.getTime() - ageMs) });
  }

  it("deletes the blob and claim of an upload older than the upload window, and leaves a live one alone", async () => {
    const store = new MemoryDependencyCacheStore();
    seed(store, claim("dead", uploadClaimMaxAgeMs + 1), claim("live", uploadClaimMaxAgeMs - 1_000, "run-2"));
    const deleted: string[] = [];
    const blobs = { delete: vi.fn(async (key: string) => void deleted.push(key)) } as unknown as BlobStore;
    expect(await runEviction({ store, blobs, limits, uploadClaimMaxAgeMs, now: () => NOW })).toEqual({
      ran: true,
      deleted: 0,
      failed: 0,
      reclaimed: 1,
    });
    expect(deleted).toEqual(["dead"]);
    expect(store.claims.map((held) => held.blobKey)).toEqual(["live"]);
  });

  it("removes the blob an abandoned upload wrote, not an unrelated object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dep-reclaim-"));
    try {
      const blobs = new LocalBlobStore(dir);
      const store = new MemoryDependencyCacheStore();
      for (const key of ["dependency-cache/npm/dead.tgz", "dependency-cache/npm/other.tgz"])
        await blobs.putStream(key, Readable.from([Buffer.from(key)]));
      seed(store, claim("dependency-cache/npm/dead.tgz", uploadClaimMaxAgeMs + 1));
      await runEviction({ store, blobs, limits, uploadClaimMaxAgeMs, now: () => NOW });
      expect(await blobs.head("dependency-cache/npm/dead.tgz")).toBeNull();
      expect(await blobs.head("dependency-cache/npm/other.tgz")).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a claim whose blob delete failed, so the next pass retries", async () => {
    const store = new MemoryDependencyCacheStore();
    seed(store, claim("dead", uploadClaimMaxAgeMs + 1));
    const blobs = {
      delete: vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue(undefined),
    } as unknown as BlobStore;
    expect(await runEviction({ store, blobs, limits, uploadClaimMaxAgeMs, now: () => NOW })).toMatchObject({
      failed: 1,
      reclaimed: 0,
    });
    expect(store.claims).toHaveLength(1);
    expect(await runEviction({ store, blobs, limits, uploadClaimMaxAgeMs, now: () => NOW })).toMatchObject({
      failed: 0,
      reclaimed: 1,
    });
    expect(store.claims).toHaveLength(0);
  });

  it("never deletes a blob a snapshot row names (the upload committed and only its claim release was lost)", async () => {
    const store = new MemoryDependencyCacheStore();
    store.rows.push({
      ...row("kept", "a", 1, 1, 1),
      ecosystem: "npm",
      projectPath: ".",
      lockHash: "kept",
      workerImage: "img",
      blobKey: "committed",
      sha256: "x",
      archiveScanVersion: null,
      archiveEntries: null,
      unpackedBytes: null,
      createdByRunId: null,
    });
    seed(store, claim("committed", uploadClaimMaxAgeMs + 1));
    const blobs = { delete: vi.fn() } as unknown as BlobStore;
    expect(await runEviction({ store, blobs, limits, uploadClaimMaxAgeMs, now: () => NOW })).toMatchObject({
      reclaimed: 1,
    });
    expect(blobs.delete).not.toHaveBeenCalled();
    expect(store.claims).toHaveLength(0);
    expect(store.rows).toHaveLength(1);
  });
});
