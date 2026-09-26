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
import { PLAN_REFUSAL_FILENAME } from "../../../coding/registry/report.js";
import {
  RegistryError,
  type AllowlistEntry,
  type DependencySpec,
  type DownloadRoute,
  type FileMetadataRoute,
  type FileRef,
  type Integrity,
  type LockfilePlanSupport,
  type PackageMetadata,
  type RegistryAdapter,
  type RegistryRoute,
  type UpstreamFetch,
} from "../../../coding/registry/types.js";
import { capabilityHash } from "../proxy.js";
import type { OsvAudit } from "./audit.js";
import { boundedMetadataFetch, DEFAULT_MAX_METADATA_BYTES, DEFAULT_METADATA_TIMEOUT_MS } from "./bounded-fetch.js";
import { DEFAULT_PLAN_MAX_ENTRIES, DEFAULT_PLAN_TIMEOUT_MS, verifyLockfilePlan, type PlanRefusal } from "./plan.js";
import type { RegistryRunContext, RegistryStore } from "./store.js";

const DAY_MS = 86_400_000;
/** Bytes of a served file kept for `dependenciesFromFile`. A larger file is
 *  truncated here, the adapter cannot read its metadata from a truncated
 *  archive, and it yields no dependencies: this fails closed (nothing is
 *  allowed that the file did not prove). */
const DEPENDENCY_BUFFER_LIMIT = 64 * 1024 * 1024;
/** npm's own name-length limit; longer recorded names are truncated. */
const MAX_RECORDED_NAME = 214;
export const DEFAULT_MAX_GRAPH_PACKAGES = 3000;
export const DEFAULT_GRAPH_TIMEOUT_MS = 180_000;
/** Packages one graph walk expands at once (metadata + audit each). Each
 *  expansion may hold a whole parsed npm packument (tens of MB for the
 *  largest), so this bounds the walk's peak memory, not only its upstream
 *  load: 8 at once OOM-killed a 512Mi proxy in a live lockfile install. */
const GRAPH_WALK_CONCURRENCY = 4;
/** Graph-walk expansions in flight at once across every run, so one run's
 *  walk cannot starve the others' upstream fetches. */
export const DEFAULT_MAX_GRAPH_CONCURRENCY = 6;
/** A node whose metadata or audit fails transiently is retried once more
 *  in the same walk, then parked; a later miss retries it again, up to
 *  this many attempts per node per run. */
const GRAPH_NODE_ATTEMPTS_PER_WALK = 2;
const MAX_GRAPH_NODE_ATTEMPTS = 4;
/** RegistryErrors that are a definitive answer about a package (it has no
 *  dependencies the run can use), not a transient failure to retry. */
const DEFINITIVE_NODE_ERRORS = new Set(["wardby_package_not_found", "wardby_metadata_too_large"]);

/** Largest per-version document read from upstream for lockfile
 *  verification (they are a few KB). */
const MAX_VERSION_DOCUMENT_BYTES = 4 * 1024 * 1024;
/** Lockfile plans verified at once across every run. */
const PLAN_CONCURRENCY = 2;
/** The `filename` of a refused RegistryFetch row a lockfile plan recorded
 *  (the route it came from), which is how get_run tells plan refusals from
 *  download refusals. */
export const PLAN_FETCH_FILENAME = PLAN_REFUSAL_FILENAME;
/** Largest lockfile a plan reads (the HTTP layer enforces it: 413). */
export const MAX_PLAN_BODY_BYTES = 20 * 1024 * 1024;

/** Why a graph node could not be expanded: its OSV audit or its upstream
 *  metadata was unavailable. */
type NodeFailure = "audit" | "upstream";
/** One edge of the graph to expand: a package and the range its parent
 *  declared (`"*"` for a root, whose allowlist range applies instead). */
interface GraphEdge {
  name: string;
  range: string;
}
/** A kept version the walk selected, with its declared dependencies. */
type SelectedVersion = { version: string; dependencies: readonly DependencySpec[] };
type NodeResult = { ok: true; selected: SelectedVersion[] } | { ok: false; cause: NodeFailure };
/** One package's kept versions and each one's declared dependencies,
 *  computed once per walk and shared by every edge that reaches it (a
 *  popular package is reached under many distinct ranges). Deliberately
 *  not the PackageMetadata: a walk may reach thousands of packages, and
 *  holding each one's metadata for the walk's lifetime would bypass the
 *  metadata cache's bounds. */
type KeptPackage = ReadonlyMap<string, readonly DependencySpec[]>;

/** A small counting semaphore. */
class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/** Why a graph walk stopped: it found the name it was started for, it
 *  expanded every reachable package, or a bound tripped. */
type WalkEnd = "found" | "complete" | "limit" | "timeout";

