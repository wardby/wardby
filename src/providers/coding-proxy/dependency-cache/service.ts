/**
 * The coding proxy's dependency cache: `/cache/npm/*`, authenticated by the
 * run's registry-only token.
 *
 * Trust rules (the whole point of this file):
 * - Every key is derived here, from the run's records and a lockfile hash the
 *   proxy computed while approving a plan for this session. A worker names
 *   only its project folder, which is validated, and which lockfile (one of
 *   the session's approved hashes) it is asking about.
 * - Only trusted wardby code runs before the run's seal; the agent runs after
 *   it with the same token. The worker seals before it starts the agent, and
 *   the proxy seals on the run's first model request whatever the worker did
 *   (ModelRequestSeal). After the seal every route except the (idempotent)
 *   seal answers 409 `sealed`, and an upload still streaming when the seal
 *   lands is discarded.
 * - A run uploads at most once per project, only within its upload window,
 *   and only for its derived key. Each upload writes its own blob object
 *   (a unique key), so no upload can replace a committed snapshot's bytes;
 *   an upload that does not end in its own row deletes its own object.
 * - The sha256 is computed while the upload streams and stored in Postgres;
 *   downloads carry it so the worker verifies before extracting.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { pipeline, Transform, type Readable } from "node:stream";
import { logger } from "../../../core/logger.js";
import { BlobStoreError, type BlobStore } from "../../storage/types.js";
import { capabilityHash } from "../proxy.js";
import type { RegistryRunContext, RegistryStore } from "../registry/store.js";
import {
  DEPENDENCY_CACHE_ECOSYSTEM,
  deriveSnapshotKey,
  isLockHash,
  newBlobKey,
  parseProjectPath,
  type SnapshotKey,
} from "./key.js";
import type { DependencyCacheStore, SnapshotRow } from "./store.js";

const cacheLog = logger.child({ module: "dependency-cache" });
const ARCHIVE_SCAN_VERSION = 1;
const MAX_ARCHIVE_ENTRIES = 1_000_000;

interface VerifiedArchive {
  archiveScanVersion: number;
  archiveEntries: number;
  unpackedBytes: number;
}

/** Uploads streaming at once across every run. */
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
const SNAPSHOT_ID = /^[a-z0-9]{1,64}$/;

type Route = "lookup" | "upload" | "download" | "seal";

/** Matches a `/cache/...` path; a number is the refusal's status code. */
function matchRoute(method: string | undefined, pathname: string): { route: Route; id?: string } | 404 | 405 {
  const prefix = `/cache/${DEPENDENCY_CACHE_ECOSYSTEM}/`;
  if (!pathname.startsWith(prefix)) return 404;
  const rest = pathname.slice(prefix.length);
  const expect = (wanted: string, route: Route, id?: string) => (method === wanted ? { route, id } : 405);
  if (rest === "lookup") return expect("GET", "lookup");
  if (rest === "seal") return expect("POST", "seal");
  if (rest === "blob") return expect("PUT", "upload");
  if (rest.startsWith("blob/")) {
    const id = rest.slice("blob/".length);
    return SNAPSHOT_ID.test(id) ? expect("GET", "download", id) : 404;
  }
  return 404;
}

class CacheRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function send(response: ServerResponse, status: number, body: unknown, close = false): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(close ? { connection: "close" } : {}),
  });
  response.end(JSON.stringify(body));
}

/**
 * The archive scan the worker ran before uploading, recorded with the
 * snapshot. Protocol: an upload carries `x-wardby-archive-scan-version`,
 * `x-wardby-archive-entries` and `x-wardby-archive-unpacked-bytes`, all three
 * or none (a partial or malformed set is refused). Only an upload accepted
 * before the run's seal stores them, so they come from trusted pre-agent
 * worker code, never from the agent. A lookup returns them as `manifest` (and
 * `nearest.manifest`) with the sha256 this proxy computed and recorded for the
 * row, so a worker trusts them only for bytes that verify against that digest.
 * Optional so workers deployed before validation metadata remain compatible.
 */
