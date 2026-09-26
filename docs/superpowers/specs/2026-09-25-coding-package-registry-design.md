# Coding package registry and collection exclusions

**Status:** design, awaiting review · **Date:** 2026-09-25

## Problem

A coding worker has `npm` and `pip` but no network: it can reach only the coding
proxy on port 8787. Adding React and HeroUI to a repository therefore required a
hand-built worker image with the packages preinstalled, a lockfile generated
outside the sandbox, three image rebuilds to work around the read-only root
filesystem and `NODE_ENV=production`, and a failed run when a
`web/node_modules` symlink out of the workspace was rejected at collection. The
agent still could not add a dependency on its own.

This design lets a coding agent install packages the normal way
(`npm install`, `pip install`) through the coding proxy, limited to an approved
allowlist with supply-chain safeguards, and stops dependency and cache folders
from taking part in workspace collection.

## Goals

- An agent can `npm install @heroui/react` or `pip install flask` inside a run,
  with no custom image and no network path other than the proxy.
- Only packages reachable from a per-agent allowlist can be installed, and only
  a holder of `packages:approve` or `agents:admin` can change that allowlist.
- Install scripts are off, very new versions and versions with high or critical
  advisories are withheld, and every package served is recorded and shown to
  the reviewer.
- Installed dependencies and caches in the workspace never count toward
  collection limits or checks and are never committed.

## Non-goals

- Private or authenticated upstream registries.
- A shared download cache across runs (metadata is cached briefly; downloads
  are not).
- Ecosystems other than npm and PyPI (the adapter interface below prepares for
  Composer, RubyGems and Go modules).
- General outbound network access for workers.

## Decisions

| Question                  | Decision                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Where the registry runs   | Inside the existing coding proxy (approach A), as a separate `registry` module.                                      |
| Which packages            | Allowlisted top-level packages plus their transitive dependency graph, read from registry metadata.                  |
| Where the allowlist lives | On the agent's coding profile.                                                                                       |
| Who may change it         | New scope `packages:approve`, or `agents:admin`.                                                                     |
| Safeguards                | Install scripts off; minimum release age; OSV vulnerability audit (fail closed); record and report.                  |
| Collection skip rule      | Known dependency and cache folder names plus profile `collectExclude` paths, applied when the keeper builds the tar. |
| `allowedEgress`           | Removed: stored and validated but never enforced by any launcher, the proxy, or the worker.                          |

## 1. Configuration and data

### Coding profile fields

- **`packageAllowlist`** — approved top-level packages per ecosystem key:

  ```json
  { "npm": ["@heroui/react@^3", "react@^19", "@testing-library/*"], "pypi": ["flask>=3"] }
  ```

  An entry is a package name or a scope wildcard (`@scope/*` for npm), with an
  optional version range in that ecosystem's syntax (npm semver ranges, PEP 440
  specifiers). Ecosystem keys are validated against the set of registered
  adapters (initially `npm`, `pypi`). An absent or empty allowlist leaves
  registry mode off for the agent; that is the default.

- **`packagePolicy`** — optional overrides. Initially `minReleaseAgeDays`
  (integer 0–30, default 3).
- **`collectExclude`** — up to 64 repository-relative paths (no wildcards)
  skipped at collection, each with everything under it, in addition to the
  built-in list (section 4). No absolute paths, no `..` segments. Literal
  paths, because GNU tar and Git treat wildcards differently.

### Authorization

- New OAuth scope **`packages:approve`**: may set or change `packageAllowlist`
  and `packagePolicy`, and nothing else.
- `agents:admin` may also change them.
- A caller with only `agents:write` may manage every other field, including
  `collectExclude` (which can only narrow what is collected), and receives a
  clear refusal if it changes the allowlist or policy.
- Every change is recorded in the audit log.
- The scope is added to the protected-resource metadata (`scopes_supported`),
  the self-hosted authorization server, and `getting-started-identity-provider.md`,
  which goes from nine scopes to ten.

