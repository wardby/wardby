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
import { logger } from "../../../core/logger.js";
import { matchRoot, parseAllowlist, resolvePolicy } from "../../../coding/registry/allowlist.js";
import type { AuditAdvisory, AuditRelation, PackageAuditVerdict } from "../../../coding/registry/audit-mode.js";
import {
  acceptedAdvisoriesReason,
  LISTING_REFUSAL_FILENAME,
  PLAN_REFUSAL_FILENAME,
} from "../../../coding/registry/report.js";
import {
  GRAPH_INCOMPLETE,
  GRAPH_LIMIT,
  graphIncompleteMessage,
  graphLimitMessage,
  notAllowedMessage,
  notAllowedPendingMessage,
  PACKAGE_NOT_ALLOWED,
  PACKAGE_NOT_ALLOWED_PENDING,
  refusalHint,
  type WalkProgress,
} from "../../../coding/registry/refusal-hints.js";
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
  type ParsedLockfile,
  type RegistryAdapter,
  type RegistryRoute,
  type UpstreamFetch,
} from "../../../coding/registry/types.js";
import { capabilityHash } from "../proxy.js";
import type { OsvAudit } from "./audit.js";
import { DEPENDENCY_CACHE_ECOSYSTEM, MAX_DEPENDENCY_CACHE_LOCK_HASHES, sha256Hex } from "../dependency-cache/key.js";
import { boundedMetadataFetch, DEFAULT_MAX_METADATA_BYTES, DEFAULT_METADATA_TIMEOUT_MS } from "./bounded-fetch.js";
import { parseLockfileOffThread } from "./lockfile-parse.js";
import { DEFAULT_PLAN_MAX_ENTRIES, DEFAULT_PLAN_TIMEOUT_MS, verifyLockfilePlan, type PlanRefusal } from "./plan.js";
import { AUDITED_VIA_UNKNOWN, type RegistryRunContext, type RegistryStore } from "./store.js";

const registryLog = logger.child({ module: "coding-registry" });

/** Server-side record of a registry failure. The worker only ever sees the
 *  RegistryError's code and message; the operator needs the cause. Without
 *  this, a proxy database role missing its grants (permission denied) was
 *  indistinguishable from an upstream outage: an unlogged 502 to npm or pip.
 *  Expected refusals (4xx) stay unlogged here: they are recorded per run. */
function logRegistryFailure(route: "handle" | "plan" | "refusals", ecosystem: string, error: unknown): void {
  if (error instanceof RegistryError) {
    if (error.status >= 500) {
      registryLog.warn(
        {
          event: "registry.unavailable",
          route,
          ecosystem,
          status: error.status,
          code: error.code,
          reason: error.message,
        },
        "coding registry could not answer",
      );
    }
    return;
  }
  registryLog.error({ event: "registry.failed", route, ecosystem, err: error }, "coding registry request failed");
}

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
const GRAPH_WALK_CONCURRENCY = 2;
/** Graph-walk expansions in flight at once across every run, so one run's
 *  walk cannot starve the others' upstream fetches -- or the proxy's event
 *  loop: parsing packuments is CPU work on the same loop that carries model
 *  traffic (per-walk 2 and global 3 since a live install at 4/6 on 500m
 *  expired a ledger transaction). The walk is only the fallback now: a
 *  download of a version the run has not resolved starts one (and a
 *  metadata miss, only after a failed or partial lockfile plan), and
 *  lockfile verification answers most of those without it. */
export const DEFAULT_MAX_GRAPH_CONCURRENCY = 3;
/** Byte budget of the graph walk's memo of expanded packages (kept
 *  versions and their declared dependencies), across every run. */
export const DEFAULT_GRAPH_MEMO_BYTES = 32 * 1024 * 1024;
/** How long a memoized expansion is reused. Safe for that long: a kept
 *  version depends on the release-age cutoff, which only moves forward (a
 *  stale entry can only omit a version that has since become old enough,
 *  which fails closed), and on the OSV audit, which is itself cached for an
 *  hour (audit.ts). The walk's view of advisories can therefore lag by the
 *  audit cache TTL plus 15 minutes; that only affects which names the walk
 *  allows, because every served version is re-audited through keptVersions
 *  and malware is never allowed. A version published upstream within the TTL is
 *  too new to be kept under any non-zero minReleaseAgeDays; with
 *  minReleaseAgeDays 0 it is omitted until the entry expires (fails
 *  closed). */
export const GRAPH_MEMO_TTL_MS = 15 * 60_000;
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
/** Lockfile plans read and verified at once across every run: with the
 *  20 MiB body cap, this bounds the lockfile text held at once. */
export const DEFAULT_PLAN_CONCURRENCY = 2;
/** Lockfile plans one run may make (REGISTRY_PLAN_MAX_PER_RUN). */
export const DEFAULT_PLAN_MAX_PER_RUN = 20;
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
 *  computed once and shared by every edge that reaches it (a popular
 *  package is reached under many distinct ranges, over many requests).
 *  Deliberately not the PackageMetadata: a walk may reach thousands of
 *  packages, and holding each one's metadata would bypass the metadata
 *  cache's bounds. */
type KeptPackage = ReadonlyMap<string, readonly DependencySpec[]>;

/** Approximate retained size of a memoized expansion, for the memo's byte
 *  budget. Deliberately generous. */
function keptBytes(key: string, kept: KeptPackage): number {
  let bytes = 128 + 2 * key.length;
  for (const [version, dependencies] of kept) {
    bytes += 64 + 2 * version.length;
    for (const spec of dependencies) bytes += 48 + 2 * (spec.name.length + spec.range.length);
  }
  return bytes;
}

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
/** How a walk ended, with its progress and (on a timeout) the names with an
 *  unexpanded edge, both taken the moment it stopped: a request waiting on
 *  this walk reads them from here, because by the time it resumes another
 *  miss may already have started the next walk and taken its first batch
 *  off the queue. */
interface WalkResult {
  end: WalkEnd;
  progress: WalkProgress;
  frontier?: ReadonlySet<string>;
}

/** One run's on-demand walk of its approved dependency graph for one
 *  ecosystem, started by a download (or, after a failed or partial lockfile
 *  plan, by a metadata miss),
 *  range-aware: breadth first (by package) from the allowlist's
 *  exact roots, following each declared dependency `name@range` only into
 *  that dependency's kept versions satisfying the range, and from those
 *  versions only. It is resumable (a walk stops as soon as it finds the
 *  name it was started for, and a later miss continues from where it
 *  stopped), single-flight (`running`), and memoized for the run (a miss
 *  once nothing is pending needs no upstream call). */