function verifiedArchiveHeaders(headers: IncomingMessage["headers"]): VerifiedArchive | null {
  const version = headers["x-wardby-archive-scan-version"];
  const entries = headers["x-wardby-archive-entries"];
  const unpackedBytes = headers["x-wardby-archive-unpacked-bytes"];
  if (version === undefined && entries === undefined && unpackedBytes === undefined) return null;
  if (typeof version !== "string" || typeof entries !== "string" || typeof unpackedBytes !== "string")
    throw new CacheRefusal(400, "bad_request");
  const parsedVersion = Number(version);
  const parsedEntries = Number(entries);
  const parsedUnpackedBytes = Number(unpackedBytes);
  if (
    parsedVersion !== ARCHIVE_SCAN_VERSION ||
    !Number.isSafeInteger(parsedEntries) ||
    parsedEntries < 1 ||
    parsedEntries > MAX_ARCHIVE_ENTRIES ||
    !Number.isSafeInteger(parsedUnpackedBytes) ||
    parsedUnpackedBytes < 0
  )
    throw new CacheRefusal(400, "bad_request");
  return { archiveScanVersion: parsedVersion, archiveEntries: parsedEntries, unpackedBytes: parsedUnpackedBytes };
}

function lookupManifest(
  row: SnapshotRow,
): { scanVersion: 1; sha256: string; entries: number; unpackedBytes: number } | undefined {
  const { archiveScanVersion, archiveEntries, unpackedBytes } = row;
  if (
    archiveScanVersion !== ARCHIVE_SCAN_VERSION ||
    archiveEntries === null ||
    unpackedBytes === null ||
    !Number.isSafeInteger(archiveEntries) ||
    archiveEntries < 1 ||
    archiveEntries > MAX_ARCHIVE_ENTRIES ||
    !Number.isSafeInteger(unpackedBytes) ||
    unpackedBytes < 0
  )
    return undefined;
  return { scanVersion: ARCHIVE_SCAN_VERSION, sha256: row.sha256, entries: archiveEntries, unpackedBytes };
}

export interface DependencyCacheServiceOptions {
  registry: Pick<RegistryStore, "findRunByRegistryTokenHash">;
  store: DependencyCacheStore;
  blobs: BlobStore;
  maxSnapshotBytes: number;
  uploadMs: number;
  now?: () => Date;
  maxConcurrentUploads?: number;
}

export class DependencyCacheService {
  readonly uploadMs: number;
  private readonly now: () => Date;
  /** `runId\0projectPath` and key ids of uploads streaming right now (per replica). */
  private readonly uploading = new Set<string>();
  private activeUploads = 0;

  constructor(private readonly options: DependencyCacheServiceOptions) {
    this.uploadMs = options.uploadMs;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Answers one `/cache/...` request. `token` is the registry token the
   * request carried. `releaseBodyTimer` lifts the server's per-request body
   * timer; it is called only for an authenticated, eligible upload that holds
   * its upload slot (the upload window bounds it from then on).
   */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
    releaseBodyTimer: () => void = () => {},
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://proxy");
    const matched = matchRoute(request.method, url.pathname);
    const isUpload = typeof matched === "object" && matched.route === "upload";
    // Filled in once the token is known to belong to a run, for the refusal log.
    const known: { runId?: string } = {};
    try {
      if (matched === 404) throw new CacheRefusal(404, "not_found");
      if (matched === 405) throw new CacheRefusal(405, "method_not_allowed");
      await this.route(matched.route, matched.id, url.searchParams, token, request, response, releaseBodyTimer, known);
    } catch (error) {
      if (error instanceof CacheRefusal) {
        // One line per refusal: a fixed route name and code, and the run when the token named one
        // (never the token, the query or the URL).
        cacheLog.info(
          {
            event: "dependency_cache.refused",
            ...(known.runId ? { runId: known.runId } : {}),
            route: typeof matched === "object" ? matched.route : "unknown",
            status: error.status,
            code: error.code,
          },
          "dependency cache request refused",
        );
        // An upload refused before its body was read: close rather than read it.
        send(response, error.status, { error: error.code }, isUpload);
        return;
      }
      cacheLog.error({ event: "dependency_cache.failed", err: error }, "dependency cache request failed");
      if (!response.headersSent) send(response, 500, { error: "internal_error" }, isUpload);
      else if (!response.destroyed) response.destroy();
    }
  }

