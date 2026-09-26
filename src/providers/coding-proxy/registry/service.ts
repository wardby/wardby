/**
 * RegistryService: the security core of the coding package registry. It
 * authenticates the registry-only token, enforces the per-run allowlist and
 * the dependency graph grown from it, filters versions by allowlisted
 * range, minimum release age and OSV advisories, streams downloads with
 * integrity verification and size/idle limits, and records every served or
 * refused fetch. Adapters (npm, PyPI, …) supply ecosystem-specific parsing
 * and protocol only; every safeguard lives here so a new adapter cannot
 * weaken one by omission.
 */
import { createHash } from "node:crypto";
import { matchRoot, parseAllowlist, resolvePolicy } from "../../../coding/registry/allowlist.js";
import {
  RegistryError,
  type AllowlistEntry,
  type DownloadRoute,
  type FileMetadataRoute,
  type FileRef,
  type PackageMetadata,
  type RegistryAdapter,
  type RegistryRoute,
  type UpstreamFetch,
} from "../../../coding/registry/types.js";
import { capabilityHash } from "../proxy.js";
import type { OsvAudit } from "./audit.js";
import { boundedMetadataFetch, DEFAULT_MAX_METADATA_BYTES, DEFAULT_METADATA_TIMEOUT_MS } from "./bounded-fetch.js";
import type { RegistryRunContext, RegistryStore } from "./store.js";

const DAY_MS = 86_400_000;
/** Bytes of a served file kept for `dependenciesFromFile`. A larger file is
 *  truncated here, the adapter cannot read its metadata from a truncated
 *  archive, and it yields no dependencies: this fails closed (nothing is
 *  allowed that the file did not prove). */
const DEPENDENCY_BUFFER_LIMIT = 64 * 1024 * 1024;
/** npm's own name-length limit; longer recorded names are truncated. */
const MAX_RECORDED_NAME = 214;

/** Discriminated result of one `reader.read()` call in `download`'s stream
 *  loop, folding a rejection (`ok: false`) into the same shape as a
 *  resolution so the pending-read race can be checked once, uniformly. */
type ReadOutcome = { ok: false } | { ok: true; done: true } | { ok: true; done: false; value: Uint8Array };

export interface RegistryLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  idleTimeoutMs: number;
  /** Refused RegistryFetch rows recorded per run (default 500). Further
   *  refusals still get their normal error, but no row. */
  maxRefusalRecords?: number;
}
export const DEFAULT_MAX_REFUSAL_RECORDS = 500;

/** Per-run in-process tallies, seeded from the store on first use and
 *  dropped once the run's registry token has expired. Like `inFlight`,
 *  they hold per replica (the proxy runs as one). */
interface RunTally {
  deadline: number;
  refused?: number;
  /** Served files and bytes, kept live as downloads complete, so a download
   *  that started before another finished still counts it (a one-off
   *  `usage()` snapshot would not). */
  served?: { files: number; bytes: number };
}
export type RegistryResponse =
  | { status: number; contentType: string; body: string }
  | { status: 200; contentType: string; stream: ReadableStream<Uint8Array> };
export interface RegistryRequest {
  method: string;
  ecosystem: string;
  subpath: string;
  token: string;
  signal: AbortSignal;
}

function contentTypeOf(route: DownloadRoute | FileMetadataRoute): string {
  return route.kind === "file-metadata" ? "text/plain" : "application/octet-stream";
}

export function errorResponse(error: RegistryError): RegistryResponse {
  return {
    status: error.status,
    contentType: "application/json",
    body: JSON.stringify({ error: `${error.code}: ${error.message}` }),
  };
}

export const DEFAULT_METADATA_CACHE_ENTRIES = 500;

