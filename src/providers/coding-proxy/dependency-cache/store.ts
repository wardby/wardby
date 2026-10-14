import { randomUUID } from "node:crypto";
import type { DependencyCacheSessionState } from "../registry/store.js";

/**
 * The value every snapshot row stores in its `policyHash` column, and the only
 * value lookups match. The column and its unique index predate dropping the
 * agent's package policy from the key (see key.ts for why), so they stay
 * unchanged; rows written before carry a real policy hash, never match again,
 * and age out through eviction.
 */
export const POLICY_ANY = "any";

/** The parts every snapshot of one project shares, whatever its lockfile. */
export interface SnapshotScope {
  ecosystem: string;
  repository: string;
  projectPath: string;
  workerImage: string;
}

export interface SnapshotIdentity extends SnapshotScope {
  lockHash: string;
}

export interface NewSnapshot extends SnapshotIdentity {
  blobKey: string;
  sha256: string;
  sizeBytes: number;
  archiveScanVersion: number | null;
  archiveEntries: number | null;
  unpackedBytes: number | null;
  createdByRunId: string;
}

export interface SnapshotRow extends SnapshotIdentity {
  id: string;
  blobKey: string;
  sha256: string;
  sizeBytes: number;
  archiveScanVersion: number | null;
  archiveEntries: number | null;
  unpackedBytes: number | null;
  createdAt: Date;
  lastUsedAt: Date;
  createdByRunId: string | null;
}

/** What eviction needs of every snapshot. */
export type EvictionRow = Pick<SnapshotRow, "id" | "repository" | "blobKey" | "sizeBytes" | "createdAt" | "lastUsedAt">;

/** DependencySnapshot rows and the session fields the cache reads (Postgres in production). */
export interface DependencyCacheStore {
  session(runId: string): Promise<DependencyCacheSessionState | null>;
  /** Sets the session's sealedAt unless it is already set. */
  seal(runId: string, now: Date): Promise<void>;
  /** Like `seal`, but only for a run whose agent has the cache on (a model request's seal, ModelRequestSeal). */
  sealForModelRequest(runId: string, now: Date): Promise<void>;
  findByIdentity(identity: SnapshotIdentity): Promise<SnapshotRow | null>;
  /** The most recent snapshot in the scope whose lockHash differs (ties broken by id), or null. */
  findNearest(scope: SnapshotScope, excludeLockHash: string): Promise<SnapshotRow | null>;
  /** Whether the run already created a snapshot for this project. */
  hasUploaded(runId: string, ecosystem: string, projectPath: string): Promise<boolean>;
  /** "exists" when a snapshot with the same identity (or blob key) is already stored. */
  insert(snapshot: NewSnapshot): Promise<"inserted" | "exists">;
  touch(id: string, now: Date): Promise<void>;
  delete(id: string): Promise<void>;
  /** Deletes the row only while it still points at `blobKey` (a re-upload may have replaced it); true when deleted. */
  deleteIfBlob(id: string, blobKey: string): Promise<boolean>;
  listForEviction(): Promise<EvictionRow[]>;
  /** Runs `work` while holding the cluster-wide eviction lock; returns false (without running it) when another holder has it. */
  withEvictionLock(work: () => Promise<void>): Promise<boolean>;
}

const sameScope = (row: SnapshotScope, scope: SnapshotScope) =>
  row.ecosystem === scope.ecosystem &&
  row.repository === scope.repository &&
  row.projectPath === scope.projectPath &&
  row.workerImage === scope.workerImage;

/** In-memory adapter for tests. `sessions` may be shared with a MemoryRegistryStore's `cacheSessions`. */
export class MemoryDependencyCacheStore implements DependencyCacheStore {
  readonly rows: SnapshotRow[] = [];
  private evicting = false;

  /** Runs whose agent has the cache off (sealForModelRequest leaves them alone). */
  readonly cacheOff = new Set<string>();

  constructor(readonly sessions = new Map<string, DependencyCacheSessionState>()) {}

  async session(runId: string): Promise<DependencyCacheSessionState | null> {
    const session = this.sessions.get(runId);
    return session ? { ...session, lockHashes: [...session.lockHashes] } : null;
  }

  async seal(runId: string, now: Date): Promise<void> {
    const session = this.sessions.get(runId);
    if (session && !session.sealedAt) session.sealedAt = now;
  }

  async sealForModelRequest(runId: string, now: Date): Promise<void> {
    if (!this.cacheOff.has(runId)) await this.seal(runId, now);
  }

  async findByIdentity(identity: SnapshotIdentity): Promise<SnapshotRow | null> {
    return this.rows.find((row) => sameScope(row, identity) && row.lockHash === identity.lockHash) ?? null;
  }

  async findNearest(scope: SnapshotScope, excludeLockHash: string): Promise<SnapshotRow | null> {
    const candidates = this.rows
      .filter((row) => sameScope(row, scope) && row.lockHash !== excludeLockHash)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return candidates[0] ?? null;
  }

  async hasUploaded(runId: string, ecosystem: string, projectPath: string): Promise<boolean> {
    return this.rows.some(
      (row) => row.createdByRunId === runId && row.ecosystem === ecosystem && row.projectPath === projectPath,
    );
  }

  async insert(snapshot: NewSnapshot): Promise<"inserted" | "exists"> {
    if ((await this.findByIdentity(snapshot)) || this.rows.some((row) => row.blobKey === snapshot.blobKey))
      return "exists";
    const now = new Date();
    this.rows.push({ ...snapshot, id: `c${randomUUID().replaceAll("-", "")}`, createdAt: now, lastUsedAt: now });
    return "inserted";
  }

  async touch(id: string, now: Date): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) row.lastUsedAt = now;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }

  async deleteIfBlob(id: string, blobKey: string): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.id === id && row.blobKey === blobKey);
    if (index < 0) return false;
    this.rows.splice(index, 1);
    return true;
  }

  async listForEviction(): Promise<EvictionRow[]> {
    return this.rows.map(({ id, repository, blobKey, sizeBytes, createdAt, lastUsedAt }) => ({
      id,
      repository,
      blobKey,
      sizeBytes,
      createdAt,
      lastUsedAt,
    }));
  }

  async withEvictionLock(work: () => Promise<void>): Promise<boolean> {
    if (this.evicting) return false;
    this.evicting = true;
    try {
      await work();
      return true;
    } finally {
      this.evicting = false;
    }
  }
}