  private async route(
    route: Route,
    id: string | undefined,
    params: URLSearchParams,
    token: string,
    request: IncomingMessage,
    response: ServerResponse,
    releaseBodyTimer: () => void,
    known: { runId?: string },
  ): Promise<void> {
    const context = await this.options.registry.findRunByRegistryTokenHash(capabilityHash(token), this.now());
    if (!context) throw new CacheRefusal(401, "invalid_capability");
    known.runId = context.runId;
    // The feature is off for this run: indistinguishable from a proxy without it.
    if (!context.dependencyCache || !context.cacheImage) throw new CacheRefusal(404, "not_found");
    const session = await this.options.store.session(context.runId);
    if (!session) throw new CacheRefusal(401, "invalid_capability");
    if (route === "seal") {
      await this.options.store.seal(context.runId, this.now());
      send(response, 200, { sealed: true });
      return;
    }
    if (session.sealedAt) throw new CacheRefusal(409, "sealed");
    for (const name of new Set(params.keys()))
      if (params.getAll(name).length > 1) throw new CacheRefusal(400, "bad_request");
    const projectPath = parseProjectPath(params.get("project"));
    if (projectPath === null) throw new CacheRefusal(400, "invalid_project");
    const lockHash = params.get("lock") ?? "";
    if (!isLockHash(lockHash) || !session.lockHashes.includes(lockHash)) throw new CacheRefusal(409, "plan_required");
    const key = deriveSnapshotKey({
      repository: context.repository,
      projectPath,
      lockHash,
      workerImage: context.cacheImage,
    });
    if (route === "lookup") await this.lookup(key, session.createdAt, response);
    else if (route === "download") await this.download(context.runId, key, id ?? "", response);
    else await this.upload(context, session.createdAt, key, request, response, releaseBodyTimer);
  }

  /** When the run's upload window closes (epoch ms): the one deadline lookups report and uploads enforce. */
  private uploadDeadline(sessionCreatedAt: Date): number {
    return sessionCreatedAt.getTime() + this.uploadMs;
  }

  private async lookup(key: SnapshotKey, sessionCreatedAt: Date, response: ServerResponse): Promise<void> {
    const row = await this.options.store.findByIdentity(key);
    const nearest = row ? null : await this.options.store.findNearest(key, key.lockHash);
    const manifest = row ? lookupManifest(row) : undefined;
    const nearestManifest = nearest ? lookupManifest(nearest) : undefined;
    send(response, 200, {
      key: key.keyId,
      hit: row !== null,
      ...(manifest ? { manifest } : {}),
      ...(nearest ? { nearest: { id: nearest.id, ...(nearestManifest ? { manifest: nearestManifest } : {}) } } : {}),
      maxBytes: this.options.maxSnapshotBytes,
      uploadExpiresInMs: Math.max(0, Math.floor(this.uploadDeadline(sessionCreatedAt) - this.now().getTime())),
    });
  }

