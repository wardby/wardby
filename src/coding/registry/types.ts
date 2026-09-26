/**
 * Shared types for the coding package registry: the adapter contract each
 * ecosystem (npm, PyPI, later Composer/RubyGems/Go) implements, and the
 * allowlist entry shape adapters parse into. Everything security-relevant
 * (allowance checks, version filtering, streaming, recording) lives in the
 * registry core, never in an adapter, so a new adapter cannot weaken a
 * safeguard by omission.
 */

/**
 * "npm", "pypi", later "composer", "rubygems", "go". Used as the allowlist
 * key, the route segment (/registry/<id>/), and RegistryFetch.ecosystem.
 */
export type EcosystemId = string;

export interface AllowlistEntry {
  /** Normalized name, or a scope prefix when `wildcard` is true ("@heroui/"). */
  name: string;
  wildcard: boolean;
  /** Optional version range in this ecosystem's syntax. */
  range?: string;
}

export class AllowlistEntryError extends Error {}

export class RegistryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Integrity {
  algorithm: "sha512" | "sha384" | "sha256" | "sha1";
  /** Hex-encoded digest. */
  hex: string;
}

export interface FileRef {
  filename: string;
  version: string;
  upstreamUrl: string;
  /** Null when the ecosystem publishes no checksum (common for Composer archives). */
  integrity: Integrity | null;
  sizeBytes: number | null;
  /** False for files the ecosystem's safeguards exclude, e.g. PyPI sdists. */
  allowed: boolean;
  /** When this file was published; null means unknown and is treated as too
   *  new. The minimum release age applies per file: a PyPI release can gain
   *  a new wheel long after its first upload. For npm every version has one
   *  immutable tarball, so this is the version's publish time. */
  publishedAt: Date | null;
}

/** One declared dependency edge: the package it installs and the range
 *  it asks for, in the ecosystem's syntax. `"*"` means any version (also
 *  used for a spec that is not a range, such as a dist-tag). */
export interface DependencySpec {
  name: string;
  range: string;
}

export interface VersionInfo {
  version: string;
  /** Dependency names (normalized). Empty when discovered from files instead. */
  dependencies: readonly string[];
  /** The same dependencies with their declared ranges, for the range-aware
   *  graph walk. Adapters with `dependenciesInMetadata` set should fill it;
   *  when omitted, each name counts as `"*"`. */
  dependencySpecs?: readonly DependencySpec[];
  files: readonly FileRef[];
}

export interface PackageMetadata {
  name: string;
  /** Keyed by version string. */
  versions: ReadonlyMap<string, VersionInfo>;
  /** Adapter-private data renderMetadata (and resolveFileMetadata) read:
   *  never the upstream document itself, only what those need of it.
   *  `undefined` when the adapter supports metadata without render data
   *  (`fetchMetadata` without `render`) and it was fetched that way. */
  raw?: unknown;
  /** Approximate bytes this object retains, for the metadata cache's byte
   *  budget. The core estimates it when an adapter leaves it out. */
  approxBytes?: number;
}

export interface FetchMetadataOptions {
  /** Also keep what renderMetadata needs. Without it, an adapter may omit
   *  `raw` (npm does), since the graph walk, the version filter and
   *  downloads read only `versions`. */
  render?: boolean;
}

export interface MetadataRoute {
  kind: "metadata";
  name: string;
}

export interface DownloadRoute {
  kind: "download";
  name: string;
  version: string;
  filename: string;
}

/** PEP 658 metadata file for one wheel. */
export interface FileMetadataRoute {
  kind: "file-metadata";
  name: string;
  filename: string;
}

export type RegistryRoute = MetadataRoute | DownloadRoute | FileMetadataRoute;

export interface RenderedDocument {
  contentType: string;
  body: string;
}

/** The pinned upstream client: HTTPS only, adapter's upstreamHosts only,
 *  no redirects, no private addresses. `acceptEncoding: "gzip"` asks for a
 *  compressed body, which the caller then decompresses itself (the pinned
 *  client never does). */
export type UpstreamFetch = (
  url: string,
  init?: { method?: "GET" | "POST"; body?: string; accept?: string; acceptEncoding?: "gzip"; signal?: AbortSignal },
) => Promise<Response>;

/** One declared dependency as a lockfile or registry manifest writes it:
 *  the folder it installs into (`key`, an alias's own name), the registry
 *  package it installs (`name`, the alias target) and the range it asks
 *  for (`"*"` for a dist-tag or empty spec). */