/** One run's on-demand walk of its approved dependency graph for one
 *  ecosystem, range-aware: breadth first from the allowlist's exact roots,
 *  following each declared dependency `name@range` only into that
 *  dependency's kept versions satisfying the range, and from those
 *  versions only. It is resumable (a walk stops as soon as it finds the
 *  name it was started for, and a later miss continues from where it
 *  stopped), single-flight (`running`), and memoized for the run (a miss
 *  once `queue` is empty needs no upstream call). */
interface GraphWalk {
  /** Every name proven part of the graph: the exact roots, plus each
   *  package with at least one kept version inside a range an expanded
   *  version declared. Every non-root name here has been written to the
   *  store as an allowance. */
  found: Set<string>;
  /** Edges not yet expanded, in breadth-first order. */
  queue: GraphEdge[];
  /** Every edge ever queued (`name\0range`), so each is expanded once. */
  seen: Set<string>;
  /** Versions whose dependencies were already followed, per package, so
   *  a version reached through several ranges is expanded once. Its size
   *  is the number of packages walked (bounded by maxGraphPackages). */
  expandedVersions: Map<string, Set<string>>;
  /** The package bound tripped: the graph is incomplete for good. */
  exhausted: boolean;
  /** Failed attempts per edge, across the run. */
  attempts: Map<string, number>;
  /** Edges that could not be expanded (transient upstream or audit
   *  failure), retried by a later walk while attempts remain. While any
   *  is here, a name not found is "unavailable", never "not allowed". */
  failed: Map<string, { edge: GraphEdge; cause: NodeFailure }>;
  running?: Promise<WalkEnd>;
  /** Set when the run's state is released (its deadline passed): a walk
   *  still running stops at its next batch instead of holding its state
   *  until the graph timeout. */
  released?: boolean;
}

const edgeKey = (edge: GraphEdge) => `${edge.name}\0${edge.range}`;

/** `cutShort`: the walk stopped (its time ran out, or the package bound
 *  tripped) before it either found the name or expanded the whole graph,
 *  so whether the name is in the graph is unknown. */