  /**
   * Serves the run's derived key (by its keyId) or the snapshot a lookup
   * offers as nearest for the same project and lockfile, recomputed now with
   * the same query: nothing is remembered between requests, and no other id
   * is ever served.
   */
  private async download(runId: string, key: SnapshotKey, id: string, response: ServerResponse): Promise<void> {
    let row: SnapshotRow | null = null;
    if (id === key.keyId) row = await this.options.store.findByIdentity(key);
    else {
      const nearest = await this.options.store.findNearest(key, key.lockHash);
      if (nearest?.id === id) row = nearest;
    }
    if (!row) throw new CacheRefusal(404, "not_found");
    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.options.blobs.getStream(row.blobKey);
    } catch (error) {
      if (!(error instanceof BlobStoreError && error.code === "not_found")) throw error;
      // A row without its blob would answer hits forever: drop it.
      await this.options.store.delete(row.id);
      cacheLog.info(
        { event: "dependency_cache.blob_missing", runId, snapshotId: row.id },
        "dependency cache snapshot had no blob and was removed",
      );
      throw new CacheRefusal(404, "not_found");
    }
    try {
      await this.options.store.touch(row.id, this.now());
    } catch (error) {
      cacheLog.warn({ event: "dependency_cache.touch_failed", err: error }, "dependency cache: lastUsedAt not updated");
    }
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": String(row.sizeBytes),
      "x-wardby-sha256": row.sha256,
      "cache-control": "no-store",
    });
    // Hash and count while streaming. The flush runs only once the blob was
    // read to its end (a client abort destroys the pipeline before it), so only
    // a complete read that disagrees with the row (or a blob longer than it)
    // condemns the snapshot. The response then fails at once (the pipeline
    // destroys it) instead of ending, or leaving the client waiting for the
    // rest of its content-length.
    const hash = createHash("sha256");
    let bytes = 0;
    const corrupt = () => {
      void this.dropCorrupt(runId, row, bytes);
      return new Error("snapshot_corrupt");
    };
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > row.sizeBytes) return callback(corrupt());
        hash.update(chunk);
        callback(null, chunk);
      },
      flush: (callback) => {
        if (bytes === row.sizeBytes && hash.digest("hex") === row.sha256) callback();
        else callback(corrupt());
      },
    });
    pipeline(stream as Readable, verify, response, (error) => {
      if (error && !response.destroyed) response.destroy();
    });
  }

  /** Removes a snapshot whose blob failed its row's checksum, so the key can be rebuilt. */
  private async dropCorrupt(runId: string, row: SnapshotRow, readBytes: number): Promise<void> {
    try {
      // Only while the row still names the blob that was streamed: a re-upload may have replaced it.
      if (!(await this.options.store.deleteIfBlob(row.id, row.blobKey))) return;
      await this.discard(row.blobKey);
      cacheLog.warn(
        {
          event: "snapshot_corrupt",
          runId,
          expectedBytes: row.sizeBytes,
          readBytes,
        },
        "dependency cache snapshot failed its checksum and was removed",
      );
    } catch (error) {
      cacheLog.warn(
        { event: "dependency_cache.corrupt_cleanup_failed", err: error },
        "dependency cache: cleanup failed",
      );
    }
  }

  private async upload(
    context: RegistryRunContext,
    sessionCreatedAt: Date,
    key: SnapshotKey,
    request: IncomingMessage,
    response: ServerResponse,
    releaseBodyTimer: () => void,
  ): Promise<void> {
    const deadline = this.uploadDeadline(sessionCreatedAt);
    if (this.now().getTime() >= deadline) throw new CacheRefusal(409, "upload_expired");
    const encoding = request.headers["content-encoding"];
    if (encoding && encoding !== "identity") throw new CacheRefusal(400, "bad_request");
    const length = request.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > this.options.maxSnapshotBytes))
      throw new CacheRefusal(413, "too_large");
    const verifiedArchive = verifiedArchiveHeaders(request.headers);
    const projectSlot = `${context.runId}\0${key.projectPath}`;
    if (this.uploading.has(projectSlot) || this.uploading.has(key.keyId))
      throw new CacheRefusal(409, "upload_in_progress");
    if (await this.options.store.hasUploaded(context.runId, key.ecosystem, key.projectPath))
      throw new CacheRefusal(409, "already_uploaded");
    if (await this.options.store.findByIdentity(key)) {
      send(response, 200, { stored: false, reason: "exists" }, true);
      return;
    }
    if (this.activeUploads >= (this.options.maxConcurrentUploads ?? DEFAULT_MAX_CONCURRENT_UPLOADS))
      throw new CacheRefusal(503, "busy");
    // Re-checked after the awaits above: the slot is taken synchronously.
    if (this.uploading.has(projectSlot) || this.uploading.has(key.keyId))
      throw new CacheRefusal(409, "upload_in_progress");
    this.uploading.add(projectSlot);
    this.uploading.add(key.keyId);
    this.activeUploads += 1;
    releaseBodyTimer();
    try {
      await this.storeUpload(context, deadline, key, request, response, verifiedArchive);
    } finally {
      this.uploading.delete(projectSlot);
      this.uploading.delete(key.keyId);
      this.activeUploads -= 1;
    }
  }

  private async storeUpload(
    context: RegistryRunContext,
    deadline: number,
    key: SnapshotKey,
    request: IncomingMessage,
    response: ServerResponse,
    verifiedArchive: VerifiedArchive | null,
  ): Promise<void> {
    const blobKey = newBlobKey(key);
    let expired = false;
    const timer = setTimeout(
      () => {
        expired = true;
        request.destroy();
      },
      Math.max(0, deadline - this.now().getTime()),
    );
    let stored: { sizeBytes: number; sha256: string };
    try {
      stored = await this.options.blobs.putStream(blobKey, request, {
        contentType: "application/gzip",
        maxBytes: this.options.maxSnapshotBytes,
      });
    } catch (error) {
      if (error instanceof BlobStoreError && error.code === "blob_too_large") throw new CacheRefusal(413, "too_large");
      if (expired) throw new CacheRefusal(409, "upload_expired");
      // The client went away mid-upload: nothing to answer.
      if (request.destroyed || response.destroyed) return;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    // Checked only now, after the last byte arrived: every byte of an
    // accepted upload was sent before the seal (so before the agent ran).
    const session = await this.options.store.session(context.runId);
    const refusal =
      !session || session.sealedAt ? "sealed" : this.now().getTime() >= deadline ? "upload_expired" : null;
    if (refusal) {
      await this.discard(blobKey);
      throw new CacheRefusal(409, refusal);
    }
    let outcome: "inserted" | "exists";
    try {
      outcome = await this.options.store.insert({
        ecosystem: key.ecosystem,
        repository: key.repository,
        projectPath: key.projectPath,
        lockHash: key.lockHash,
        workerImage: key.workerImage,
        blobKey,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        archiveScanVersion: verifiedArchive?.archiveScanVersion ?? null,
        archiveEntries: verifiedArchive?.archiveEntries ?? null,
        unpackedBytes: verifiedArchive?.unpackedBytes ?? null,
        createdByRunId: context.runId,
      });
    } catch (error) {
      await this.discard(blobKey);
      throw error;
    }
    if (outcome === "exists") {
      // Another upload of this key committed first; its object is untouched.
      await this.discard(blobKey);
      send(response, 200, { stored: false, reason: "exists" });
      return;
    }
    cacheLog.info(
      { event: "dependency_cache.stored", runId: context.runId, sizeBytes: stored.sizeBytes },
      "dependency cache snapshot stored",
    );
    send(response, 201, { stored: true, sha256: stored.sha256, sizeBytes: stored.sizeBytes });
  }

  /** Removes an upload's own blob object (unique to the upload, so no row refers to it). */
  private async discard(blobKey: string): Promise<void> {
    try {
      await this.options.blobs.delete(blobKey);
    } catch (error) {
      cacheLog.warn({ event: "dependency_cache.discard_failed", err: error }, "dependency cache: blob not removed");
    }
  }
}