export interface DeclaredDependency {
  key: string;
  name: string;
  range: string;
}

/** One installed package a lockfile claims, where it installs it. None of
 *  it is trusted: the plan verifies every registry entry against the
 *  registry itself. */
export interface LockfileEntry {
  /** Where the lockfile installs it (npm: `node_modules/a/node_modules/b`). Unique. */
  path: string;
  /** The registry package (an alias's target), as the lockfile claims it. */
  name: string;
  version: string;
  /** The lockfile's integrity string, or null when it records none. */
  integrity: string | null;
  /** `registry`: fetched from the registry (verified, then approved or
   *  refused). `bundled`: shipped inside its parent's own tarball, never
   *  fetched, so neither. `unsupported`: fetched from somewhere other than
   *  the registry (git, a URL, a path) or unreadable; always refused. */
  kind: "registry" | "bundled" | "unsupported";
  /** Why an `unsupported` entry is refused. */
  unsupportedReason?: string;
}

/** A parsed lockfile: its entries, the projects whose declared
 *  dependencies are where reachability starts (the root, workspaces), and
 *  the client's own rule for which entry a declared dependency uses. */
export interface ParsedLockfile {
  entries: readonly LockfileEntry[];
  projects: readonly { path: string; dependencies: readonly DeclaredDependency[] }[];
  /** The entry that `key`, declared by the package at `fromPath`, resolves
   *  to (npm: the nearest ancestor `node_modules/<key>`), or undefined
   *  (not installed, or a local project). */
  resolve(fromPath: string, key: string): LockfileEntry | undefined;
}

/** Immutable facts about one published version, read from the registry
 *  itself (never from a lockfile): stored once, reused forever. */
export interface VersionFact {
  name: string;
  version: string;
  /** Null only while being assembled: a fact is stored only with a publish time. */
  publishedAt: Date | null;
  /** The registry's integrity string (npm: `dist.integrity`, an SRI). */
  integrity: string;
  downloadUrl: string;
  /** Every registry dependency the version declares (npm: dependencies,
   *  optionalDependencies and peerDependencies, aliases resolved). */
  dependencies: readonly DeclaredDependency[];
}

/** An ecosystem's lockfile verification hooks (`POST /-/plan`): parsing and
 *  registry reads only. Every decision (integrity, edges, reachability,
 *  release age, advisories) is the registry core's. */
export interface LockfilePlanSupport {
  /** Parse a lockfile. Throws a RegistryError for one it cannot verify
   *  (unsupported version: 400 `wardby_lockfile_unsupported`; invalid:
   *  400 `wardby_bad_request`; more than `maxEntries` entries: 413
   *  `wardby_lockfile_too_large`). `proxyRegistryUrl` is the proxy's own
   *  route for this ecosystem, which a lockfile written through it records
   *  as the download source. */
  parse(body: string, options: { maxEntries: number; proxyRegistryUrl: string }): ParsedLockfile;
  /** The registry's own record of one version, without its publish time;
   *  null when the registry has no such version. */
  fetchVersionFact(
    name: string,
    version: string,
    upstream: UpstreamFetch,
    signal?: AbortSignal,
  ): Promise<VersionFact | null>;
  /** Publish times of `versions` of one package, read by streaming the
   *  package's full document without ever holding it. A version the
   *  registry has no time for is absent from the result. */
  fetchPublishTimes(
    name: string,
    versions: readonly string[],
    upstream: UpstreamFetch,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<Map<string, Date>>;
  /** Whether a dependency declared as `range` accepts `version`, as the
   *  client itself decides it when it reuses a locked version. */
  edgeSatisfies(version: string, range: string): boolean;
}

export interface WorkerConfigInput {
  /** e.g. "http://wardby-proxy:8787/registry/npm/" */
  registryUrl: string;
  /** The derived registry-only token (`rrg_…`), never the run capability.
   *  Written only under cacheDir, never elsewhere. */
  token: string;
  /** e.g. "/workspace/.cache/npm"; always inside a collection-excluded folder. */
  cacheDir: string;
}

export interface WorkerConfig {
  env: Readonly<Record<string, string>>;
  /** Files the driver writes before the agent starts; paths must be under cacheDir. */
  files: readonly { path: string; content: string; mode: number }[];
}

export interface RegistryAdapter {
  readonly id: EcosystemId;
  /** OSV ecosystem name, e.g. "npm", "PyPI", "Packagist", "RubyGems", "Go". */
  readonly osvEcosystem: string;
  /** Upstream hosts this adapter may reach; added to the pinned-fetch allowlist. */
  readonly upstreamHosts: readonly string[];
  /** Extra folder names skipped at collection, e.g. "vendor" for Composer. */
  readonly collectExclude: readonly string[];
  /** Whether fetchMetadata's VersionInfo.dependencies is complete (npm's
   *  packuments carry every version's dependencies). When true, the core
   *  may resolve a run's approved dependency graph from metadata alone,
   *  on demand, before refusing a name (a lockfile install requests
   *  tarballs without first requesting each parent's metadata). False for
   *  ecosystems whose indexes omit dependencies (PyPI), where such a walk
   *  would only make upstream calls and find nothing. */
  readonly dependenciesInMetadata: boolean;
  /** Lockfile names this ecosystem's client writes, and a rewrite of the proxy download URLs it records in one back to
   *  public URLs, applied before the workspace is collected (lockfiles.ts). Omitted when the client records none. */
  readonly lockfiles?: { names: readonly string[]; normalize(content: string, registryUrl: string): string };
  /** Lockfile verification (`POST /registry/<id>/-/plan`); omitted when the
   *  ecosystem has none. */
  readonly lockfilePlan?: LockfilePlanSupport;