type GraphAnswer = "found" | "absent" | { cutShort: "timeout" | "limit" } | { unavailable: NodeFailure };

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
  /** Drops this tally (and its graph walks) when the run's deadline passes. */
  timer?: NodeJS.Timeout;
  refused?: number;
  /** Served files and bytes, kept live as downloads complete, so a download
   *  that started before another finished still counts it (a one-off
   *  `usage()` snapshot would not). */
  served?: { files: number; bytes: number };
  /** On-demand dependency-graph walks, keyed by ecosystem. */
  graphs?: Map<string, GraphWalk>;
  /** A lockfile plan is running for the run: one at a time per run, so a
   *  worker cannot queue many (each holds its parsed lockfile). */
  planning?: boolean;
  /** Plan refusals already recorded (`ecosystem\0name@version\0code`), so
   *  a lockfile planned again records each refusal once. */
  planRefusals?: Set<string>;
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
export interface RegistryPlanRequest {
  ecosystem: string;
  token: string;
  /** The lockfile, as sent (at most MAX_PLAN_BODY_BYTES). */
  body: string;
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
/** Byte budget of the metadata cache, by each entry's approximate retained
 *  size. Entries are trimmed (an npm package's is a few MB at most, for
 *  thousands of versions), but 500 of them could still add up. */
export const DEFAULT_METADATA_CACHE_BYTES = 64 * 1024 * 1024;
/** setTimeout's largest delay; a longer deadline is re-armed on firing. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** `approxBytes` when the adapter reports it, otherwise a generous
 *  estimate from the versions alone. */
function metadataBytes(meta: PackageMetadata): number {
  if (meta.approxBytes !== undefined) return meta.approxBytes;
  let bytes = 256 + meta.name.length;
  for (const info of meta.versions.values()) {
    bytes += 400 + 2 * info.version.length;
    for (const spec of info.dependencySpecs ?? []) bytes += 80 + spec.name.length + spec.range.length;
    for (const name of info.dependencies) bytes += 40 + name.length;
    for (const file of info.files)
      bytes += 400 + file.filename.length + file.upstreamUrl.length + (file.integrity?.hex.length ?? 0);
  }
  return bytes;
}

/** Normalized dependency names of a package's kept versions: what serving
 *  its metadata unlocks, and what the graph walk follows. Dependency keys
 *  come from the upstream document, so only real package names are kept:
 *  neither path ever records an allowance for, or builds an upstream
 *  request from, a key the adapter's own parser would reject. */
function keptDependencies(adapter: RegistryAdapter, meta: PackageMetadata, keep: ReadonlySet<string>): string[] {
  return [...new Set([...keep].flatMap((version) => versionDependencies(adapter, meta, version).map((d) => d.name)))];
}

/** One version's declared dependencies (name and range), normalized and
 *  limited to real package names: the single source both the metadata
 *  path (names only) and the graph walk (names and ranges) read. */
function versionDependencies(adapter: RegistryAdapter, meta: PackageMetadata, version: string): DependencySpec[] {
  const info = meta.versions.get(version);
  if (!info) return [];
  const specs = info.dependencySpecs ?? info.dependencies.map((name) => ({ name, range: "*" }));
  return specs
    .map((spec) => ({ name: adapter.normalizeName(spec.name), range: spec.range }))
    .filter((spec) => isPackageName(adapter, spec.name));
}

/** Whether `name` is a plain, valid package name in this ecosystem (no
 *  wildcard, no range), by the adapter's own allowlist parser. */
function isPackageName(adapter: RegistryAdapter, name: string): boolean {
  try {
    const entry = adapter.parseAllowlistEntry(name);
    return !entry.wildcard && entry.range === undefined && entry.name === name;
  } catch {
    return false;
  }
}

/** The strongest supported hash of an SRI integrity string (`sha512-…`,
 *  possibly several space-separated), or null when it has none. */
export function parseSri(value: string): Integrity | null {
  const order: Integrity["algorithm"][] = ["sha512", "sha384", "sha256", "sha1"];
  let best: Integrity | null = null;
  for (const token of value.trim().split(/\s+/)) {
    const match = token.match(/^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/);
    if (!match) continue;
    const algorithm = match[1] as Integrity["algorithm"];
    if (best && order.indexOf(best.algorithm) <= order.indexOf(algorithm)) continue;
    best = { algorithm, hex: Buffer.from(match[2], "base64").toString("hex") };
  }
  return best;
}

export class RegistryService {
  /** Parsed, trimmed metadata (adapters keep only the fields the proxy
   *  reads, never the upstream document), least recently used first.
   *  Bounded to `metadataCacheEntries` and `metadataCacheBytes`; expired
   *  entries are dropped on access and on insert. */
  private readonly metadataCache = new Map<string, { expires: number; bytes: number; meta: PackageMetadata }>();
  /** Sum of the cached entries' `bytes`. */
  private metadataCacheTotal = 0;
  /** Single-flight: concurrent misses for one package (and render need)
   *  share one upstream fetch. */
  private readonly metadataLoads = new Map<string, Promise<PackageMetadata>>();
  private readonly now: () => Date;
  private readonly metadataTtlMs: number;
  private readonly metadataCacheEntries: number;
  private readonly metadataCacheBytes: number;
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
  private readonly walkSlots: Slots;
  private readonly planSlots = new Slots(PLAN_CONCURRENCY);
  private readonly versionUpstream: UpstreamFetch;

