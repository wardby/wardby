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

export interface VersionInfo {
  version: string;
  /** Dependency names (normalized). Empty when discovered from files instead. */
  dependencies: readonly string[];
  files: readonly FileRef[];
}

export interface PackageMetadata {
  name: string;
  /** Keyed by version string. */
  versions: ReadonlyMap<string, VersionInfo>;
  /** Adapter-private upstream document, used by renderMetadata and resolveDownload. */
  raw: unknown;
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
 *  no redirects, no private addresses. */
export type UpstreamFetch = (
  url: string,
  init?: { method?: "GET" | "POST"; body?: string; accept?: string; signal?: AbortSignal },
) => Promise<Response>;

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
  /** Lockfile names this ecosystem's client writes, and a rewrite of the proxy download URLs it records in one back to
   *  public URLs, applied before the workspace is collected (lockfiles.ts). Omitted when the client records none. */
  readonly lockfiles?: { names: readonly string[]; normalize(content: string, registryUrl: string): string };

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
  /** Fetch and parse upstream metadata for one package. */
  fetchMetadata(name: string, upstream: UpstreamFetch): Promise<PackageMetadata>;
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