interface GraphWalk {
  /** Every name proven part of the graph: the exact roots, plus each
   *  package with at least one kept version inside a range an expanded
   *  version declared. Every non-root name here has been written to the
   *  store as an allowance. */
  found: Set<string>;
  /** Names with pending edges, in breadth-first order (each once). */
  order: string[];
  /** Edges not yet expanded, per name: a package's node takes all of them
   *  at once. A name is in `order` exactly when it is here. */
  pending: Map<string, GraphEdge[]>;
  /** Every edge ever queued (`name\0range`), so each is expanded once. */
  seen: Set<string>;
  /** Versions whose dependencies were already followed, per package, so
   *  a version reached through several ranges is expanded once. Its size
   *  is the number of packages walked (bounded by maxGraphPackages). */
  expandedVersions: Map<string, Set<string>>;
  /** The package bound tripped: the graph is incomplete for good. */
  exhausted: boolean;
  /** Failed attempts per package (a node's metadata and audit are the
   *  package's, whatever range reached it), across the run. */
  attempts: Map<string, number>;
  /** Packages whose node could not be expanded (transient upstream or
   *  audit failure), with the edges waiting on them, retried by a later
   *  walk while attempts remain. While any is here, a name not found is
   *  "unavailable", never "not allowed". */
  failed: Map<string, { edges: GraphEdge[]; cause: NodeFailure }>;
  running?: Promise<WalkResult>;
  /** Set when the run's state is released (its deadline passed): a walk
   *  still running stops at its next batch instead of holding its state
   *  until the graph timeout. */
  released?: boolean;
  /** Packument loads the run's walks made (memo misses). */
  loads?: number;
}

const edgeKey = (edge: GraphEdge) => `${edge.name}\0${edge.range}`;

/** Whether a parked failure may be retried. */
function retriable(walk: GraphWalk, name: string): boolean {
  return (walk.attempts.get(name) ?? 0) < MAX_GRAPH_NODE_ATTEMPTS;
}

/** Names with an edge the walk has not expanded yet: pending, or parked in
 *  `failed` with attempts left. Read only between batches (a running
 *  batch is off the queue). */
function unexpandedNames(walk: GraphWalk): Set<string> {
  const names = new Set(walk.pending.keys());
  for (const name of walk.failed.keys()) if (retriable(walk, name)) names.add(name);
  return names;
}

/** Packages walked so far, and the distinct names with an unexpanded edge
 *  that are not yet expanded themselves (a further edge to an expanded
 *  package adds no new package). */
function walkProgress(walk: GraphWalk): WalkProgress {
  const queued = unexpandedNames(walk);
  for (const name of walk.expandedVersions.keys()) queued.delete(name);
  return { walked: walk.expandedVersions.size, queued: queued.size };
}

/** Unexpanded edges, for the progress log. */
function unexpandedEdgeCount(walk: GraphWalk): number {
  let count = 0;
  for (const edges of walk.pending.values()) count += edges.length;
  for (const [name, entry] of walk.failed) if (retriable(walk, name)) count += entry.edges.length;
  return count;
}

/** Adds edges to `name`'s pending group (at the end of the order, or at
 *  the front with `first`). */
function addPending(walk: GraphWalk, name: string, edges: readonly GraphEdge[], first = false): void {
  const group = walk.pending.get(name);
  if (group) {
    group.push(...edges);
    if (first) moveToFront(walk, name);
    return;
  }
  walk.pending.set(name, [...edges]);
  if (first) walk.order.unshift(name);
  else walk.order.push(name);
}

function moveToFront(walk: GraphWalk, name: string): void {
  const index = walk.order.indexOf(name);
  if (index <= 0) return;
  walk.order.splice(index, 1);
  walk.order.unshift(name);
}

/** `cutShort`: the walk stopped (its time ran out, or the package bound
 *  tripped) before it either found the name or expanded the whole graph,
 *  so whether the name is in the graph is unknown. On a timeout,
 *  `frontier` says whether the name is already declared by an expanded
 *  version (only its own versions are left to check), rather than never
 *  reached at all. */
type GraphAnswer =
  | "found"
  | "absent"
  | { cutShort: "timeout"; progress: WalkProgress; frontier: boolean }
  | { cutShort: "limit"; progress: WalkProgress; limit: number }
  | { unavailable: NodeFailure };

/** Discriminated result of one `reader.read()` call in `download`'s stream
 *  loop, folding a rejection (`ok: false`) into the same shape as a
 *  resolution so the pending-read race can be checked once, uniformly. */
type ReadOutcome = { ok: false } | { ok: true; done: true } | { ok: true; done: false; value: Uint8Array };

/** Why a request may proceed: an allowlist root (or none, for an allowance),
 *  and, in a package audit mode run, whether it is audited and how the
 *  package reached the run. */
interface Authorization {
  root: AllowlistEntry | undefined;
  audit?: { relation: AuditRelation; via?: string };
}

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
  /** Lockfile plans the run has started. */
  plans?: number;
  /** Downloads answered from a plan refusal already recorded, so a
   *  retried download records its refusal once. */
  planAnswered?: Set<string>;
  /** Plan refusals already recorded (`ecosystem\0name@version\0code`), so
   *  a lockfile planned again records each refusal once. */
  planRefusals?: Set<string>;
  /** Ecosystems where a lockfile plan of this run failed (any error
   *  answer) or refused an entry. There, the lockfile's packages may have
   *  no allowance (npm re-reads their metadata, or inflates an old
   *  lockfile, in no top-down order), so a metadata miss walks the graph
   *  like a download does. Never cleared for the run. Per proxy process,
   *  like the graph walks. */
  planFallback?: Set<string>;
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
export interface RegistryRefusalsRequest {
  token: string;
  /** Only refusals recorded at or after this time; the last 15 minutes when absent or invalid. */
  since?: Date;
}

/** The most refusals `GET /registry/-/refusals` returns (distinct, newest first). */
export const MAX_LISTED_REFUSALS = 20;
const DEFAULT_REFUSALS_WINDOW_MS = 15 * 60_000;