  constructor(
    private readonly options: {
      adapters: ReadonlyMap<string, RegistryAdapter>;
      store: RegistryStore;
      audit: Pick<OsvAudit, "audit"> & Partial<Pick<OsvAudit, "auditVersions">>;
      upstream: UpstreamFetch;
      proxyBase: string;
      limits: RegistryLimits;
      now?: () => Date;
      metadataTtlMs?: number;
      metadataCacheEntries?: number;
      /** Byte budget of the metadata cache (default 64 MiB), by each
       *  entry's approximate retained size. */
      metadataCacheBytes?: number;
      /** Timeout for one metadata request, body included (default 30 s). */
      metadataTimeoutMs?: number;
      /** Largest metadata document read from upstream (default 64 MiB). */
      maxMetadataBytes?: number;
      /** Distinct packages an on-demand graph walk may expand per run and
       *  ecosystem (default 3000). */
      maxGraphPackages?: number;
      /** Time one on-demand graph walk may take (default 180 s). */
      graphTimeoutMs?: number;
      /** Graph-walk expansions in flight at once across every run
       *  (default 16). */
      maxGraphConcurrency?: number;
      /** Entries a lockfile plan may have (default 5000). */
      planMaxEntries?: number;
      /** Time one lockfile plan may take (default 120 s). */
      planTimeoutMs?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.walkSlots = new Slots(options.maxGraphConcurrency ?? DEFAULT_MAX_GRAPH_CONCURRENCY);
    this.metadataTtlMs = options.metadataTtlMs ?? 300_000;
    this.metadataCacheEntries = options.metadataCacheEntries ?? DEFAULT_METADATA_CACHE_ENTRIES;
    this.metadataCacheBytes = options.metadataCacheBytes ?? DEFAULT_METADATA_CACHE_BYTES;
    this.metadataUpstream = boundedMetadataFetch(options.upstream, {
      timeoutMs: options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
      maxBytes: options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES,
    });
    this.versionUpstream = boundedMetadataFetch(options.upstream, {
      timeoutMs: options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
      maxBytes: MAX_VERSION_DOCUMENT_BYTES,
    });
  }

  /** `POST /registry/<ecosystem>/-/plan`: verifies a lockfile against the
   *  registry and approves exactly its verified, reachable name@version
   *  pairs for the run (plan.ts). Answers `{ approved, refused }`. */
  async plan(request: RegistryPlanRequest): Promise<RegistryResponse> {
    try {
      return await this.planLockfile(request);
    } catch (error) {
      if (error instanceof RegistryError) return errorResponse(error);
      return errorResponse(new RegistryError(502, "wardby_upstream_error", "the lockfile could not be verified"));
    }
  }

  private async planLockfile(request: RegistryPlanRequest): Promise<RegistryResponse> {
    const adapter = this.options.adapters.get(request.ecosystem);
    if (!adapter) throw new RegistryError(404, "wardby_registry_unknown", `no registry named "${request.ecosystem}"`);
    const context = await this.options.store.findRunByRegistryTokenHash(capabilityHash(request.token), this.now());
    if (!context) throw new RegistryError(401, "invalid_capability", "the registry token is not valid for a live run");
    const support = adapter.lockfilePlan;
    const auditVersions = this.options.audit.auditVersions?.bind(this.options.audit);
    if (!support || !auditVersions)
      throw new RegistryError(404, "wardby_plan_unsupported", `the ${adapter.id} registry does not verify lockfiles`);
    const tally = this.tally(context);
    if (tally.planning)
      throw new RegistryError(
        429,
        "wardby_plan_in_progress",
        "a lockfile plan is already running for this run; wait for it to finish",
      );
    tally.planning = true;
    try {
      return await this.verifyPlan(request, adapter, support, auditVersions, context);
    } finally {
      tally.planning = false;
    }
  }

  private async verifyPlan(
    request: RegistryPlanRequest,
    adapter: RegistryAdapter,
    support: LockfilePlanSupport,
    auditVersions: OsvAudit["auditVersions"],
    context: RegistryRunContext,
  ): Promise<RegistryResponse> {
    const lockfile = support.parse(request.body, {
      maxEntries: this.options.planMaxEntries ?? DEFAULT_PLAN_MAX_ENTRIES,
      proxyRegistryUrl: `${this.options.proxyBase}${adapter.id}/`,
    });
    const entries = parseAllowlist(context.allowlist, this.options.adapters).get(adapter.id) ?? [];
    const { minReleaseAgeDays } = resolvePolicy(context.policy);
    const timeoutMs = this.options.planTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), request.signal]);
    const store = this.options.store;
    let result;
    try {
      result = await this.planSlots.run(() =>
        verifyLockfilePlan({
          adapter,
          support,
          lockfile,
          roots: entries,
          cutoff: new Date(this.now().getTime() - minReleaseAgeDays * DAY_MS),
          facts: {
            getVersionFacts: (versions) => store.getVersionFacts(adapter.id, versions),
            putVersionFacts: (facts) => store.putVersionFacts(adapter.id, facts),
          },
          upstream: this.versionUpstream,
          streamUpstream: this.options.upstream,
          audit: (versions, auditSignal) => auditVersions(adapter, versions, auditSignal),
          hostAllowed: (url) => this.hostAllowed(adapter, url),
          signal,
        }),
      );
    } catch (error) {
      if (!signal.aborted) throw error;
      // Every fact read so far is stored, so a retry resumes from there.
      throw new RegistryError(
        503,
        "wardby_plan_incomplete",
        request.signal.aborted
          ? "the client went away before the lockfile was verified"
          : `the lockfile was not verified within ${Math.round(timeoutMs / 1000)} s (REGISTRY_PLAN_TIMEOUT_MS); what was verified is kept, so try again`,
      );
    }
    await store.approveVersions(context.runId, adapter.id, result.approved);
    await this.recordPlanRefusals(context, adapter, result.refused);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ approved: result.approved.length, refused: result.refused }),
    };
  }

  /** One refused row per plan refusal, within the run's refusal cap, and
   *  once per run however often the same lockfile is planned. */
  private async recordPlanRefusals(
    context: RegistryRunContext,
    adapter: RegistryAdapter,
    refused: readonly PlanRefusal[],
  ): Promise<void> {
    const tally = this.tally(context);
    tally.planRefusals ??= new Set();
    for (const refusal of refused) {
      const key = `${adapter.id}\0${refusal.name}@${refusal.version}\0${refusal.code}`;
      if (tally.planRefusals.has(key)) continue;
      tally.planRefusals.add(key);
      await this.refuse(context, adapter, refusal.name.slice(0, MAX_RECORDED_NAME), refusal.code, {
        version: refusal.version,
        filename: PLAN_FETCH_FILENAME,
      });
    }
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
    if (route.kind === "download") {
      // A version the run's lockfile plan approved is served as it stands:
      // no allowlist lookup, no graph walk, integrity checked against the
      // approved value.
      const approved = await this.options.store.findApprovedVersion(context.runId, adapter.id, name, route.version);
      const integrity = approved ? parseSri(approved.integrity) : null;
      if (approved && integrity) {
        const file: FileRef = {
          filename: route.filename,
          version: route.version,
          upstreamUrl: approved.downloadUrl,
          integrity,
          sizeBytes: null,
          allowed: true,
          publishedAt: null,
        };
        if (!this.hostAllowed(adapter, file.upstreamUrl)) {
          await this.refuse(context, adapter, name, "wardby_upstream_host_not_allowed", file);
          throw new RegistryError(
            502,
            "wardby_upstream_host_not_allowed",
            `"${file.filename}" is hosted outside the ${adapter.id} registry's upstreams`,
          );
        }
        if (request.method === "HEAD") return { status: 200, contentType: contentTypeOf(route), body: "" };
        return this.download(adapter, context, name, route, file, request.signal);
      }
    }
    const root = await this.authorize(adapter, context, name);
    let meta: PackageMetadata;
    try {
      // Only a metadata request renders a document; a download, the version
      // filter and the graph walk need only the trimmed versions.
      meta = await this.metadata(adapter, name, route.kind === "metadata");
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
      await this.options.store.addAllowances(context.runId, adapter.id, keptDependencies(adapter, meta, keep));
      const document = adapter.renderMetadata(meta, keep, keptFiles, `${this.options.proxyBase}${adapter.id}/`);
      return { status: 200, contentType: document.contentType, body: document.body };
    }

    const file =
      route.kind === "download"
        ? adapter.resolveDownload(route, meta)
        : (adapter.resolveFileMetadata?.(route, meta) ?? null);
    // The release age applies per file: a file newer than the cutoff is
    // refused exactly like a filtered version, even in a kept release. A
    // PEP 658 metadata file is judged by the wheel it describes
    // (route.filename), since keptFiles holds wheel filenames.
    const agedFile = route.kind === "file-metadata" ? route.filename : file?.filename;
    if (!file || !keep.has(file.version) || !agedFile || !keptFiles.has(agedFile)) {
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
    // Not a root and not yet an allowance: the name may still be in the
    // approved graph, unrecorded only because the client never asked for
    // its parent's metadata (a lockfile install requests tarballs
    // directly). Resolve the graph before refusing.
    const graph = await this.resolveInGraph(adapter, context, entries, name);
    if (graph === "found") return undefined;
    if (typeof graph === "object" && "cutShort" in graph) {
      if (graph.cutShort === "limit") {
        // The bound is permanent for the rest of the run, so a retry can
        // never succeed: answer with a definitive 4xx (npm does not retry
        // it) rather than a 503 that a client or agent would retry forever.
        // Still not "not allowed": the name was not proven absent.
        await this.refuse(context, adapter, name, "wardby_graph_limit");
        throw new RegistryError(
          403,
          "wardby_graph_limit",
          `"${name}" was not reached before this agent's ${adapter.id} dependency graph walk hit its package limit (REGISTRY_MAX_GRAPH_PACKAGES) for this run; retrying will not help: allowlist the package directly, or ask the operator to raise the limit`,
        );
      }
      // Not proven absent, so never "not allowed": a timed-out walk resumes
      // where it stopped on the next miss, so a retry (npm retries a 5xx on
      // its own) can find the name.
      await this.refuse(context, adapter, name, "wardby_graph_incomplete");
      throw new RegistryError(
        503,
        "wardby_graph_incomplete",
        `"${name}" was not reached before this agent's ${adapter.id} dependency graph walk was cut short by its time limit (REGISTRY_GRAPH_TIMEOUT_MS); the walk continues where it stopped: try again`,
      );
    }
    if (typeof graph === "object") {
      // Some part of the graph could not be read, so whether the name is in
      // it is unknown: say so honestly rather than "not allowed".
      const [status, code, source] =
        graph.unavailable === "audit"
          ? ([503, "wardby_audit_unavailable", "the OSV vulnerability audit"] as const)
          : ([502, "wardby_upstream_error", `the ${adapter.id} registry`] as const);
      await this.refuse(context, adapter, name, code);
      throw new RegistryError(
        status,
        code,
        `"${name}" could not be checked against this agent's approved ${adapter.id} dependency graph because ${source} was unavailable while resolving it; try again`,
      );
    }
    await this.refuse(context, adapter, name, "wardby_package_not_allowed");
    const hint =
      entries.length === 0
        ? `this agent has no ${adapter.id} package allowlist`
        : `"${name}" is not on this agent's ${adapter.id} package allowlist or in its dependency graph`;
    throw new RegistryError(403, "wardby_package_not_allowed", hint);
  }

  /** Whether `name` is in the run's approved graph for this ecosystem:
   *  the allowlist's exact roots plus the dependencies of every kept
   *  version (the same filter the metadata path applies: root range,
   *  release age, advisories), transitively. Each newly found name is
   *  recorded as an allowance as the walk goes, exactly as if its
   *  parent's metadata had been served. A scoped wildcard root cannot be
   *  enumerated, so it is never a starting point. */
  private async resolveInGraph(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    entries: readonly AllowlistEntry[],
    name: string,
  ): Promise<GraphAnswer> {
    if (!adapter.dependenciesInMetadata) return "absent";
    const tally = this.tally(context);
    tally.graphs ??= new Map();
    let walk = tally.graphs.get(adapter.id);
    if (!walk) {
      const roots = [...new Set(entries.filter((entry) => !entry.wildcard).map((entry) => entry.name))];
      const edges = roots.map((root) => ({ name: root, range: "*" }));
      walk = {
        found: new Set(roots),
        queue: edges,
        seen: new Set(edges.map(edgeKey)),
        expandedVersions: new Map(),
        exhausted: false,
        attempts: new Map(),
        failed: new Map(),
      };
      tally.graphs.set(adapter.id, walk);
    }
    const current = walk;
    let started = false;
    for (;;) {
      if (current.found.has(name)) return "found";
      if (current.exhausted) return { cutShort: "limit" };
      // Single-flight: a miss while a walk is running waits for it rather
      // than starting a second one, then re-checks (that walk may have
      // stopped on finding a different name). Checked before the queue: a
      // running walk has taken its current batch off the queue, so an
      // empty queue alone does not mean the graph is complete. Each miss
      // starts at most one walk of its own, so it spends at most one
      // round of retries on failed nodes.
      if (!current.running) {
        const retriable = [...current.failed.keys()].some(
          (key) => (current.attempts.get(key) ?? 0) < MAX_GRAPH_NODE_ATTEMPTS,
        );
        if (started || (current.queue.length === 0 && !retriable)) return this.graphMiss(current);
        started = true;
        current.running = this.walkGraph(adapter, context, entries, current, name).finally(() => {
          current.running = undefined;
        });
      }
      const end = await current.running;
      if (end === "timeout" && !current.found.has(name)) return { cutShort: "timeout" };
    }
  }

  /** The answer for a name the walk did not find: unavailable while any
   *  node could not be expanded (the audit, if any failure was the
   *  audit's), otherwise absent. */
  private graphMiss(walk: GraphWalk): GraphAnswer {
    if (walk.failed.size === 0) return "absent";
    return { unavailable: [...walk.failed.values()].some((entry) => entry.cause === "audit") ? "audit" : "upstream" };
  }

  private async walkGraph(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    entries: readonly AllowlistEntry[],
    walk: GraphWalk,
    target: string,
  ): Promise<WalkEnd> {
    const maxPackages = this.options.maxGraphPackages ?? DEFAULT_MAX_GRAPH_PACKAGES;
    const deadline = this.now().getTime() + (this.options.graphTimeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS);
    // Parked failures with attempts left go first: a later miss is this
    // walk's retry of them.
    const retry = [...walk.failed.entries()].filter(([key]) => (walk.attempts.get(key) ?? 0) < MAX_GRAPH_NODE_ATTEMPTS);
    for (const [key] of retry) walk.failed.delete(key);
    walk.queue.unshift(...retry.map(([, entry]) => entry.edge));
    const attemptsThisWalk = new Map<string, number>();
    // Per-walk memo: a walk lasts at most the graph timeout, well inside
    // the metadata and audit cache lifetimes, so this changes no decision.
    // A failed computation is not memoized, so its retry really retries.
    const kept = new Map<string, Promise<KeptPackage>>();
    while (walk.queue.length > 0) {
      if (walk.found.has(target)) return "found";
      if (walk.released) return "timeout";
      const remaining = deadline - this.now().getTime();
      if (remaining <= 0) return "timeout";
      const room = maxPackages - walk.expandedVersions.size;
      if (room <= 0) {
        walk.exhausted = true;
        return "limit";
      }
      // Each edge adds at most one new package, so a batch no larger than
      // the room left can never overshoot the bound.
      const batch = walk.queue.splice(0, Math.min(GRAPH_WALK_CONCURRENCY, room));
      const expansions = Promise.all(batch.map((edge) => this.graphNode(adapter, context, entries, edge, kept)));
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      });
      const results = await Promise.race([expansions, timedOut]).finally(() => clearTimeout(timer));
      if (results === "timeout") {
        // Not expanded: put the batch back so a later miss retries it (its
        // metadata is likely cached by then).
        walk.queue.unshift(...batch);
        return "timeout";
      }
      const expanded: { edge: GraphEdge; selected: SelectedVersion[] }[] = [];
      batch.forEach((edge, index) => {
        const result = results[index];
        if (result.ok) {
          expanded.push({ edge, selected: result.selected });
          return;
        }
        // A transient failure is never counted as expanded: the edge is
        // retried (once more in this walk, then by later misses) instead
        // of silently closing its whole subtree for the run.
        const key = edgeKey(edge);
        walk.attempts.set(key, (walk.attempts.get(key) ?? 0) + 1);
        attemptsThisWalk.set(key, (attemptsThisWalk.get(key) ?? 0) + 1);
        if (
          (attemptsThisWalk.get(key) ?? 0) < GRAPH_NODE_ATTEMPTS_PER_WALK &&
          (walk.attempts.get(key) ?? 0) < MAX_GRAPH_NODE_ATTEMPTS
        )
          walk.queue.push(edge);
        else walk.failed.set(key, { edge, cause: result.cause });
      });
      // A package joins the graph (and gets its allowance) only when some
      // kept version of it satisfies a range that reached it. Recorded
      // before it counts as found, so `found` never holds a name the store
      // would refuse.
      const discovered = [
        ...new Set(
          expanded
            .filter(({ edge, selected }) => selected.length > 0 && !walk.found.has(edge.name))
            .map(({ edge }) => edge.name),
        ),
      ];
      try {
        if (discovered.length > 0) await this.options.store.addAllowances(context.runId, adapter.id, discovered);
      } catch (error) {
        // The store write failed: put the expanded edges back so a later
        // miss re-expands them, rather than leaving the graph silently short.
        walk.queue.unshift(...expanded.map(({ edge }) => edge));
        throw error;
      }
      for (const name of discovered) walk.found.add(name);
      for (const { edge, selected } of expanded) {
        let versions = walk.expandedVersions.get(edge.name);
        if (!versions) walk.expandedVersions.set(edge.name, (versions = new Set()));
        for (const { version, dependencies } of selected) {
          if (versions.has(version)) continue;
          versions.add(version);
          for (const dependency of dependencies) {
            const key = edgeKey(dependency);
            if (walk.seen.has(key)) continue;
            walk.seen.add(key);
            walk.queue.push(dependency);
          }
        }
      }
    }
    return walk.found.has(target) ? "found" : "complete";
  }

  /** The kept versions of one package inside the edge's range, and each
   *  one's declared dependencies, through the same metadata cache and
   *  `keptVersions` filter the metadata path uses (a root's allowlist range
   *  applies there), within the process-wide walk concurrency cap. `"*"`
   *  selects every kept version; a range no kept version satisfies selects
   *  none. A package npm doesn't have, or whose metadata is too large,
   *  definitively selects nothing; any other failure (upstream error or
   *  timeout, audit unavailable) is transient and reported for retry. */
  private graphNode(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    entries: readonly AllowlistEntry[],
    edge: GraphEdge,
    memo: Map<string, Promise<KeptPackage>>,
  ): Promise<NodeResult> {
    return this.walkSlots.run(async (): Promise<NodeResult> => {
      try {
        let load = memo.get(edge.name);
        if (!load) {
          load = (async (): Promise<KeptPackage> => {
            const meta = await this.metadata(adapter, edge.name, false);
            const { keep } = await this.keptVersions(adapter, context, meta, matchRoot(entries, edge.name));
            return new Map([...keep].map((version) => [version, versionDependencies(adapter, meta, version)]));
          })();
          memo.set(edge.name, load);
          load.catch(() => memo.delete(edge.name));
        }
        const keep = await load;
        const inRange = (version: string) => {
          if (edge.range === "*") return true;
          try {
            return adapter.satisfies(version, edge.range);
          } catch {
            return false;
          }
        };
        const selected: SelectedVersion[] = [];
        for (const [version, dependencies] of keep) if (inRange(version)) selected.push({ version, dependencies });
        return { ok: true, selected };
      } catch (error) {
        if (error instanceof RegistryError && DEFINITIVE_NODE_ERRORS.has(error.code)) return { ok: true, selected: [] };
        const audit = error instanceof RegistryError && error.code === "wardby_audit_unavailable";
        return { ok: false, cause: audit ? "audit" : "upstream" };
      }
    });
  }

  /** A package's metadata, cached. `render` asks for the form
   *  `renderMetadata` can serve; a cached entry fetched without it (by the
   *  graph walk or a download) is fetched again with it, and replaces it. */
  private async metadata(adapter: RegistryAdapter, name: string, render: boolean): Promise<PackageMetadata> {
    const key = `${adapter.id}:${name}`;
    const now = this.now().getTime();
    const cached = this.metadataCache.get(key);
    if (cached) {
      this.dropCached(key);
      if (cached.expires > now) {
        this.putCached(key, cached); // most recently used
        if (!render || cached.meta.raw !== undefined) return cached.meta;
      }
    }
    // Single-flight per need: a render load also serves a walk that asks
    // meanwhile, but not the other way round.
    const renderLoad = this.metadataLoads.get(`${key}\0render`);
    if (renderLoad) return renderLoad;
    const loadKey = render ? `${key}\0render` : key;
    const pending = this.metadataLoads.get(loadKey);
    if (pending) return pending;
    const load = adapter
      .fetchMetadata(name, this.metadataUpstream, { render })
      .then((meta) => {
        this.cacheMetadata(key, meta);
        return meta;
      })
      .finally(() => this.metadataLoads.delete(loadKey));
    this.metadataLoads.set(loadKey, load);
    return load;
  }

  private dropCached(key: string): void {
    const entry = this.metadataCache.get(key);
    if (!entry) return;
    this.metadataCache.delete(key);
    this.metadataCacheTotal -= entry.bytes;
  }

  private putCached(key: string, entry: { expires: number; bytes: number; meta: PackageMetadata }): void {
    this.metadataCache.set(key, entry);
    this.metadataCacheTotal += entry.bytes;
  }

  /** Caches `meta`, least recently used evicted first, within both the entry
   *  and the byte budget. An entry larger than the whole byte budget is not
   *  cached at all. A live entry that can render is not replaced by one that
   *  cannot. */
  private cacheMetadata(key: string, meta: PackageMetadata): void {
    const now = this.now().getTime();
    for (const [cachedKey, entry] of this.metadataCache) {
      if (entry.expires <= now) this.dropCached(cachedKey);
    }
    const existing = this.metadataCache.get(key);
    if (existing && meta.raw === undefined && existing.meta.raw !== undefined) return;
    this.dropCached(key);
    const bytes = metadataBytes(meta);
    if (bytes > this.metadataCacheBytes) return;
    while (
      this.metadataCache.size > 0 &&
      (this.metadataCache.size >= this.metadataCacheEntries ||
        this.metadataCacheTotal + bytes > this.metadataCacheBytes)
    ) {
      this.dropCached(this.metadataCache.keys().next().value as string);
    }
    this.putCached(key, { expires: now + this.metadataTtlMs, bytes, meta });
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
    const now = this.now().getTime();
    for (const [runId, stale] of this.tallies) if (stale.deadline <= now) this.releaseRun(runId);
    let tally = this.tallies.get(context.runId);
    if (!tally) {
      tally = { deadline: context.deadlineAt.getTime() };
      this.tallies.set(context.runId, tally);
      this.scheduleRelease(context.runId, tally);
    }
    return tally;
  }

  /** Releases a run's in-process state when its deadline passes, whether or
   *  not any other request ever arrives: the timer does not keep the process
   *  alive. */
  private scheduleRelease(runId: string, tally: RunTally): void {
    const delay = Math.min(Math.max(0, tally.deadline - this.now().getTime()), MAX_TIMER_MS);
    tally.timer = setTimeout(() => {
      if (this.tallies.get(runId) !== tally) return;
      if (tally.deadline <= this.now().getTime()) this.releaseRun(runId);
      else this.scheduleRelease(runId, tally);
    }, delay);
    tally.timer.unref?.();
  }

  /** Drops a run's tally and graph walks, and stops any walk still running. */
  private releaseRun(runId: string): void {
    const tally = this.tallies.get(runId);
    if (!tally) return;
    this.tallies.delete(runId);
    clearTimeout(tally.timer);
    for (const walk of tally.graphs?.values() ?? []) walk.released = true;
    tally.graphs?.clear();
  }

  /** Releases every run's in-process state (timers included), e.g. when the
   *  server shuts down. */
  close(): void {
    for (const runId of [...this.tallies.keys()]) this.releaseRun(runId);
  }

  /** Records a refused row, at most `maxRefusalRecords` per run so a worker
   *  hammering refused names cannot grow the table (or get_run and the PR
   *  body) without bound. Callers still return the refusal's error. */
  private async refuse(
    context: RegistryRunContext,
    adapter: RegistryAdapter,
    name: string,
    reason: string,
    file?: Pick<FileRef, "version" | "filename">,
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