export class RegistryService {
  /** Parsed metadata (adapters keep only the subset they render from, never
   *  the raw upstream document), least recently used first. Bounded to
   *  `metadataCacheEntries`; expired entries are dropped on access and on
   *  insert. */
  private readonly metadataCache = new Map<string, { expires: number; meta: PackageMetadata }>();
  /** Single-flight: concurrent misses for one package share one upstream fetch. */
  private readonly metadataLoads = new Map<string, Promise<PackageMetadata>>();
  private readonly now: () => Date;
  private readonly metadataTtlMs: number;
  private readonly metadataCacheEntries: number;
  private readonly metadataUpstream: UpstreamFetch;
  /** Per-run in-flight download usage: files and bytes reserved by downloads
   *  that are streaming right now but not yet recorded to the store. Without
   *  this, `usage()` (which only counts already-served rows) is read once
   *  per request, so concurrent downloads for the same run (e.g. npm's
   *  parallel installs) count toward neither the file nor the byte limit
   *  until each finishes, letting them overshoot both. This reservation is
   *  in-process only — it holds per replica of the registry proxy, not
   *  across replicas. */
  private readonly inFlight = new Map<string, { files: number; bytes: number }>();
  private readonly tallies = new Map<string, RunTally>();

  constructor(
    private readonly options: {
      adapters: ReadonlyMap<string, RegistryAdapter>;
      store: RegistryStore;
      audit: Pick<OsvAudit, "audit">;
      upstream: UpstreamFetch;
      proxyBase: string;
      limits: RegistryLimits;
      now?: () => Date;
      metadataTtlMs?: number;
      metadataCacheEntries?: number;
      /** Timeout for one metadata request, body included (default 30 s). */
      metadataTimeoutMs?: number;
      /** Largest metadata document read from upstream (default 64 MiB). */
      maxMetadataBytes?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.metadataTtlMs = options.metadataTtlMs ?? 300_000;
    this.metadataCacheEntries = options.metadataCacheEntries ?? DEFAULT_METADATA_CACHE_ENTRIES;
    this.metadataUpstream = boundedMetadataFetch(options.upstream, {
      timeoutMs: options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
      maxBytes: options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES,
    });
  }

  async handle(request: RegistryRequest): Promise<RegistryResponse> {
    try {
      return await this.dispatch(request);
    } catch (error) {
      if (error instanceof RegistryError) return errorResponse(error);
      return errorResponse(new RegistryError(502, "wardby_upstream_error", "the package registry request failed"));
    }
  }

  private async dispatch(request: RegistryRequest): Promise<RegistryResponse> {
    const adapter = this.options.adapters.get(request.ecosystem);
    if (!adapter) throw new RegistryError(404, "wardby_registry_unknown", `no registry named "${request.ecosystem}"`);
    const context = await this.options.store.findRunByRegistryTokenHash(capabilityHash(request.token), this.now());
    if (!context) throw new RegistryError(401, "invalid_capability", "the registry token is not valid for a live run");
    let route: RegistryRoute | null;
    try {
      route = adapter.route(request.method, request.subpath, new Headers());
    } catch (error) {
      // A malformed path (bad percent-encoding, an invalid package name) is
      // the client's error, recorded like any other refusal.
      await this.refuse(context, adapter, request.subpath.slice(0, MAX_RECORDED_NAME), "wardby_bad_request");
      throw error instanceof RegistryError
        ? error
        : new RegistryError(400, "wardby_bad_request", "malformed registry path");
    }
    if (!route) throw new RegistryError(404, "wardby_route_unknown", "unknown registry path");

    const name = adapter.normalizeName(route.name);
    const root = await this.authorize(adapter, context, name);
    let meta: PackageMetadata;
    try {
      meta = await this.metadata(adapter, name);
    } catch (error) {
      // An oversized document is a refusal of this package, not a transient
      // upstream failure, so it gets a row like every other refusal.
      if (error instanceof RegistryError && error.code === "wardby_metadata_too_large") {
        await this.refuse(context, adapter, name, "wardby_metadata_too_large");
      }
      throw error;
    }
    let keep: Set<string>;
    let keptFiles: Set<string>;
    try {
      ({ keep, keptFiles } = await this.keptVersions(adapter, context, meta, root));
    } catch (error) {
      // Every refusal gets a row, including one the run never chose: the
      // audit being unreachable (fail-closed) still stops this request.
      if (error instanceof RegistryError && error.code === "wardby_audit_unavailable") {
        await this.refuse(context, adapter, name, "wardby_audit_unavailable");
      }
      throw error;
    }

    if (route.kind === "metadata") {
      if (keep.size === 0) {
        await this.refuse(context, adapter, name, "wardby_version_filtered");
        throw new RegistryError(
          404,
          "wardby_version_filtered",
          `every matching version of "${name}" is outside the allowlisted range, newer than the release-age limit, or has a high-severity advisory`,
        );
      }
      const dependencies = [...keep].flatMap((version) => meta.versions.get(version)?.dependencies ?? []);
      await this.options.store.addAllowances(
        context.runId,
        adapter.id,
        dependencies.map((dependency) => adapter.normalizeName(dependency)),
      );
      const document = adapter.renderMetadata(meta, keep, keptFiles, `${this.options.proxyBase}${adapter.id}/`);
      return { status: 200, contentType: document.contentType, body: document.body };
    }

    const file =
      route.kind === "download"
        ? adapter.resolveDownload(route, meta)
        : (adapter.resolveFileMetadata?.(route, meta) ?? null);
    // The release age applies per file: a file newer than the cutoff is
    // refused exactly like a filtered version, even in a kept release.
    if (!file || !keep.has(file.version) || !keptFiles.has(file.filename)) {
      await this.refuse(context, adapter, name, "wardby_version_filtered", file ?? undefined);
      const versionSuffix = route.kind === "download" ? ` ${route.version}` : "";
      throw new RegistryError(404, "wardby_version_filtered", `"${name}"${versionSuffix} is not available to this run`);
    }
    if (!file.allowed) {
      await this.refuse(context, adapter, name, "wardby_file_not_allowed", file);
      throw new RegistryError(
        403,
        "wardby_file_not_allowed",
        `"${file.filename}" is a source distribution; only wheels are allowed`,
      );
    }
    // Each adapter may reach only its own upstream hosts, not every host
    // the pinned fetch allows for the registry as a whole.
    if (!this.hostAllowed(adapter, file.upstreamUrl)) {
      await this.refuse(context, adapter, name, "wardby_upstream_host_not_allowed", file);
      throw new RegistryError(
        502,
        "wardby_upstream_host_not_allowed",
        `"${file.filename}" is hosted outside the ${adapter.id} registry's upstreams`,
      );
    }
    // HEAD answers from metadata alone: no upstream download, no
    // reservation, nothing recorded as served.
    if (request.method === "HEAD") return { status: 200, contentType: contentTypeOf(route), body: "" };
    return this.download(adapter, context, name, route, file, request.signal);
  }

  private hostAllowed(adapter: RegistryAdapter, url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && adapter.upstreamHosts.includes(parsed.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  /** Served usage for the run, seeded once from the store and then kept
   *  current in-process as downloads complete. */
  private async servedUsage(context: RegistryRunContext): Promise<{ files: number; bytes: number }> {
    const tally = this.tally(context);
    if (!tally.served) {
      const recorded = await this.options.store.usage(context.runId);
      tally.served ??= { files: recorded.files, bytes: recorded.bytes };
    }
    return tally.served;
  }

  private async authorize(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    name: string,
  ): Promise<AllowlistEntry | undefined> {
    const entries = parseAllowlist(context.allowlist, this.options.adapters).get(adapter.id) ?? [];
    const root = matchRoot(entries, name);
    if (root || (await this.options.store.isAllowedDependency(context.runId, adapter.id, name))) return root;
    await this.refuse(context, adapter, name, "wardby_package_not_allowed");
    const hint =
      entries.length === 0
        ? `this agent has no ${adapter.id} package allowlist`
        : `"${name}" is not on this agent's ${adapter.id} package allowlist`;
    throw new RegistryError(403, "wardby_package_not_allowed", hint);
  }

  private async metadata(adapter: RegistryAdapter, name: string): Promise<PackageMetadata> {
    const key = `${adapter.id}:${name}`;
    const now = this.now().getTime();
    const cached = this.metadataCache.get(key);
    if (cached) {
      this.metadataCache.delete(key);
      if (cached.expires > now) {
        this.metadataCache.set(key, cached); // most recently used
        return cached.meta;
      }
    }
    const pending = this.metadataLoads.get(key);
    if (pending) return pending;
    const load = adapter
      .fetchMetadata(name, this.metadataUpstream)
      .then((meta) => {
        this.cacheMetadata(key, meta);
        return meta;
      })
      .finally(() => this.metadataLoads.delete(key));
    this.metadataLoads.set(key, load);
    return load;
  }

  private cacheMetadata(key: string, meta: PackageMetadata): void {
    const now = this.now().getTime();
    for (const [cachedKey, entry] of this.metadataCache) {
      if (entry.expires <= now) this.metadataCache.delete(cachedKey);
    }
    this.metadataCache.delete(key);
    while (this.metadataCache.size >= this.metadataCacheEntries) {
      const oldest = this.metadataCache.keys().next();
      if (oldest.done) break;
      this.metadataCache.delete(oldest.value);
    }
    this.metadataCache.set(key, { expires: now + this.metadataTtlMs, meta });
  }

  private async keptVersions(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    meta: PackageMetadata,
    root: AllowlistEntry | undefined,
  ): Promise<{ keep: Set<string>; keptFiles: Set<string> }> {
    const { minReleaseAgeDays } = resolvePolicy(context.policy);
    const cutoff = this.now().getTime() - minReleaseAgeDays * DAY_MS;
    const advisories = await this.options.audit.audit(adapter, meta.name);
    const keep = new Set<string>();
    const keptFiles = new Set<string>();
    for (const info of meta.versions.values()) {
      if (root?.range && !adapter.satisfies(info.version, root.range)) continue;
      // Per-file release age: a file with an unknown or too-recent publish
      // time is never listed or served. A version survives if any of its
      // files does.
      const oldEnough = info.files.filter((file) => file.publishedAt && file.publishedAt.getTime() <= cutoff);
      if (oldEnough.length === 0) continue;
      if (advisories.withheld(info.version).length > 0) continue;
      keep.add(info.version);
      for (const file of oldEnough) keptFiles.add(file.filename);
    }
    return { keep, keptFiles };
  }

  private tally(context: RegistryRunContext): RunTally {
    let tally = this.tallies.get(context.runId);
    if (!tally) {
      const now = this.now().getTime();
      for (const [runId, stale] of this.tallies) if (stale.deadline <= now) this.tallies.delete(runId);
      tally = { deadline: context.deadlineAt.getTime() };
      this.tallies.set(context.runId, tally);
    }
    return tally;
  }

  /** Records a refused row, at most `maxRefusalRecords` per run so a worker
   *  hammering refused names cannot grow the table (or get_run and the PR
   *  body) without bound. Callers still return the refusal's error. */
  private async refuse(
    context: RegistryRunContext,
    adapter: RegistryAdapter,
    name: string,
    reason: string,
    file?: FileRef,
  ) {
    const tally = this.tally(context);
    if (tally.refused === undefined) {
      const recorded = await this.options.store.refusalCount(context.runId);
      tally.refused ??= recorded; // a concurrent first refusal may have seeded it already
    }
    if (tally.refused >= (this.options.limits.maxRefusalRecords ?? DEFAULT_MAX_REFUSAL_RECORDS)) return;
    tally.refused += 1;
    await this.options.store.recordFetch({
      runId: context.runId,
      ecosystem: adapter.id,
      name,
      version: file?.version,
      filename: file?.filename,
      outcome: "refused",
      reason,
    });
  }

  private inFlightUsage(runId: string): { files: number; bytes: number } {
    return this.inFlight.get(runId) ?? { files: 0, bytes: 0 };
  }

  /** Reserve one file slot for a download that is about to start, and its
   *  declared size when known. An unknown size (`null`) reserves no bytes
   *  up front; those are added incrementally as they stream, via
   *  `trackStreamedBytes`. */
  private reserveDownload(runId: string, sizeBytes: number | null): void {
    const slot = this.inFlight.get(runId) ?? { files: 0, bytes: 0 };
    slot.files += 1;
    if (sizeBytes !== null) slot.bytes += sizeBytes;
    this.inFlight.set(runId, slot);
  }

  /** Only called for downloads whose declared size was unknown at
   *  reservation time; adds each chunk's bytes to the in-flight total as it
   *  arrives, so the shared budget check sees them immediately. */
  private trackStreamedBytes(runId: string, delta: number): void {
    const slot = this.inFlight.get(runId);
    if (slot) slot.bytes += delta;
  }

  /** Release a download's reservation on every exit path (served, failed,
   *  cancelled, or refused before it ever reserved streaming). Undoes
   *  exactly what was reserved: the declared size when known, or the bytes
   *  actually streamed when it was not. */
  private releaseDownload(runId: string, sizeBytes: number | null, streamedBytes: number): void {
    const slot = this.inFlight.get(runId);
    if (!slot) return;
    slot.files = Math.max(0, slot.files - 1);
    slot.bytes = Math.max(0, slot.bytes - (sizeBytes ?? streamedBytes));
    if (slot.files === 0 && slot.bytes === 0) this.inFlight.delete(runId);
    else this.inFlight.set(runId, slot);
  }

  private async download(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    name: string,
    route: DownloadRoute | FileMetadataRoute,
    file: FileRef,
    signal: AbortSignal,
  ): Promise<RegistryResponse> {
    const { limits, store } = this.options;
    const runId = context.runId;
    const served = await this.servedUsage(context);
    const flight = this.inFlightUsage(runId);
    if (served.files + flight.files >= limits.maxFiles) {
      await this.refuse(context, adapter, name, "wardby_package_limit", file);
      throw new RegistryError(429, "wardby_package_limit", "this run has reached its package file limit");
    }
    if (file.sizeBytes !== null && file.sizeBytes > limits.maxFileBytes) {
      await this.refuse(context, adapter, name, "wardby_package_too_large", file);
      throw new RegistryError(413, "wardby_package_too_large", `"${file.filename}" exceeds the per-file size limit`);
    }

    // Reserve this download's slot before any further await, so a
    // concurrent download for the same run (e.g. npm installing several
    // dependencies in parallel) sees it immediately rather than racing past
    // the same `usage()` snapshot. Released on every exit path below.
    this.reserveDownload(runId, file.sizeBytes);
    let bytes = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.releaseDownload(runId, file.sizeBytes, bytes);
    };

    let upstream: Response;
    try {
      upstream = await this.options.upstream(file.upstreamUrl, { signal });
    } catch (error) {
      release();
      throw error;
    }
    if (!upstream.ok || !upstream.body) {
      release();
      throw new RegistryError(502, "wardby_upstream_error", `the registry returned ${upstream.status}`);
    }

    const hash = file.integrity ? createHash(file.integrity.algorithm) : null;
    const buffered: Uint8Array[] = [];
    let idle: NodeJS.Timeout | undefined;
    // Guards the race the controller flagged: the idle timer's fail() and a
    // pending reader.read() can both try to act on the same controller. Once
    // either the stream has failed or it has recorded a served/refused row,
    // `settled` is true and every later exit path becomes a no-op, so at
    // most one refused/served row is ever recorded and enqueue/close/error
    // are never called on an already-settled controller.
    let settled = false;
    // Cast: undici's ReadableStream defaults its element type to `any`, and
    // `Response.body`'s type carries that through. The bytes are always
    // Uint8Array chunks in practice, so name the type explicitly rather than
    // let `any` leak into every read below.
    const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();

    const clearIdle = () => {
      clearTimeout(idle);
      idle = undefined;
    };

    const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, reason: string) => {
      if (settled) return;
      settled = true;
      clearIdle();
      release();
      await reader.cancel().catch(() => undefined);
      try {
        await this.refuse(context, adapter, name, reason, file);
      } catch {
        // A failed record must never crash the process (this can run from a
        // fire-and-forget `void fail(...)` off the idle timer, where an
        // unhandled rejection would terminate the whole proxy) or block the
        // client from seeing the stream error below.
      } finally {
        controller.error(new RegistryError(502, reason, `download of "${file.filename}" stopped: ${reason}`));
      }
    };

    // The client went away (its request signal aborted the upstream read):
    // release the reservation and record nothing, since nothing was served
    // and nothing was refused.
    const abandon = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (settled) return;
      settled = true;
      clearIdle();
      release();
      controller.error(new RegistryError(499, "client_disconnected", "the client disconnected"));
    };

    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (settled) return;
        clearIdle();
        idle = setTimeout(() => void fail(controller, "wardby_download_idle"), limits.idleTimeoutMs);
        const outcome: ReadOutcome = await reader.read().then(
          (result): ReadOutcome =>
            result.done ? { ok: true, done: true } : { ok: true, done: false, value: result.value },
          (): ReadOutcome => ({ ok: false }),
        );
        // The idle timer may have fired and already failed the stream while
        // this read was pending (or canceled the reader, causing the
        // rejection above); a late resolution must never enqueue, close, or
        // record on top of that already-settled outcome.
        if (settled) return;
        clearIdle();
        if (!outcome.ok) return signal.aborted ? abandon(controller) : fail(controller, "wardby_upstream_error");
        if (outcome.done) {
          if (hash && hash.digest("hex") !== file.integrity!.hex) return fail(controller, "wardby_integrity_mismatch");
          settled = true;
          // Persist the served record (and the dependency allowances it
          // grows) BEFORE releasing the in-flight reservation. Releasing
          // first would open a window, between the release and the row
          // actually landing in the store, where neither `inFlight` nor
          // store.usage() counts this file — a concurrent request could be
          // admitted past maxFiles/maxTotalBytes in that window, reopening
          // the race the reservation exists to close. `release()` still
          // runs unconditionally (finally), so a failed record never leaks
          // the reservation; it errors the controller instead of closing it,
          // the same way every other failure path here does.
          try {
            await store.recordFetch({
              runId: context.runId,
              ecosystem: adapter.id,
              name,
              version: file.version,
              filename: file.filename,
              integrity: file.integrity ? `${file.integrity.algorithm}:${file.integrity.hex}` : undefined,
              sizeBytes: bytes,
              outcome: "served",
            });
            // Counted before release() drops the reservation, so no window
            // exists where neither the tally nor inFlight holds this file.
            served.files += 1;
            served.bytes += bytes;
            if (adapter.dependenciesFromFile && buffered.length > 0) {
              const body = Buffer.concat(buffered);
              const names = await adapter.dependenciesFromFile(route, body).catch(() => []);
              await store.addAllowances(
                context.runId,
                adapter.id,
                names.map((dependency) => adapter.normalizeName(dependency)),
              );
            }
            controller.close();
          } catch (error) {
            controller.error(
              error instanceof RegistryError
                ? error
                : new RegistryError(
                    502,
                    "wardby_upstream_error",
                    `failed to record the completed download of "${file.filename}"`,
                  ),
            );
          } finally {
            release();
          }
          return;
        }
        const { value } = outcome;
        bytes += value.byteLength;
        if (file.sizeBytes === null) this.trackStreamedBytes(runId, value.byteLength);
        if (bytes > limits.maxFileBytes) return fail(controller, "wardby_package_too_large");
        if (served.bytes + this.inFlightUsage(runId).bytes > limits.maxTotalBytes)
          return fail(controller, "wardby_package_limit");
        hash?.update(value);
        if (adapter.dependenciesFromFile && bytes <= DEPENDENCY_BUFFER_LIMIT) buffered.push(value);
        controller.enqueue(value);
      },
      cancel: async () => {
        settled = true;
        clearIdle();
        release();
        await reader.cancel().catch(() => undefined);
      },
    });
    return { status: 200, contentType: contentTypeOf(route), stream };
  }
}
