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
| Collection skip rule      | Known dependency and cache folder names plus profile `collectExclude` globs, applied when the keeper builds the tar. |
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
- **`collectExclude`** — up to 64 relative globs skipped at collection, in
  addition to the built-in list (section 4). No absolute paths, no `..`
  segments.

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

npm sends the run capability as a bearer token and pip as HTTP basic auth. The
proxy looks it up exactly as it does for model calls: it must match a live
session within its deadline. Registry requests are not charged to the model
budget and never reach a model upstream.

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

The worker driver adds these variables to the agent's environment (the run
capability it already holds supplies the credentials):

| Variable                    | Value                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm_config_registry`       | `http://wardby-proxy:8787/registry/npm/`                                                               |
| `npm_config_userconfig`     | `/workspace/.cache/npm/npmrc`, written by the driver with the `_authToken` line for the proxy registry |
| `npm_config_ignore_scripts` | `true`                                                                                                 |
| `npm_config_cache`          | `/workspace/.cache/npm`                                                                                |
| `PIP_INDEX_URL`             | `http://wardby:<capability>@wardby-proxy:8787/registry/pypi/simple/`                                   |
| `PIP_TRUSTED_HOST`          | `wardby-proxy`                                                                                         |
| `PIP_ONLY_BINARY`           | `:all:`                                                                                                |
| `PIP_CACHE_DIR`             | `/workspace/.cache/pip`                                                                                |

The capability is written only under `.cache`, which is never collected, and it
expires with the run's deadline.

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
- The profile's `collectExclude` globs.

### Where it is applied

- **Kubernetes:** the keeper's `tar -cf -` gains matching `--exclude` options,
  so skipped folders never leave the pod and never reach `safeExtract`, the
  100,000-entry caps, the symlink and nested-repository checks, or the size
  limit.
- **Docker:** `materializeWorkspace` currently uses `docker container cp` and
  does not run `safeExtract`. It moves to the same keeper `tar` → `safeExtract`
  path with the same exclusions, bringing Docker's checks level with
  Kubernetes.

### Commit

If a repository tracks a file under an excluded name (for example a committed
`vendor/node_modules/x.js`), leaving that folder out would look like a deletion.
`finalizeChanges` therefore passes the same exclusions to `git add --all` as
exclude pathspecs, so excluded paths are neither added nor deleted and tracked
files there are left unchanged.

## 5. Ecosystem adapters

The registry module defines one interface that each ecosystem implements:

- **Metadata:** fetch the upstream index or packument, filter versions (range,
  release age, audit), rewrite download URLs to proxy routes.
- **Dependencies:** extract dependency names from metadata (npm) or from served
  files (PyPI).
- **Downloads:** resolve a proxy download route to the upstream URL from the
  proxy's own metadata copy, and supply the integrity check if one exists.
- **Timestamps and audit:** the release-time source and the OSV ecosystem name.
- **Worker configuration:** the environment variables or config files the
  driver writes for that package manager.
- **Collection:** additional folder names for the skip list.

npm and PyPI are the first two adapters; allowlist ecosystem keys come from the
registered set.

**Checklist for a new ecosystem** (known candidates: Composer/Packagist,
RubyGems, Go modules): an adapter; its upstream hosts added to the registry
allowlist; recorded upstream fixtures and a real-client integration test; a
worker image with the language runtime; documentation of any safeguard it
cannot enforce. Composer, for example, downloads from GitHub and GitLab archive
hosts, often without a checksum, and needs `--no-plugins`/`--no-scripts`
configured through `COMPOSER_HOME/config.json`.

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