### Snapshot at dispatch

Dispatch copies the allowlist and policy onto the `CodingRun` alongside
`protectedPaths`. A change made while a run is in progress cannot widen that
run.

### New data (one additive migration)

- **`RegistryAllowance`** — `(runId, ecosystem, name, source)`, the per-run set
  of package names allowed so far. `source` is `allowlist` or `dependency`.
  Seeded at dispatch from the allowlist and grown as dependencies are
  discovered.
- **`RegistryFetch`** — one row per package file served or refused:
  `runId, ecosystem, name, version, filename, integrity, sizeBytes, outcome,
reason, createdAt`, where `outcome` is `served` or `refused`.

The same migration drops `allowedEgress` from the coding profile and coding run
tables; `schema.prisma`, the MCP tool schemas, the profile validator, and the
README's "reviewed network access" wording are updated to match.

### Proxy deployment

The proxy's memory limit rises from 256 MiB to 512 MiB. No new Service, port,
host alias, or NetworkPolicy rule is added: the worker still reaches only
`wardby-proxy:8787`.

## 2. Registry request flow

### Authentication

npm sends the derived registry token as a bearer token and pip as HTTP basic
auth (see the amendments below for how the token is derived and why it is not
the run capability). The proxy looks up the session it hashes to exactly as it
does for model calls: it must match a live session within its deadline.
Registry requests are not charged to the model budget and never reach a model
upstream.

### npm

1. `GET /registry/npm/<name>` — the proxy checks `<name>` against the run's
   `RegistryAllowance`. If absent: `403 wardby_package_not_allowed`.
2. It fetches the full packument from `registry.npmjs.org` through the pinned
   upstream client and removes versions that are outside the allowlisted range
   (top-level entries only), newer than the minimum release age, or withheld by
   the audit (section 3).
3. For every remaining version it adds the names in `dependencies`,
   `optionalDependencies` and `peerDependencies` to the run's allowance. npm
   reads a package's metadata before requesting its dependencies, so the set
   grows in time.
4. Every `dist.tarball` is rewritten to
   `/registry/npm/-/tarball/<name>/<version>`.
5. On a tarball request the proxy ignores any URL supplied by the client,
   resolves the upstream URL from its own copy of the packument, streams the
   file, verifies `dist.integrity` while streaming (aborting on mismatch), and
   records a `RegistryFetch`.

### PyPI

1. `GET /registry/pypi/simple/<name>/` (PEP 691 JSON) — the same allowance
   check, then a fetch from `pypi.org`.
2. Only wheels are kept. Files newer than the minimum release age (PEP 700
   `upload-time`), versions outside the allowlisted range, and versions withheld
   by the audit are removed.
3. File URLs are rewritten to `/registry/pypi/files/<name>/<filename>` and
   resolved from the proxy's own copy of the index, never from the client.
4. PyPI indexes do not list dependencies, so the proxy reads each served
   wheel's `Requires-Dist` names, from its PEP 658 metadata file or the wheel
   itself, and adds them to the allowance. pip fetches a package's metadata or
   wheel before its dependencies' indexes.

### Worker environment

The worker driver adds these variables to the agent's environment, this table
applies to the Codex worker driver only (see the amendments below): a derived,
registry-only token, never the model-API run capability, supplies the
credentials:

| Variable                    | Value                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm_config_registry`       | `http://wardby-proxy:8787/registry/npm/`                                                               |
| `npm_config_userconfig`     | `/workspace/.cache/npm/npmrc`, written by the driver with the `_authToken` line for the proxy registry |
| `npm_config_ignore_scripts` | `true`                                                                                                 |
| `npm_config_cache`          | `/workspace/.cache/npm`                                                                                |
| `PIP_INDEX_URL`             | `http://wardby:<registry-token>@wardby-proxy:8787/registry/pypi/simple/`                               |
| `PIP_TRUSTED_HOST`          | `wardby-proxy`                                                                                         |
| `PIP_ONLY_BINARY`           | `:all:`                                                                                                |
| `PIP_CACHE_DIR`             | `/workspace/.cache/pip`                                                                                |

