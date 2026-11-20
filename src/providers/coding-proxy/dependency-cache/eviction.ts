/**
 * Dependency cache eviction: a periodic pass inside the proxy, coordinated
 * across replicas by a Postgres advisory lock (the store's
 * withEvictionLock). It removes snapshots past the maximum age (by creation,
 * so every snapshot is rebuilt at least that often), then the least recently
 * used beyond each repository's cap, then beyond the total cap. A blob is
 * deleted before its row, so a failed blob delete leaves the row for the next
 * pass to retry rather than an orphaned blob.
 *
 * The same pass reclaims uploads whose proxy died: an upload's claim row
 * outliving the upload window means nothing is still writing its blob, so the
 * blob (unless a snapshot row names it) and then the claim are deleted.
 */
import { logger } from "../../../core/logger.js";
import type { BlobStore } from "../../storage/types.js";
import type { DependencyCacheStore, EvictionRow } from "./store.js";

const evictionLog = logger.child({ module: "dependency-cache" });

/** How often the proxy runs an eviction pass. */
export const DEFAULT_EVICTION_INTERVAL_MS = 60 * 60_000;

/** Slack added to the upload window before a claim counts as abandoned (an upload ends, then records its row). */
export const UPLOAD_CLAIM_GRACE_MS = 5 * 60_000;

export interface EvictionLimits {
  maxAgeMs: number;
  repoCapBytes: number;
  totalCapBytes: number;
}

const leastRecentlyUsed = (a: EvictionRow, b: EvictionRow) =>
  a.lastUsedAt.getTime() - b.lastUsedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The snapshots to evict, in the order to evict them. */
export function selectEvictions(rows: readonly EvictionRow[], limits: EvictionLimits, now: Date): EvictionRow[] {
  const cutoff = now.getTime() - limits.maxAgeMs;
  const evicted: EvictionRow[] = rows
    .filter((row) => row.createdAt.getTime() <= cutoff)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || leastRecentlyUsed(a, b));
  let kept = rows.filter((row) => row.createdAt.getTime() > cutoff);

  const byRepository = new Map<string, EvictionRow[]>();
  for (const row of kept) byRepository.set(row.repository, [...(byRepository.get(row.repository) ?? []), row]);
  const overRepoCap = new Set<string>();
  for (const repoRows of byRepository.values()) {
    let total = repoRows.reduce((sum, row) => sum + row.sizeBytes, 0);
    for (const row of [...repoRows].sort(leastRecentlyUsed)) {
      if (total <= limits.repoCapBytes) break;
      evicted.push(row);
      overRepoCap.add(row.id);
      total -= row.sizeBytes;
    }
  }
  kept = kept.filter((row) => !overRepoCap.has(row.id));

  let total = kept.reduce((sum, row) => sum + row.sizeBytes, 0);
  for (const row of [...kept].sort(leastRecentlyUsed)) {
    if (total <= limits.totalCapBytes) break;
    evicted.push(row);
    total -= row.sizeBytes;
  }
  return evicted;
}

export interface EvictionOptions {
  store: DependencyCacheStore;
  blobs: Pick<BlobStore, "delete">;
  limits: EvictionLimits;
  /** How old an upload claim must be before its upload is presumed dead: the upload window plus UPLOAD_CLAIM_GRACE_MS. */
  uploadClaimMaxAgeMs: number;
  now?: () => Date;
}

/** One eviction pass; `ran` is false when another holder had the lock. `reclaimed` counts abandoned uploads removed. */
export async function runEviction(
  options: EvictionOptions,
): Promise<{ ran: boolean; deleted: number; failed: number; reclaimed: number }> {
  const result = { ran: false, deleted: 0, failed: 0, reclaimed: 0 };
  result.ran = await options.store.withEvictionLock(async () => {
    const now = (options.now ?? (() => new Date()))();
    const rows = await options.store.listForEviction();
    for (const row of selectEvictions(rows, options.limits, now)) {
      try {
        await options.blobs.delete(row.blobKey);
      } catch (error) {
        result.failed += 1;
        evictionLog.warn(
          { event: "dependency_cache.evict_blob_failed", snapshotId: row.id, err: error },
          "dependency cache: a snapshot's blob could not be deleted; the next pass retries",
        );
        continue;
      }
      await options.store.delete(row.id);
      result.deleted += 1;
    }
    const swept = await sweepStaleUploads(options, now);
    result.reclaimed = swept.reclaimed;
    result.failed += swept.failed;
  });
  return result;
}

/**
 * Deletes the blob and claim of every upload claim older than the upload window. The blob goes first, so a
 * failed delete leaves the claim for the next pass. A blob a snapshot row names is kept (the upload committed
 * and only its claim release was lost); only the claim is removed.
 */
async function sweepStaleUploads(options: EvictionOptions, now: Date): Promise<{ reclaimed: number; failed: number }> {
  const result = { reclaimed: 0, failed: 0 };
  const cutoff = new Date(now.getTime() - options.uploadClaimMaxAgeMs);
  for (const claim of await options.store.listStaleUploads(cutoff)) {
    try {
      if (!(await options.store.hasSnapshotBlob(claim.blobKey))) await options.blobs.delete(claim.blobKey);
      await options.store.releaseUpload(claim.blobKey);
      result.reclaimed += 1;
    } catch (error) {
      result.failed += 1;
      evictionLog.warn(
        { event: "dependency_cache.reclaim_failed", claimId: claim.id, runId: claim.runId, err: error },
        "dependency cache: an abandoned upload could not be reclaimed; the next pass retries",
      );
    }
  }
  return result;
}

/** Runs an eviction pass every `intervalMs` (the first one interval after start). */
export function startEviction(options: EvictionOptions & { intervalMs?: number }): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runEviction(options)
      .then((result) => {
        if (result.deleted > 0 || result.failed > 0 || result.reclaimed > 0)
          evictionLog.info(
            {
              event: "dependency_cache.evicted",
              deleted: result.deleted,
              failed: result.failed,
              reclaimed: result.reclaimed,
            },
            "dependency cache eviction pass",
          );
      })
      .catch((error: unknown) => {
        evictionLog.warn({ event: "dependency_cache.evict_failed", err: error }, "dependency cache eviction failed");
      })
      .finally(() => {
        running = false;
      });
  }, options.intervalMs ?? DEFAULT_EVICTION_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