export interface RegistryPlanRequest {
  ecosystem: string;
  token: string;
  /** Reads the lockfile (at most MAX_PLAN_BODY_BYTES). Called only once the
   *  token is authenticated and a plan slot is held, so an unauthenticated
   *  or queued request never has its body buffered. Throws a RegistryError
   *  (413 or 400) for a body it cannot read. */
  readBody(): Promise<string>;
  signal: AbortSignal;
}

function contentTypeOf(route: DownloadRoute | FileMetadataRoute): string {
  return route.kind === "file-metadata" ? "text/plain" : "application/octet-stream";
}

/**
 * Why kept versions leave nothing to download, or null when some file is
 * servable: every allowed file newer than the release-age limit
 * (`wardby_version_filtered`), or no allowed file at all, such as a Python
 * package with only source distributions (`wardby_file_not_allowed`).
 */
export function unservableReason(meta: PackageMetadata, keep: ReadonlySet<string>, keptFiles: ReadonlySet<string>) {
  let anyFile = false;
  let anyAllowed = false;
  for (const version of keep) {
    for (const file of meta.versions.get(version)?.files ?? []) {
      anyFile = true;
      if (!file.allowed) continue;
      if (keptFiles.has(file.filename)) return null;
      anyAllowed = true;
    }
  }
  if (anyAllowed) return "wardby_version_filtered";
  return anyFile ? "wardby_file_not_allowed" : null;
}