The registry token is written only under `.cache`, which is never collected,
and it expires with the run's deadline along with the session it is derived
from.

Installs land in the workspace because it is the only writable location large
enough: the root filesystem is read-only and `/tmp` and the home directory are
small in-memory mounts. npm installs into `node_modules` beside the
`package.json` being installed; Python installs go into a virtual environment
at `/workspace/.venv`. All of these are on the collection skip list.

### Caching

Upstream metadata is cached per run and shared across runs for five minutes.
Downloads are streamed, not cached.

## 3. Safeguards, limits and failures

### Install scripts

- PyPI: enforced by the proxy, which serves wheels only.
- npm: `npm_config_ignore_scripts=true` in the agent's environment. The proxy
  cannot strip scripts from a tarball, so an agent could override it; a script
  would still run inside the same sandbox with no network, no credentials, and
  only the workspace writable. The documentation states this limit plainly.

### Minimum release age

Default 3 days, per-profile 0–30. npm uses the packument's per-version `time`;
PyPI uses `upload-time`. A version with no timestamp is treated as too new.

### Vulnerability audit

- The proxy queries OSV (`api.osv.dev`) once per package, caching the result for
  one hour, and computes the affected versions from the advisory's enumerated
  versions or ranges.
- Versions affected by a **high** or **critical** advisory are withheld.
  Lower-severity or unscored advisories are allowed and reported.
- If OSV cannot be reached, the request is refused with
  `503 wardby_audit_unavailable`. The operator setting
  `REGISTRY_AUDIT_FAIL_OPEN=true` switches this to allow-and-report.

### Upstreams

Registry mode may call only `registry.npmjs.org`, `pypi.org`,
`files.pythonhosted.org` and `api.osv.dev`, through `createPinnedProxyFetch`:
HTTPS only, no redirects, no private or IP-literal addresses. Binary responses
are streamed with backpressure instead of passing through the JSON body limits.

### Limits (operator settings, per run)

| Limit                     | Default |
| ------------------------- | ------- |
| Size of one file          | 200 MiB |
| Total downloaded          | 2 GiB   |
| Files served              | 5,000   |
| Idle timeout per download | 120 s   |

### Error responses

Refusals return a JSON body that npm and pip print, naming the package and the
reason, for example:

- `403 wardby_package_not_allowed: "left-pad" is not on this agent's package allowlist`
- `404 wardby_version_filtered: all matching versions are newer than 3 days or have high-severity advisories`
- `413 wardby_package_too_large`
- `429 wardby_package_limit`
- `503 wardby_audit_unavailable`

### Visibility

- Every served file and every refusal is a `RegistryFetch` row and an audit
  event.
- MCP `get_run` returns `packages` (ecosystem, name, version, size) and
  `packageRefusals` (ecosystem, name, reason) for a coding run.
- Finalization appends a collapsed **Packages installed during this run**
  section, including refusals, to the pull request body.

## 4. Collection exclusions

### What is skipped

- Always, by folder name at any depth: `node_modules`, `.venv`, `venv`,
  `__pycache__`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `.tox`, `.vite`,
  `.cache`.
- The profile's `collectExclude` paths (literal repository-relative paths; each excludes that path and everything under it).

### Where it is applied

- **Kubernetes:** the keeper's `tar -cf -` gains matching `--exclude` options,
  so skipped folders never leave the pod and never reach `safeExtract`, the
  100,000-entry caps, the symlink and nested-repository checks, or the size
  limit.
- **Docker:** after `docker container cp` fills the staging copy, excluded
  paths are removed from it (without following symlinks) before
  `validateMaterializedWorkspace` runs. Moving Docker collection onto
  `safeExtract` needs a streaming command runner and is left as a separate
  hardening change.

