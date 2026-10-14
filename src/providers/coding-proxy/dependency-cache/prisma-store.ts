import { Prisma, type PrismaClient } from "#prisma";
import type { DependencyCacheSessionState } from "../registry/store.js";
import {
  POLICY_ANY,
  type DependencyCacheStore,
  type EvictionRow,
  type NewSnapshot,
  type SnapshotIdentity,
  type SnapshotRow,
  type SnapshotScope,
} from "./store.js";

/** How long one eviction pass may hold the lock (its transaction) before Postgres releases it. */
const EVICTION_LOCK_MS = 15 * 60_000;

type Row = Omit<SnapshotRow, "sizeBytes" | "unpackedBytes"> & {
  sizeBytes: bigint;
  unpackedBytes: bigint | null;
  policyHash: string;
};

/**
 * Only the scope's own fields (callers may pass a wider object, such as a
 * derived key), plus the fixed POLICY_ANY every row is written and matched with.
 */
const scopeOf = ({ ecosystem, repository, projectPath, workerImage }: SnapshotScope) => ({
  ecosystem,
  repository,
  projectPath,
  workerImage,
  policyHash: POLICY_ANY,
});

const toSnapshot = ({ policyHash: _policyHash, ...row }: Row): SnapshotRow => ({
  ...row,
  sizeBytes: Number(row.sizeBytes),
  unpackedBytes: row.unpackedBytes === null ? null : Number(row.unpackedBytes),
});

export class PrismaDependencyCacheStore implements DependencyCacheStore {
  constructor(private readonly db: PrismaClient) {}

  async session(runId: string): Promise<DependencyCacheSessionState | null> {
    const session = await this.db.codingProxySession.findUnique({
      where: { runId },
      select: { dependencyCacheLockHashes: true, dependencyCacheSealedAt: true, createdAt: true },
    });
    return session
      ? {
          lockHashes: session.dependencyCacheLockHashes,
          sealedAt: session.dependencyCacheSealedAt,
          createdAt: session.createdAt,
        }
      : null;
  }

  async seal(runId: string, now: Date): Promise<void> {
    await this.db.codingProxySession.updateMany({
      where: { runId, dependencyCacheSealedAt: null },
      data: { dependencyCacheSealedAt: now },
    });
  }

  async sealForModelRequest(runId: string, now: Date): Promise<void> {
    await this.db.codingProxySession.updateMany({
      where: { runId, dependencyCacheSealedAt: null, run: { dependencyCache: true } },
      data: { dependencyCacheSealedAt: now },
    });
  }

  async findByIdentity(identity: SnapshotIdentity): Promise<SnapshotRow | null> {
    const row = await this.db.dependencySnapshot.findUnique({
      where: {
        ecosystem_repository_projectPath_lockHash_workerImage_policyHash: {
          ...scopeOf(identity),
          lockHash: identity.lockHash,
        },
      },
    });
    return row ? toSnapshot(row) : null;
  }

  async findNearest(scope: SnapshotScope, excludeLockHash: string): Promise<SnapshotRow | null> {
    const row = await this.db.dependencySnapshot.findFirst({
      where: { ...scopeOf(scope), lockHash: { not: excludeLockHash } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return row ? toSnapshot(row) : null;
  }

  async hasUploaded(runId: string, ecosystem: string, projectPath: string): Promise<boolean> {
    const row = await this.db.dependencySnapshot.findFirst({
      where: { createdByRunId: runId, projectPath, ecosystem },
      select: { id: true },
    });
    return row !== null;
  }

  async insert(snapshot: NewSnapshot): Promise<"inserted" | "exists"> {
    try {
      await this.db.dependencySnapshot.create({
        data: {
          ...scopeOf(snapshot),
          lockHash: snapshot.lockHash,
          blobKey: snapshot.blobKey,
          sha256: snapshot.sha256,
          sizeBytes: BigInt(snapshot.sizeBytes),
          archiveScanVersion: snapshot.archiveScanVersion,
          archiveEntries: snapshot.archiveEntries,
          unpackedBytes: snapshot.unpackedBytes === null ? null : BigInt(snapshot.unpackedBytes),
          createdByRunId: snapshot.createdByRunId,
        },
      });
      return "inserted";
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "exists";
      throw error;
    }
  }

  async touch(id: string, now: Date): Promise<void> {
    await this.db.dependencySnapshot.updateMany({ where: { id }, data: { lastUsedAt: now } });
  }

  async delete(id: string): Promise<void> {
    await this.db.dependencySnapshot.deleteMany({ where: { id } });
  }

  async deleteIfBlob(id: string, blobKey: string): Promise<boolean> {
    const { count } = await this.db.dependencySnapshot.deleteMany({ where: { id, blobKey } });
    return count > 0;
  }

  async listForEviction(): Promise<EvictionRow[]> {
    const rows = await this.db.dependencySnapshot.findMany({
      select: { id: true, repository: true, blobKey: true, sizeBytes: true, createdAt: true, lastUsedAt: true },
    });
    return rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));
  }

  /**
   * A transaction-scoped advisory lock: Postgres releases it when the
   * transaction ends, so a crashed proxy never leaves it held. The work runs
   * on the ordinary client (each delete commits at once); the transaction
   * only holds the lock.
   */
  async withEvictionLock(work: () => Promise<void>): Promise<boolean> {
    return this.db.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext('wardby.dependency-cache-eviction')) AS locked`;
        if (!row?.locked) return false;
        await work();
        return true;
      },
      { maxWait: 10_000, timeout: EVICTION_LOCK_MS },
    );
  }
}