export function errorResponse(error: RegistryError): Extract<RegistryResponse, { body: string }> {
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
    return !entry.wildcard && entry.range === undefined && entry.extras === undefined && entry.name === name;
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
  /** Expanded packages of the graph walks (`runId\0ecosystem\0name`),
   *  least recently used first, so a package reached again under a new
   *  range, in a later request of the same run, is not read again.
   *  Run-scoped by key: a package's kept versions depend on the run's
   *  policy and allowlist range. Bounded to `graphMemoBytes`; entries
   *  expire GRAPH_MEMO_TTL_MS after they are computed, and a run's entries
   *  are dropped when the run is released. */
  private readonly graphMemo = new Map<string, { expires: number; bytes: number; kept: KeptPackage }>();
  /** Sum of the memo entries' `bytes`. */
  private graphMemoTotal = 0;
  private readonly graphMemoBytes = DEFAULT_GRAPH_MEMO_BYTES;
  private readonly walkSlots: Slots;
  private readonly planSlots: Slots;
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
       *  (default 3). */
      maxGraphConcurrency?: number;
      /** Entries a lockfile plan may have (default 5000). */
      planMaxEntries?: number;
      /** Time one lockfile plan may take (default 120 s). */
      planTimeoutMs?: number;
      /** Time reading one pnpm or yarn lockfile (in a worker thread) may
       *  take (default 15 s). */
      planParseTimeoutMs?: number;
      /** Lockfile plans read and verified at once across every run (default 2). */
      planConcurrency?: number;
      /** Lockfile plans one run may make (default 20). */
      planMaxPerRun?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.walkSlots = new Slots(options.maxGraphConcurrency ?? DEFAULT_MAX_GRAPH_CONCURRENCY);
    this.planSlots = new Slots(options.planConcurrency ?? DEFAULT_PLAN_CONCURRENCY);
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

  /**
   * `GET /registry/-/refusals`: the run's recent refusals (package, code and the
   * shared hint), for a client that does not print the registry's 403 body
   * (pip, uv). Authenticated with the run's registry token. Names come from the
   * run's own requests; nothing else (no URL, no token) is returned.
   */
  async refusals(request: RegistryRefusalsRequest): Promise<Extract<RegistryResponse, { body: string }>> {
    try {
      const context = await this.options.store.findRunByRegistryTokenHash(capabilityHash(request.token), this.now());
      if (!context)
        throw new RegistryError(401, "invalid_capability", "the registry token is not valid for a live run");
      const since =
        request.since && !Number.isNaN(request.since.getTime())
          ? request.since
          : new Date(this.now().getTime() - DEFAULT_REFUSALS_WINDOW_MS);
      const rows = await this.options.store.listRecentRefusals(context.runId, since, MAX_LISTED_REFUSALS * 5);
      const seen = new Set<string>();
      const refusals: { ecosystem: string; name: string; version?: string; code: string; hint?: string }[] = [];
      for (const row of rows) {
        const code = row.reason ?? "wardby_refused";
        const key = `${row.ecosystem}\0${row.name}\0${row.version ?? ""}\0${code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const hint = refusalHint(code);
        refusals.push({
          ecosystem: row.ecosystem,
          name: row.name,
          ...(row.version ? { version: row.version } : {}),
          code,
          ...(hint ? { hint } : {}),
        });
        if (refusals.length >= MAX_LISTED_REFUSALS) break;
      }
      return { status: 200, contentType: "application/json", body: JSON.stringify({ refusals }) };
    } catch (error) {
      logRegistryFailure("refusals", "-", error);
      if (error instanceof RegistryError) return errorResponse(error);
      return errorResponse(new RegistryError(502, "wardby_upstream_error", "the package registry request failed"));
    }
  }

  /** `POST /registry/<ecosystem>/-/plan`: verifies a lockfile against the
   *  registry and approves exactly its verified, reachable name@version
   *  pairs for the run (plan.ts). Answers `{ approved, refused }`. */
  async plan(request: RegistryPlanRequest): Promise<RegistryResponse> {
    try {
      return await this.planLockfile(request);
    } catch (error) {
      logRegistryFailure("plan", request.ecosystem, error);
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
    try {
      return await this.runPlan(request, adapter, support, auditVersions, context, tally);
    } catch (error) {
      (tally.planFallback ??= new Set()).add(adapter.id);
      throw error;
    }
  }

  private async runPlan(
    request: RegistryPlanRequest,
    adapter: RegistryAdapter,
    support: LockfilePlanSupport,
    auditVersions: OsvAudit["auditVersions"],
    context: RegistryRunContext,
    tally: RunTally,
  ): Promise<RegistryResponse> {
    if (tally.planning)
      throw new RegistryError(
        429,
        "wardby_plan_in_progress",
        "a lockfile plan is already running for this run; wait for it to finish",
      );
    const maxPlans = this.options.planMaxPerRun ?? DEFAULT_PLAN_MAX_PER_RUN;
    if ((tally.plans ?? 0) >= maxPlans)
      throw new RegistryError(
        429,
        "wardby_plan_limit",
        `this run has made its ${maxPlans} lockfile plans (REGISTRY_PLAN_MAX_PER_RUN)`,
      );
    tally.planning = true;
    tally.plans = (tally.plans ?? 0) + 1;
    try {
      // The body is read only while a slot is held: a queued plan holds no
      // lockfile text, and at most `planConcurrency` bodies exist at once.
      return await this.planSlots.run(async () => {
        const body = await request.readBody();
        // The dependency cache's lockHash: computed here, from the bytes the
        // proxy itself verified, never from anything a client claims.
        const lockHash = context.dependencyCache && adapter.id === DEPENDENCY_CACHE_ECOSYSTEM ? sha256Hex(body) : null;
        const parseOptions = {
          maxEntries: this.options.planMaxEntries ?? DEFAULT_PLAN_MAX_ENTRIES,
          proxyRegistryUrl: `${this.options.proxyBase}${adapter.id}/`,
        };
        // A YAML or yarn lockfile is read in a worker thread with a time
        // bound (lockfile-parse.ts); npm's JSON stays on the event loop.
        const lockfile = support.parsesOffThread?.(body)
          ? await parseLockfileOffThread(adapter.id, body, parseOptions, {
              timeoutMs: this.options.planParseTimeoutMs,
              signal: request.signal,
            })
          : support.parse(body, parseOptions);
        return this.verifyPlan(request, adapter, support, lockfile, auditVersions, context, lockHash);
      });
    } finally {
      tally.planning = false;
    }
  }

  private async verifyPlan(
    request: RegistryPlanRequest,
    adapter: RegistryAdapter,
    support: LockfilePlanSupport,
    lockfile: ParsedLockfile,
    auditVersions: OsvAudit["auditVersions"],
    context: RegistryRunContext,
    lockHash: string | null,
  ): Promise<RegistryResponse> {
    const entries = parseAllowlist(context.allowlist, this.options.adapters).get(adapter.id) ?? [];
    const { minReleaseAgeDays, acceptedAdvisories } = resolvePolicy(context.policy);
    const timeoutMs = this.options.planTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), request.signal]);
    const store = this.options.store;
    let result;
    try {
      result = await verifyLockfilePlan({
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
        accepted: new Set(acceptedAdvisories),
        auditMode: context.packageAudit,
        hostAllowed: (url) => this.hostAllowed(adapter, url),
        signal,
      });
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
    // An approved name is proven part of the approved graph, so it is an
    // allowance too: its metadata (which npm re-reads for packages already
    // in the lockfile) is served without a graph walk. Written before the
    // approvals: a name allowance left behind by a failed approval write is
    // only what a walk would conclude.
    // In package audit mode an approval outside the allowlist is an audited
    // allowance, tagged with the top-level audited package that brought it
    // (one of unknown relation with AUDITED_VIA_UNKNOWN, never itself).
    const plain = result.approved.filter((v) => !v.audit || v.audit.relation === "allowed");
    await store.addAllowances(context.runId, adapter.id, [...new Set(plain.map((v) => v.name))]);
    const byVia = new Map<string, Set<string>>();
    for (const v of result.approved) {
      if (!v.audit || v.audit.relation === "allowed") continue;
      const via = v.audit.relation === "unknown" ? AUDITED_VIA_UNKNOWN : (v.audit.via ?? v.name);
      byVia.set(via, (byVia.get(via) ?? new Set()).add(v.name));
    }
    for (const [via, names] of byVia) await store.addAuditedAllowances(context.runId, adapter.id, [...names], via);
    // A registry whose approvals are names (PyPI) keeps every download on the
    // usual per-file path: no exact version is served from an approval.
    if (support.approves !== "names") await store.approveVersions(context.runId, adapter.id, result.approved);
    // A plan that refused anything leaves some lockfile packages without an
    // allowance: metadata misses walk for the rest of the run.
    if (result.refused.length > 0) (this.tally(context).planFallback ??= new Set()).add(adapter.id);
    // Only verdicts about the registry's name@version itself answer later
    // downloads; a lockfile-dependent one (unreachable, an integrity or
    // source the lockfile claims) must not block the same version reached
    // another way, so those downloads take the usual path.
    await store.refusePlanVersions(
      context.runId,
      adapter.id,
      result.refused
        .filter((refusal) => refusal.intrinsic)
        .map(({ name, version, code, reason, publishedAt }) => ({ name, version, code, reason, publishedAt })),
    );
    await this.recordPlanRefusals(context, adapter, result.refused);
    // Only a lockfile approved whole may be restored from the dependency
    // cache; the store ignores it once the session is sealed or full. A plan
    // that audited anything is never cached: a restore downloads nothing,
    // so nothing it installs would be recorded.
    if (lockHash && result.refused.length === 0 && result.audited === 0)
      await store.recordDependencyCacheLockHash(context.runId, lockHash, MAX_DEPENDENCY_CACHE_LOCK_HASHES);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        approved: result.approved.length,
        refused: result.refused.map(({ name, version, code, reason }) => ({ name, version, code, reason })),
        ...(context.packageAudit ? { audited: result.audited } : {}),
      }),
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
      logRegistryFailure("handle", request.ecosystem, error);
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
        // The plan's waiver (if any) is recorded on the served row, and its
        // audit verdict (audit-mode plans only) as the run's audit record.
        return this.download(
          adapter,
          context,
          name,
          route,
          file,
          request.signal,
          acceptedAdvisoriesReason(approved.acceptedAdvisories),
          approved.audit,
        );
      }
      // A version the plan definitively refused is answered from the plan,
      // with its code and reason: no metadata, no graph walk.
      const refused = approved
        ? null
        : await this.options.store.findPlanRefusal(context.runId, adapter.id, name, route.version);
      // A too-new refusal lapses once the version is old enough: the
      // release-age cutoff moves with time.
      const cutoff = this.now().getTime() - resolvePolicy(context.policy).minReleaseAgeDays * DAY_MS;
      if (refused && (refused.publishedAt === null || refused.publishedAt.getTime() > cutoff)) {
        const tally = this.tally(context);
        tally.planAnswered ??= new Set();
        const key = `${adapter.id}\0${name}@${route.version}\0${refused.code}`;
        if (!tally.planAnswered.has(key)) {
          tally.planAnswered.add(key);
          await this.refuse(context, adapter, name, refused.code, { version: route.version, filename: route.filename });
        }
        throw new RegistryError(
          403,
          refused.code,
          `"${name}" ${route.version} was refused by this run's lockfile verification: ${refused.reason}`,
        );
      }
    }
    const { root, audit } = await this.authorize(adapter, context, name, route.kind);
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
    let waivers: Map<string, readonly string[]>;
    let auditAdvisories: Map<string, AuditAdvisory[]>;
    try {
      ({ keep, keptFiles, waivers, auditAdvisories } = await this.keptVersions(adapter, context, meta, root));
    } catch (error) {
      // Every refusal gets a row, including one the run never chose: the
      // audit being unreachable (fail-closed) still stops this request.
      if (error instanceof RegistryError && error.code === "wardby_audit_unavailable") {
        await this.refuse(context, adapter, name, "wardby_audit_unavailable");
      }
      throw error;
    }

    if (route.kind === "metadata" && route.version !== undefined) {
      // One version's document: the same checks as the whole package's,
      // narrowed to that version.
      const document = keep.has(route.version)
        ? (adapter.renderVersion?.(meta, route.version, keptFiles, `${this.options.proxyBase}${adapter.id}/`) ?? null)
        : null;
      if (!document) {
        await this.refuse(context, adapter, name, "wardby_version_filtered", {
          version: route.version,
          filename: `${route.version}.tgz`,
        });
        throw new RegistryError(
          404,
          "wardby_version_filtered",
          `"${name}" ${route.version} is outside the allowlisted range, newer than the release-age limit, has a high-severity advisory, or is not published`,
        );
      }
      await this.allowServed(context, adapter, name, keptDependencies(adapter, meta, new Set([route.version])), audit);
      return { status: 200, contentType: document.contentType, body: document.body };
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
      await this.allowServed(context, adapter, name, keptDependencies(adapter, meta, keep), audit);
      // Versions kept but no file the client may download: a Python package
      // published only as an sdist, or whose every wheel is newer than the
      // release-age limit. The (empty) index is still served, and pip and uv
      // only say "no versions", so the refusal is recorded to say why, marked
      // as a listing's: the installer may not have needed it (see
      // LISTING_REFUSAL_FILENAME for how it counts).
      const unservable = unservableReason(meta, keep, keptFiles);
      if (unservable) await this.refuse(context, adapter, name, unservable, { filename: LISTING_REFUSAL_FILENAME });
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
      // A download that does not resolve is still a refusal of the version asked for, not of the whole
      // name (which any version served later would clear; see summarizeRegistryFetches).
      await this.refuse(
        context,
        adapter,
        name,
        "wardby_version_filtered",
        file ?? (route.kind === "download" ? { version: route.version, filename: route.filename } : undefined),
      );
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
    // A version kept only by waiving accepted advisories records them on
    // its served row. In package audit mode, a package outside the
    // allowlist, or a version kept only past advisories (full), is recorded
    // as the run's audit record.
    const advisories = auditAdvisories.get(file.version) ?? [];
    const verdict: PackageAuditVerdict | undefined = audit
      ? { ...audit, ...(advisories.length > 0 ? { advisories } : {}) }
      : advisories.length > 0
        ? { relation: "allowed", advisories }
        : undefined;
    return this.download(
      adapter,
      context,
      name,
      route,
      file,
      request.signal,
      acceptedAdvisoriesReason(waivers.get(file.version) ?? []),
      verdict,
    );
  }

  /** The allowances serving a package's metadata grows: its kept versions'
   *  dependencies, and, for an audited package, each tagged with the
   *  top-level audited package that declared it (its own name for a
   *  top-level one, which is also recorded for itself so its later
   *  downloads read as top-level). */
  private async allowServed(
    context: RegistryRunContext,
    adapter: RegistryAdapter,
    name: string,
    dependencies: readonly string[],
    audit: Authorization["audit"],
  ): Promise<void> {
    const store = this.options.store;
    if (!audit) return store.addAllowances(context.runId, adapter.id, dependencies);
    if (audit.relation === "top-level") await store.addAuditedAllowances(context.runId, adapter.id, [name], name);
    await store.addAuditedAllowances(context.runId, adapter.id, dependencies, audit.via ?? name);
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
    kind: RegistryRoute["kind"],
  ): Promise<Authorization> {
    const entries = parseAllowlist(context.allowlist, this.options.adapters).get(adapter.id) ?? [];
    // A root keeps its own range in every mode: audit mode never serves a
    // version an entry's range excludes (keptVersions applies root.range).
    const root = matchRoot(entries, name);
    if (root) return { root };
    const allowance = await this.options.store.findAllowance(context.runId, adapter.id, name);
    if (allowance) {
      if (allowance.auditedVia === null) return { root: undefined };
      if (allowance.auditedVia === AUDITED_VIA_UNKNOWN) return { root: undefined, audit: { relation: "unknown" } };
      return allowance.auditedVia === name
        ? { root: undefined, audit: { relation: "top-level" } }
        : { root: undefined, audit: { relation: "transitive", via: allowance.auditedVia } };
    }
    if (context.packageAudit) {
      // Package audit mode: a miss is never refused and never walks; it is
      // served (through every other check) and recorded. A download with
      // no metadata first, or a metadata miss once a lockfile plan of the
      // run fell back, cannot say how the package reached the run.
      const fellBack = this.tally(context).planFallback?.has(adapter.id) ?? false;
      return { root: undefined, audit: { relation: kind === "download" || fellBack ? "unknown" : "top-level" } };
    }
    // A package manager resolves top-down: it reads a parent's metadata,
    // which records the parent's declared dependencies as allowances,
    // before it asks for a child. A metadata request for a name that is
    // neither a root nor an allowance is therefore refused at once, unless
    // a lockfile plan of this run failed or refused an entry (then the
    // lockfile's packages may lack allowances, and the miss walks).
    if (kind !== "download" && !this.tally(context).planFallback?.has(adapter.id)) {
      await this.refuse(context, adapter, name, PACKAGE_NOT_ALLOWED);
      throw new RegistryError(403, PACKAGE_NOT_ALLOWED, notAllowedMessage(name, adapter.id, entries.length > 0));
    }
    // A download (or, after a failed or partial plan, a metadata request)
    // that is not yet an allowance: the name may still be in the approved
    // graph, unrecorded only because the client never asked for its
    // parent's metadata (a lockfile install requests tarballs directly).
    // Resolve the graph before refusing.
    const graph = await this.resolveInGraph(adapter, context, entries, name);
    if (graph === "found") return { root: undefined };
    if (typeof graph === "object" && "cutShort" in graph) {
      if (graph.cutShort === "limit") {
        // The bound is permanent for the rest of the run, so a retry can
        // never succeed: answer with a definitive 4xx (npm does not retry
        // it) rather than a 503 that a client or agent would retry forever.
        // Still not "not allowed": the name was not proven absent.
        await this.refuse(context, adapter, name, GRAPH_LIMIT);
        throw new RegistryError(403, GRAPH_LIMIT, graphLimitMessage(name, adapter.id, graph.limit));
      }
      if (graph.frontier) {
        // An expanded version declares the name and only its own versions
        // are left to check: the walk resumes there on the next miss, so a
        // retry (npm retries a 5xx on its own) can find it.
        await this.refuse(context, adapter, name, GRAPH_INCOMPLETE);
        throw new RegistryError(503, GRAPH_INCOMPLETE, graphIncompleteMessage(name, adapter.id, graph.progress));
      }
      // The walk never reached the name. Not proven absent, so not the
      // final "not allowed", but definite (a 4xx npm does not retry): a
      // later miss may still resume the walk and find it, which is no
      // reason to keep the agent waiting on retries now.
      await this.refuse(context, adapter, name, PACKAGE_NOT_ALLOWED_PENDING);
      throw new RegistryError(
        403,
        PACKAGE_NOT_ALLOWED_PENDING,
        notAllowedPendingMessage(name, adapter.id, graph.progress),
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
    await this.refuse(context, adapter, name, PACKAGE_NOT_ALLOWED);
    throw new RegistryError(403, PACKAGE_NOT_ALLOWED, notAllowedMessage(name, adapter.id, entries.length > 0));
  }

  /** Whether `name` is in the run's approved graph for this ecosystem:
   *  the allowlist's exact roots plus the dependencies of every kept
   *  version (the same filter the metadata path applies: root range,
   *  release age, advisories), transitively. Each newly found name is
   *  recorded as an allowance as the walk goes, exactly as if its
   *  parent's metadata had been served. Only a download asks, or a
   *  metadata miss after a failed or partial lockfile plan (see
   *  `authorize`). A scoped wildcard root cannot be enumerated, so it is
   *  never a starting point. */
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
        order: [],
        pending: new Map(),
        seen: new Set(edges.map(edgeKey)),
        expandedVersions: new Map(),
        exhausted: false,
        attempts: new Map(),
        failed: new Map(),
      };
      for (const edge of edges) addPending(walk, edge.name, [edge]);
      tally.graphs.set(adapter.id, walk);
    }
    const current = walk;
    let started = false;
    for (;;) {
      if (current.found.has(name)) return "found";
      if (current.exhausted)
        return {
          cutShort: "limit",
          progress: walkProgress(current),
          limit: this.options.maxGraphPackages ?? DEFAULT_MAX_GRAPH_PACKAGES,
        };
      // Single-flight: a miss while a walk is running waits for it rather
      // than starting a second one, then re-checks (that walk may have
      // stopped on finding a different name). Checked before the queue: a
      // running walk has taken its current batch off the queue, so an
      // empty queue alone does not mean the graph is complete. Each miss
      // starts at most one walk of its own, so it spends at most one
      // round of retries on failed nodes.
      if (!current.running) {
        const anyRetriable = [...current.failed.keys()].some((key) => retriable(current, key));
        if (started || (current.pending.size === 0 && !anyRetriable)) return this.graphMiss(current);
        started = true;
        current.running = this.walkGraph(adapter, context, entries, current, name).finally(() => {
          current.running = undefined;
        });
      }
      const result = await current.running;
      // Read from the walk's own snapshot, never from the live walk: a
      // miss in the meantime may have started the next walk already.
      if (result.end === "timeout" && !current.found.has(name))
        return { cutShort: "timeout", progress: result.progress, frontier: result.frontier?.has(name) ?? false };
    }
  }

  /** The answer for a name the walk did not find: unavailable while any
   *  node could not be expanded (the audit, if any failure was the
   *  audit's), otherwise absent. */
  private graphMiss(walk: GraphWalk): GraphAnswer {
    if (walk.failed.size === 0) return "absent";
    return { unavailable: [...walk.failed.values()].some((entry) => entry.cause === "audit") ? "audit" : "upstream" };
  }

  /** One walk, logged once when it stops, with its progress (and, on a
   *  timeout, its frontier) taken before `running` is cleared. */
  private async walkGraph(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    entries: readonly AllowlistEntry[],
    walk: GraphWalk,
    target: string,
  ): Promise<WalkResult> {
    const startedAt = this.now().getTime();
    const loadsBefore = walk.loads ?? 0;
    const end = await this.expandGraph(adapter, context, entries, walk, target);
    const progress = walkProgress(walk);
    registryLog.info(
      {
        event: "registry.graph_walk",
        runId: context.runId,
        ecosystem: adapter.id,
        end,
        walked: progress.walked,
        queued: progress.queued,
        queuedEdges: unexpandedEdgeCount(walk),
        loads: (walk.loads ?? 0) - loadsBefore,
        durationMs: this.now().getTime() - startedAt,
      },
      "coding registry graph walk stopped",
    );
    return end === "timeout" ? { end, progress, frontier: unexpandedNames(walk) } : { end, progress };
  }

  private async expandGraph(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    entries: readonly AllowlistEntry[],
    walk: GraphWalk,
    target: string,
  ): Promise<WalkEnd> {
    const maxPackages = this.options.maxGraphPackages ?? DEFAULT_MAX_GRAPH_PACKAGES;
    const deadline = this.now().getTime() + (this.options.graphTimeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS);
    // Parked failures with attempts left go first (a later miss is this
    // walk's retry of them), and the requested name before everything:
    // order changes only how soon an answer comes, never which edges are
    // followed or what they allow.
    const retry = [...walk.failed.entries()].filter(([name]) => retriable(walk, name));
    for (const [name] of retry) walk.failed.delete(name);
    for (const [name, entry] of retry.reverse()) addPending(walk, name, entry.edges, true);
    if (walk.pending.has(target)) moveToFront(walk, target);
    const attemptsThisWalk = new Map<string, number>();
    while (walk.pending.size > 0) {
      if (walk.found.has(target)) return "found";
      if (walk.released) return "timeout";
      const remaining = deadline - this.now().getTime();
      if (remaining <= 0) return "timeout";
      const room = maxPackages - walk.expandedVersions.size;
      if (room <= 0) {
        walk.exhausted = true;
        return "limit";
      }
      // Each name adds at most one new package, so a batch no larger than
      // the room left can never overshoot the bound. A name's node takes
      // every edge pending for it.
      const batch = walk.order.splice(0, Math.min(GRAPH_WALK_CONCURRENCY, room)).map((name) => {
        const edges = walk.pending.get(name) ?? [];
        walk.pending.delete(name);
        return { name, edges };
      });
      const expansions = Promise.all(
        batch.map(({ name, edges }) => this.graphNode(adapter, context, entries, name, edges, walk)),
      );
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      });
      const results = await Promise.race([expansions, timedOut]).finally(() => clearTimeout(timer));
      if (results === "timeout") {
        // Not expanded: put the whole batch back, in order, so a later
        // miss retries it (its node is likely memoized by then).
        for (const { name, edges } of [...batch].reverse()) addPending(walk, name, edges, true);
        return "timeout";
      }
      const expanded: { name: string; edges: GraphEdge[]; selected: SelectedVersion[] }[] = [];
      batch.forEach(({ name, edges }, index) => {
        const result = results[index];
        if (result.ok) {
          expanded.push({ name, edges, selected: result.selected });
          return;
        }
        // A transient failure is never counted as expanded: the node is
        // retried (once more in this walk, then by later misses) instead
        // of silently closing its whole subtree for the run.
        walk.attempts.set(name, (walk.attempts.get(name) ?? 0) + 1);
        attemptsThisWalk.set(name, (attemptsThisWalk.get(name) ?? 0) + 1);
        if ((attemptsThisWalk.get(name) ?? 0) < GRAPH_NODE_ATTEMPTS_PER_WALK && retriable(walk, name))
          addPending(walk, name, edges);
        else walk.failed.set(name, { edges, cause: result.cause });
      });
      // A package joins the graph (and gets its allowance) only when some
      // kept version of it satisfies a range that reached it. Recorded
      // before it counts as found, so `found` never holds a name the store
      // would refuse.
      const discovered = expanded
        .filter(({ name, selected }) => selected.length > 0 && !walk.found.has(name))
        .map(({ name }) => name);
      try {
        if (discovered.length > 0) await this.options.store.addAllowances(context.runId, adapter.id, discovered);
      } catch (error) {
        // The store write failed: put the expanded groups back so a later
        // miss re-expands them, rather than leaving the graph silently short.
        for (const { name, edges } of [...expanded].reverse()) addPending(walk, name, edges, true);
        throw error;
      }
      for (const name of discovered) walk.found.add(name);
      for (const { name, selected } of expanded) {
        let versions = walk.expandedVersions.get(name);
        if (!versions) walk.expandedVersions.set(name, (versions = new Set()));
        for (const { version, dependencies } of selected) {
          if (versions.has(version)) continue;
          versions.add(version);
          for (const dependency of dependencies) {
            const key = edgeKey(dependency);
            if (walk.seen.has(key)) continue;
            walk.seen.add(key);
            // A package parked after failing waits with its edges and is
            // retried with them.
            const parked = walk.failed.get(dependency.name);
            if (parked) parked.edges.push(dependency);
            else addPending(walk, dependency.name, [dependency], dependency.name === target);
          }
        }
      }
    }
    return walk.found.has(target) ? "found" : "complete";
  }

  /** The kept versions of one package inside any of the ranges that reached
   *  it, and each one's declared dependencies, through the same metadata
   *  cache and `keptVersions` filter the metadata path uses (a root's
   *  allowlist range applies there), within the process-wide walk
   *  concurrency cap. A `"*"` edge selects every kept version; a range no
   *  kept version satisfies selects none. A package npm doesn't have, or
   *  whose metadata is too large, definitively selects nothing; any other
   *  failure (upstream error or timeout, audit unavailable) is transient
   *  and reported for retry. */
  private graphNode(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    entries: readonly AllowlistEntry[],
    name: string,
    edges: readonly GraphEdge[],
    walk?: GraphWalk,
  ): Promise<NodeResult> {
    return this.walkSlots.run(async (): Promise<NodeResult> => {
      try {
        const keep = await this.keptForGraph(adapter, context, entries, name, walk);
        const ranges = [...new Set(edges.map((edge) => edge.range))];
        const inRange = (version: string) =>
          ranges.some((range) => {
            if (range === "*") return true;
            try {
              return adapter.satisfies(version, range);
            } catch {
              return false;
            }
          });
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

  /** A package's kept versions for the run's walk, from the memo or
   *  computed (and memoized). A failed computation is not memoized, so its
   *  retry really retries. */
  private async keptForGraph(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    entries: readonly AllowlistEntry[],
    name: string,
    walk?: GraphWalk,
  ): Promise<KeptPackage> {
    const key = `${context.runId}\0${adapter.id}\0${name}`;
    const now = this.now().getTime();
    const memoized = this.graphMemo.get(key);
    if (memoized) {
      this.dropMemo(key);
      if (memoized.expires > now) {
        this.putMemo(key, memoized); // most recently used
        return memoized.kept;
      }
    }
    if (walk) walk.loads = (walk.loads ?? 0) + 1;
    const meta = await this.metadata(adapter, name, false);
    const { keep } = await this.keptVersions(adapter, context, meta, matchRoot(entries, name));
    const kept: KeptPackage = new Map(
      [...keep].map((version) => [version, versionDependencies(adapter, meta, version)]),
    );
    // A run released meanwhile (its walk stopped) keeps nothing here.
    if (this.tallies.has(context.runId)) this.memoize(key, kept);
    return kept;
  }

  private dropMemo(key: string): void {
    const entry = this.graphMemo.get(key);
    if (!entry) return;
    this.graphMemo.delete(key);
    this.graphMemoTotal -= entry.bytes;
  }

  private putMemo(key: string, entry: { expires: number; bytes: number; kept: KeptPackage }): void {
    this.graphMemo.set(key, entry);
    this.graphMemoTotal += entry.bytes;
  }

  /** Memoizes an expansion, least recently used evicted first, within the
   *  byte budget. An entry larger than the whole budget is not kept. */
  private memoize(key: string, kept: KeptPackage): void {
    const now = this.now().getTime();
    for (const [memoKey, entry] of this.graphMemo) if (entry.expires <= now) this.dropMemo(memoKey);
    this.dropMemo(key);
    const bytes = keptBytes(key, kept);
    if (bytes > this.graphMemoBytes) return;
    while (this.graphMemo.size > 0 && this.graphMemoTotal + bytes > this.graphMemoBytes)
      this.dropMemo(this.graphMemo.keys().next().value as string);
    this.putMemo(key, { expires: now + GRAPH_MEMO_TTL_MS, bytes, kept });
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
  ): Promise<{
    keep: Set<string>;
    keptFiles: Set<string>;
    waivers: Map<string, readonly string[]>;
    /** Kept version -> the blocking advisories full mode served it past (only non-empty). */
    auditAdvisories: Map<string, AuditAdvisory[]>;
  }> {
    const { minReleaseAgeDays, acceptedAdvisories } = resolvePolicy(context.policy);
    // Package audit mode `full` lets non-malware blocking advisories through;
    // malware is withheld whatever the mode (audit.ts splitWaived).
    const auditAll = context.packageAudit === "full";
    const cutoff = this.now().getTime() - minReleaseAgeDays * DAY_MS;
    // The run's accepted advisories waive the blocking ones they name
    // (never malware); fixed for the run (snapshotted at dispatch).
    const accepted = new Set(acceptedAdvisories);
    const advisories = await this.options.audit.audit(adapter, meta.name);
    const keep = new Set<string>();
    const keptFiles = new Set<string>();
    /** Kept version -> the advisories waived to keep it (only non-empty). */
    const waivers = new Map<string, readonly string[]>();
    const auditAdvisories = new Map<string, AuditAdvisory[]>();
    for (const info of meta.versions.values()) {
      if (root?.range && !adapter.satisfies(info.version, root.range)) continue;
      // Per-file release age: a file with an unknown or too-recent publish
      // time is never listed or served. A version survives if any of its
      // files does.
      const oldEnough = info.files.filter((file) => file.publishedAt && file.publishedAt.getTime() <= cutoff);
      if (oldEnough.length === 0) continue;
      if (advisories.withheld(info.version, accepted, auditAll).length > 0) continue;
      keep.add(info.version);
      if (auditAll) {
        const audited = advisories.audited?.(info.version, accepted) ?? [];
        if (audited.length > 0) auditAdvisories.set(info.version, [...audited]);
      }
      for (const file of oldEnough) keptFiles.add(file.filename);
      if (accepted.size > 0) {
        const waived = advisories.waived(info.version, accepted);
        if (waived.length > 0) waivers.set(info.version, waived);
      }
    }
    return { keep, keptFiles, waivers, auditAdvisories };
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
    const prefix = `${runId}\0`;
    for (const key of [...this.graphMemo.keys()]) if (key.startsWith(prefix)) this.dropMemo(key);
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
    file?: Pick<FileRef, "filename"> & Partial<Pick<FileRef, "version">>,
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

  /** The extras the run allows for `name`: those its allowlist entries name
   *  plus those a served parent's dependency line asked of it. They decide
   *  which of the package's extra-gated dependencies its files allow. */
  private async allowedExtras(adapter: RegistryAdapter, context: RegistryRunContext, name: string): Promise<string[]> {
    const entries = parseAllowlist(context.allowlist, this.options.adapters).get(adapter.id) ?? [];
    const extras = new Set(
      entries.flatMap((entry) => (!entry.wildcard && entry.name === name ? (entry.extras ?? []) : [])),
    );
    for (const extra of await this.options.store.allowedExtras(context.runId, adapter.id, name)) extras.add(extra);
    return [...extras].sort();
  }

  /** One RegistryAuditRecord (the first served file of a version wins) and
   *  its `registry.audited` log line. */
  private async recordAudit(
    context: RegistryRunContext,
    adapter: RegistryAdapter,
    name: string,
    version: string,
    sizeBytes: number,
    audit: PackageAuditVerdict,
  ): Promise<void> {
    const advisories = audit.advisories ?? [];
    await this.options.store.recordAudit({
      runId: context.runId,
      ecosystem: adapter.id,
      name,
      version,
      relation: audit.relation,
      ...(audit.via ? { via: audit.via } : {}),
      sizeBytes,
      advisories,
    });
    registryLog.info(
      {
        event: "registry.audited",
        runId: context.runId,
        ecosystem: adapter.id,
        name,
        version,
        sizeBytes,
        relation: audit.relation,
        ...(audit.via ? { via: audit.via } : {}),
        mode: context.packageAudit,
        advisories: advisories.map((advisory) => advisory.id),
      },
      "coding registry served a package under package audit mode",
    );
  }

  private async download(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    name: string,
    route: DownloadRoute | FileMetadataRoute,
    file: FileRef,
    signal: AbortSignal,
    /** The served row's reason: set only when serving it waived accepted
     *  advisories (`accepted advisories: <ids>`). */
    servedReason?: string,
    /** Set when package audit mode is why it is served: recorded once the
     *  file completes, beside its served row. */
    audit?: PackageAuditVerdict,
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
              ...(servedReason ? { reason: servedReason } : {}),
            });
            // Counted before release() drops the reservation, so no window
            // exists where neither the tally nor inFlight holds this file.
            served.files += 1;
            served.bytes += bytes;
            if (adapter.dependenciesFromFile && buffered.length > 0) {
              const body = Buffer.concat(buffered);
              const extras = await this.allowedExtras(adapter, context, name);
              const dependencies = (await adapter.dependenciesFromFile(route, body, extras).catch(() => [])).map(
                (dependency) => ({ name: adapter.normalizeName(dependency.name), extras: dependency.extras }),
              );
              const names = dependencies.map((dependency) => dependency.name);
              // A file's dependencies are audited too when the package is
              // outside the allowlist (never for one kept only past advisories).
              if (audit && audit.relation !== "allowed") {
                if (audit.relation === "top-level")
                  await store.addAuditedAllowances(context.runId, adapter.id, [name], name);
                await store.addAuditedAllowances(context.runId, adapter.id, names, audit.via ?? name);
              } else await store.addAllowances(context.runId, adapter.id, names);
              // Dependency extras are followed only below a package the run
              // allows with extras (an entry naming extras, or a dependency
              // such a package asked for with extras): a plain entry follows
              // no extras, its own or its dependencies'.
              if (extras.length > 0) await store.addExtraAllowances(context.runId, adapter.id, dependencies);
            }
            // Recorded before the stream closes: a failed write errors it
            // like a failed served row, so nothing is installed unrecorded.
            if (audit) await this.recordAudit(context, adapter, name, file.version, bytes, audit);
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