### Commit

If a repository tracks a file under an excluded name (for example a committed
`vendor/node_modules/x.js`), leaving that folder out would look like a deletion.
`finalizeChanges` therefore passes the same exclusions to `git add --all` as
exclude pathspecs, so excluded paths are neither added nor deleted and tracked
files there are left unchanged.

## 5. Ecosystem adapters

The registry is split into a **shared core** and one **adapter** per ecosystem.
Everything security-relevant lives in the core, so a new adapter cannot weaken
a safeguard by omission.

### What the core owns

- Authenticating the run capability and loading the run's session.
- Checking the requested name against `RegistryAllowance` and growing it.
- Filtering versions: allowlisted range (top-level entries only), minimum
  release age (a `null` timestamp counts as too new), and the OSV audit.
- Refusing any file an adapter marks `allowed: false`.
- Resolving every download from the proxy's own metadata copy, never the
  client's URL.
- Streaming with backpressure, verifying integrity while streaming, and
  enforcing the size, count and timeout limits.
- Recording `RegistryFetch` rows and audit events, and producing the error
  bodies.
- Metadata caching.

### What an adapter provides

Adapters are pure translation between an ecosystem's protocol and the core's
model. They never authenticate, filter, record, or stream.

```ts
/** "npm", "pypi", later "composer", "rubygems", "go". Used as the allowlist key,
 *  the route segment (/registry/<id>/), and RegistryFetch.ecosystem. */
export type EcosystemId = string;

export interface RegistryAdapter {
  readonly id: EcosystemId;
  /** OSV ecosystem name, e.g. "npm", "PyPI", "Packagist", "RubyGems", "Go". */
  readonly osvEcosystem: string;
  /** Upstream hosts this adapter may reach; added to the pinned-fetch allowlist. */
  readonly upstreamHosts: readonly string[];
  /** Extra folder names skipped at collection, e.g. "vendor" for Composer. */
  readonly collectExclude: readonly string[];

  // --- Allowlist syntax -------------------------------------------------
  /** Parse one allowlist entry in this ecosystem's syntax. Throws an
   *  AllowlistEntryError with a user-facing message if it is invalid. */
  parseAllowlistEntry(raw: string): AllowlistEntry;
  /** Canonical name used for every comparison (npm: lower case;
   *  PyPI: PEP 503 normalization). */
  normalizeName(name: string): string;
  /** Whether `version` satisfies `range` in this ecosystem's syntax
   *  (npm semver ranges, PEP 440 specifiers). */
  satisfies(version: string, range: string): boolean;

  // --- Protocol ---------------------------------------------------------
  /** Classify a request under /registry/<id>/, or null for 404. */
  route(method: string, subpath: string, headers: Headers): RegistryRoute | null;
  /** Fetch and parse upstream metadata for one package. */
  fetchMetadata(name: string, upstream: UpstreamFetch): Promise<PackageMetadata>;
  /** Build the client-facing metadata document containing only `keep`
   *  versions, with every download link rewritten to a proxy route. */
  renderMetadata(meta: PackageMetadata, keep: ReadonlySet<string>, proxyBase: string): RenderedDocument;
  /** Map a download route to a file in metadata the proxy fetched itself.
   *  Returns null if the route names no known file. */
  resolveDownload(route: DownloadRoute, meta: PackageMetadata): FileRef | null;
  /** For ecosystems whose indexes omit dependencies (PyPI): dependency
   *  names read from a served file or its metadata file. Omitted when
   *  VersionInfo.dependencies is already complete (npm). */
  dependenciesFromFile?(route: DownloadRoute | FileMetadataRoute, body: Uint8Array): Promise<string[]>;

  // --- Worker -----------------------------------------------------------
  /** Environment variables and files the driver writes so the package
   *  manager uses the proxy, authenticates, keeps caches under cacheDir,
   *  and disables install-time code where the client allows it. */
  workerConfig(input: WorkerConfigInput): WorkerConfig;
}

export interface AllowlistEntry {
  /** Normalized name, or a scope prefix when `wildcard` is true ("@heroui/"). */
  name: string;
  wildcard: boolean;
  /** Optional version range in this ecosystem's syntax. */
  range?: string;
}

export interface PackageMetadata {
  name: string;
  /** Keyed by version string. */
  versions: ReadonlyMap<string, VersionInfo>;
  /** Adapter-private upstream document, used by renderMetadata and resolveDownload. */
  raw: unknown;
}

export interface VersionInfo {
  version: string;
  /** Release time; null means unknown and is treated as too new. */
  publishedAt: Date | null;
  /** Dependency names (normalized). Empty when discovered from files instead. */
  dependencies: readonly string[];
  files: readonly FileRef[];
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
}

export interface Integrity {
  algorithm: "sha512" | "sha384" | "sha256" | "sha1";
  /** Hex-encoded digest. */
  hex: string;
}

export type RegistryRoute = MetadataRoute | DownloadRoute | FileMetadataRoute;
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

export interface RenderedDocument {
  contentType: string;
  body: string;
}

/** The pinned upstream client: HTTPS only, adapter's upstreamHosts only,
 *  no redirects, no private addresses. */
export type UpstreamFetch = (url: string, init?: { accept?: string }) => Promise<Response>;

export interface WorkerConfigInput {
  /** e.g. "http://wardby-proxy:8787/registry/npm/" */
  registryUrl: string;
  /** The derived registry-only token (see the amendments below), never the
   *  run capability. Written only under cacheDir, never elsewhere. */
  token: string;
  /** e.g. "/workspace/.cache/npm"; always inside a collection-excluded folder. */
  cacheDir: string;
}

export interface WorkerConfig {
  env: Readonly<Record<string, string>>;
  /** Files the driver writes before the agent starts; paths must be under cacheDir. */
  files: readonly { path: string; content: string; mode: number }[];
}
```