  // --- Allowlist syntax -------------------------------------------------
  /** Parse one allowlist entry in this ecosystem's syntax. Throws an
   *  AllowlistEntryError with a user-facing message if it is invalid. */
  parseAllowlistEntry(raw: string): AllowlistEntry;
  /** Canonical name used for every comparison (npm: the name exactly as
   *  written, since npm names are case-sensitive; PyPI: PEP 503
   *  normalization). */
  normalizeName(name: string): string;
  /** Whether `version` satisfies `range` in this ecosystem's syntax
   *  (npm semver ranges, PEP 440 specifiers). */
  satisfies(version: string, range: string): boolean;
  /** Total order over this ecosystem's version strings (semver for npm,
   *  PEP 440 for PyPI, normalizing non-canonical spellings first), used to
   *  evaluate OSV advisory ranges. Throws on a version it cannot parse; the
   *  audit treats that as affected (fail closed). */
  compareVersions(a: string, b: string): number;

  // --- Protocol ---------------------------------------------------------
  /** Classify a request under /registry/<id>/, or null for 404. Throws a
   *  400 `wardby_bad_request` RegistryError for a malformed path (bad
   *  percent-encoding or an invalid package name); the core records it. */
  route(method: string, subpath: string, headers: Headers): RegistryRoute | null;
  /** Fetch and parse upstream metadata for one package, keeping only the
   *  fields the proxy reads: nothing returned may reference the parsed
   *  upstream document, which can be tens of MB. */
  fetchMetadata(name: string, upstream: UpstreamFetch, options?: FetchMetadataOptions): Promise<PackageMetadata>;
  /** Build the client-facing metadata document containing only `keep`
   *  versions and, of their files, only the filenames in `keptFiles` (the
   *  core's per-file release-age filter), with every download link
   *  rewritten to a proxy route. */
  renderMetadata(
    meta: PackageMetadata,
    keep: ReadonlySet<string>,
    keptFiles: ReadonlySet<string>,
    proxyBase: string,
  ): RenderedDocument;
  /** Map a download route to a file in metadata the proxy fetched itself.
   *  Returns null if the route names no known file. */
  resolveDownload(route: DownloadRoute, meta: PackageMetadata): FileRef | null;
  /** For ecosystems whose indexes omit dependencies (PyPI): dependency
   *  names read from a served file or its metadata file. Omitted when
   *  VersionInfo.dependencies is already complete (npm). */
  dependenciesFromFile?(route: DownloadRoute | FileMetadataRoute, body: Uint8Array): Promise<string[]>;
  /** Map a file-metadata route (PEP 658) to the file it describes, from
   *  metadata the proxy fetched itself. Returns null if the route names no
   *  known file. */
  resolveFileMetadata?(route: FileMetadataRoute, meta: PackageMetadata): FileRef | null;

  // --- Worker -----------------------------------------------------------
  /** Environment variables and files the driver writes so the package
   *  manager uses the proxy, authenticates, keeps caches under cacheDir,
   *  and disables install-time code where the client allows it. */
  workerConfig(input: WorkerConfigInput): WorkerConfig;
}