Adapters are registered in one map; the profile validator takes its allowlist
keys from it, so adding an adapter needs no schema change:

```ts
export const REGISTRY_ADAPTERS: ReadonlyMap<EcosystemId, RegistryAdapter> = new Map(
  [npmAdapter, pypiAdapter].map((adapter) => [adapter.id, adapter]),
);
```

### How the two first adapters fill it in

| Member           | npm                                                                                                                       | PyPI                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `osvEcosystem`   | `npm`                                                                                                                     | `PyPI`                                                                  |
| `upstreamHosts`  | `registry.npmjs.org`                                                                                                      | `pypi.org`, `files.pythonhosted.org`                                    |
| `collectExclude` | `node_modules`                                                                                                            | `.venv`, `venv`, `__pycache__`                                          |
| `publishedAt`    | packument `time[version]`                                                                                                 | file `upload-time` (earliest per version)                               |
| `dependencies`   | from `dependencies`, `optionalDependencies`, `peerDependencies`                                                           | empty; `dependenciesFromFile` reads `Requires-Dist`                     |
| `allowed: false` | never                                                                                                                     | sdists (wheels only)                                                    |
| `integrity`      | `dist.integrity` (sha512) or `dist.shasum` (sha1)                                                                         | `hashes.sha256`                                                         |
| `workerConfig`   | `npm_config_registry`, `npm_config_userconfig` (npmrc with `_authToken`), `npm_config_ignore_scripts`, `npm_config_cache` | `PIP_INDEX_URL`, `PIP_TRUSTED_HOST`, `PIP_ONLY_BINARY`, `PIP_CACHE_DIR` |

The core's built-in collection skip list (section 4) is the union of every
adapter's `collectExclude` plus the language-neutral cache folders.

### Adding an ecosystem

Known candidates are Composer/Packagist, RubyGems and Go modules. Adding one
means:

1. Implement `RegistryAdapter` and add it to `REGISTRY_ADAPTERS`. No schema
   change is needed.
2. Set `upstreamHosts` to the smallest set of hosts its downloads use.
3. Mark `allowed: false` on file types that run code at install time where the
   proxy can tell them apart, and use `workerConfig` to disable install-time code
   where only the client can.
4. Record upstream fixtures, and add a real-client integration test.
5. Provide a worker image with the language runtime.
6. Document every safeguard the ecosystem cannot enforce.

For example, Composer downloads from GitHub and GitLab archive hosts, often
with `integrity: null`, and needs `--no-plugins` and `--no-scripts` set through a
`COMPOSER_HOME/config.json` file from `workerConfig`. Go fits most directly,
because `GOPROXY` is designed for this kind of proxy.

## 6. Testing

- **Proxy unit tests** with recorded npm, PyPI and OSV responses: token auth;
  allowlist names, ranges and scope wildcards; dependency-graph growth;
  release-age filtering; audit withhold, report and fail-closed; URL rewriting
  that ignores client-supplied URLs; integrity-mismatch abort; size, count and
  timeout limits; error bodies.
- **Proxy server tests** over real HTTP for streaming.
- **Real-client integration tests:** `npm install` and `pip install` against a
  local proxy with a fake upstream.
- **Authorization:** `packages:approve` can change the allowlist; `agents:write`
  is refused; `collectExclude` is allowed with `agents:write`.
- **Database:** tests for `RegistryAllowance` and `RegistryFetch`; the migration,
  including the `allowedEgress` removal; the schema drift check from
  `CLAUDE.md`.
- **Collection:** tar exclusions on Kubernetes; Docker using `safeExtract`; a
  tracked file under an excluded name surviving the commit.
- **Live acceptance on GKE:** give the knock-knock builder an allowlist, switch
  it back to Wardby's standard `node-python` image, and re-run a HeroUI task.
  The agent installs with `npm install`, and the pull request lists the
  packages it installed.

## 7. Documentation

- `coding-worker-isolation.md` and `security-deployment.md`: registry mode, its
  safeguards, the npm install-script limit, and collection exclusions.
- `getting-started-identity-provider.md`: the `packages:approve` scope.
- A new page on installing packages in coding runs.
- `README.md`: correct "reviewed network access".

## Rollout

- Registry mode is off for every agent until an allowlist is set.
- The worker-side environment changes ship in the driver image (`driver-vN`);
  the proxy, dispatch, authorization and collection changes ship in the runtime
  image.
- The migration is additive except for dropping `allowedEgress`, which no code
  path reads.

## Amendments during planning and implementation

The plan that implemented this design (Tasks 1–12) made four amendments to
this design during planning, the controller made five further rulings
during implementation, and the final whole-branch review added four more.
All thirteen are recorded here so this document stays the accurate record of
what shipped.

### From planning

1. **Registry token.** npm and pip authenticate with `rrg_` +
   base64url(sha256(`"wardby-registry\0"` + capability)), derived by the
   driver, not the model-API run capability itself. The proxy stores its hash
   on `CodingProxySession.registryTokenHash` and accepts it only on
   `/registry/` routes; the model routes accept only the original capability.
   The agent's shell never receives the model capability.
2. **`allowedEgress` removal is two-phase.** This plan removes every code path
   that reads or writes it but keeps the columns; dropping them is a later,
   separately released task, after this plan's release is fully rolled out, so
   pods from the previous release never query a dropped column.
3. **Always configured.** The driver configures npm and pip for every coding
   run; an agent with no allowlist for an ecosystem gets
   `403 wardby_package_not_allowed` naming the missing allowlist, so no
   worker-protocol change is needed.
4. **`resolveFileMetadata`.** The adapter interface gains an optional
   `resolveFileMetadata(route, meta)` for PEP 658 metadata files.

### From implementation

5. **Registry mode is Codex-only for now.** Claude Code runs every shell
   command inside a credential-free, networkless tool-runner container
   (`--network none`), which can never reach the proxy, so wiring registry
   environment variables into the Claude driver would be inert and
   misleading. The registry environment (§2) is applied by the Codex worker
   driver only. Supporting Claude Code is a follow-up: put the tool-runner
   container on the proxy network and give it the same registry settings.
6. **In-flight limit reservation.** The per-run limits in §3 are enforced
   per proxy process (a single replica): `RegistryService` reserves each
   in-flight download's file count and byte estimate before streaming it, in
   addition to the already-recorded usage, so concurrent downloads (for
   example npm's default parallel sockets) cannot overshoot `REGISTRY_MAX_FILES`
   or `REGISTRY_MAX_TOTAL_MB` before any one download completes and is
   recorded. A future multi-replica proxy would need this reservation moved
   to the database.
7. **Every refusal is recorded, including limits and audit failures.** The
   `429 wardby_package_limit` and `503 wardby_audit_unavailable` refusals are
   persisted as `RegistryFetch` rows with `outcome: "refused"`, exactly like
   every other refusal in §3, so `get_run.packageRefusals` and the pull
   request's packages section show them too.
8. **Verify integrity only where the ecosystem publishes it.** A download
   whose `FileRef.integrity` is `null` (an ecosystem that publishes no
   checksum for that file, such as some Composer archives) is streamed
   unverified; every other download's integrity is verified while streaming,
   as §2 and §5 describe.
9. **Prisma 7, not Prisma 6.** The repository moved to Prisma 7 (generated
   client imported from `#prisma`, not `@prisma/client`; the schema drift
   check uses `SHADOW_DATABASE_URL` with `--to-schema --exit-code`) after this
   design was written. This design is otherwise version-agnostic: only import
   paths and drift-check commands differ from a Prisma 6 reading of it.

### From the final review

10. **npm names are case-exact.** npm treats some legacy capitalized names
    as distinct packages (`JSONStream` is not `jsonstream`), so the npm
    adapter's `normalizeName` is the identity, not lower-casing: allowlist
    entries, routes, dependency keys and upstream paths keep the name exactly
    as written, and allowlist matching is exact. Only scope wildcards are
    folded, since npm scopes are always lower case. PyPI keeps PEP 503
    normalization.
11. **PyPI minimum release age is per file.** The age cutoff (§3) applies to
    each file's own `upload-time`, not to the release's earliest upload: a
    wheel added to an old release is dropped from the rendered index and
    refused with `404 wardby_version_filtered` until it is old enough, while
    the release's older wheels are served. `publishedAt` therefore lives on
    `FileRef` (npm sets it to the version's publish time, since an npm
    version has one immutable tarball), and `renderMetadata` also receives
    the set of kept filenames.
12. **Refusal records are capped.** At most 500 refused `RegistryFetch` rows
    are recorded per run (an in-process counter seeded from the store, per
    ruling 6's single-replica assumption). Further refusals still return
    their normal error to the client but are not recorded, so a worker
    retrying refused names cannot grow the table, `get_run` or the pull
    request body without bound. The pull request section lists at most 100
    packages and 100 refusals, then points to `get_run` for the full list.
13. **OSV ranges are evaluated per package.** The audit counts only
    `affected[]` entries whose ecosystem and adapter-normalized name match
    the queried package, and a version is affected when it is listed or
    falls inside a `SEMVER`/`ECOSYSTEM` range (npm GHSA entries carry ranges
    only), compared with a new adapter method, `compareVersions` (semver for
    npm, PEP 440 for PyPI). Metadata and OSV requests are bounded by
    `REGISTRY_METADATA_TIMEOUT_MS` (504 `wardby_upstream_unavailable`) and
    `REGISTRY_MAX_METADATA_MB` (502 `wardby_metadata_too_large`).
