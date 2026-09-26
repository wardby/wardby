# Installing packages in coding runs

A coding agent's worker has no direct network access — it can reach only the
coding proxy. Registry mode lets it run `npm install` and `pip install`
anyway, by routing those requests through the proxy to a per-agent allowlist,
with supply-chain safeguards and a full record of what was fetched.

**Registry mode currently supports Codex workers only.** Claude Code runs
every shell command inside a separate, credential-free tool-runner container
with no network attachment (`--network none`), so it cannot reach the proxy
even if the registry environment were configured for it. Making registry mode
work for Claude Code is a follow-up: put that tool-runner container on the
proxy network and give it the same registry settings the Codex driver already
gets.

## Three ways to get dependencies into a run

1. **The standard worker image plus a package allowlist (recommended
   default).** Use wardby's stock `node` or `node-python` worker image and
   enable the packages your agent needs on its allowlist (below). No custom
   image to build or maintain; the agent installs what it needs at run time.
2. **A custom `workerImageRef` with dependencies baked in.** Still supported:
   point the agent's profile at your own image, built on wardby's driver base
   image (see [Bring-your-own worker images](coding-worker-byo-images.md)),
   with everything preinstalled. Setting `workerImageRef` needs `agents:admin`
   and the admin role, and the image must be pinned by digest.
3. **Both together.** Use a custom image for a toolchain or system libraries
   the registry can't provide (a compiler, a non-Node/Python runtime, apt
   packages), and the registry for the project-level npm/PyPI packages your
   agent adds during the run.

npm and pip in every coding run are always pointed at the proxy — this is not
optional per run. If an agent has no allowlist entries for an ecosystem (the
default for a new agent), an install in that ecosystem gets a clear refusal
(`403 wardby_package_not_allowed`) rather than silently failing or reaching
the real registry.

## Enabling packages on an agent

Package permissions live on the coding profile's `packageAllowlist` field,
changed with `update_agent`. Changing `packageAllowlist` or `packagePolicy`
needs the `packages:approve` scope (or `agents:admin`) plus a role that grants it,
`admin` or `package-approver` (see
[roles and privileged operations](security-deployment.md#roles-and-privileged-operations)) — holding only
`agents:write` lets you manage everything else about the agent, but a
`packageAllowlist`/`packagePolicy` change from that caller is refused, since
it widens what the agent can download.

`packageAllowlist` is keyed by ecosystem (`npm`, `pypi`), each an array of
approved top-level entries. An entry is a bare package name, a name with a
version range in that ecosystem's own syntax, or (npm only) a scope wildcard:

```json
{
  "codingProfile": {
    "packageAllowlist": {
      "npm": ["react@^19", "@testing-library/*"],
      "pypi": ["flask>=3"]
    }
  }
}
```

- `react@^19` — npm semver range syntax.
- `@testing-library/*` — every package under that npm scope.
- `flask>=3` — PEP 440 specifier syntax for PyPI.
- A bare name with no range (`"lodash"`) allows any version, subject to the
  other safeguards below.
- npm names are matched exactly, including case. npm treats some legacy
  capitalized names as distinct packages (`JSONStream` is not `jsonstream`),
  so allowing one never allows the other; write the name as npm spells it.
  (npm scopes are always lower case.) PyPI names are compared after PEP 503
  normalization, so `Flask`, `flask` and `FLASK` are the same entry.

An absent or empty allowlist leaves registry mode off for that agent (the
default). Only _top-level_ entries need to be on the allowlist — once a
version is approved, the proxy reads its dependency graph from registry
metadata and grows the run's allowance automatically as npm or pip requests
each dependency's metadata, so you don't have to enumerate transitive
dependencies yourself.

### Lockfile installs: verified, then approved exactly

`npm ci` (or `npm install` with a complete `package-lock.json`) skips
metadata and requests each tarball directly, at the
`https://registry.npmjs.org/...` URL the lockfile records, which npm rewrites
to the proxy. Before that, the coding worker's `npm` verifies the lockfile:
the driver image puts a small shim first on the agent's `PATH`
(`/opt/wardby/bin/npm`, also restored for login shells). For `npm ci`,
`npm install`/`i`/`add` (and their aliases) in a project with a
`package-lock.json` or `npm-shrinkwrap.json`, it sends the lockfile to the
proxy's `POST /registry/npm/-/plan` (with the run's registry token), prints a
one-line summary and any refusals to stderr, and then runs the real npm with
the same arguments. Anything else runs npm directly, and a plan that fails
still runs npm: the install then goes through the usual checks below. An npm
started by another npm (a lifecycle script's) doesn't plan again; its
installs also go through the usual checks.

The proxy trusts nothing the lockfile claims. For lockfileVersion 2 or 3
(version 1 is refused with `400 wardby_lockfile_unsupported`; regenerate it
with npm 7 or later):

- **Integrity.** For each entry `name@version` it reads the registry's own
  record of that exact version (`registry.npmjs.org/<name>/<version>`, a few
  KB). The lockfile's `integrity` must equal the registry's `dist.integrity`,
  or the entry is refused with `wardby_lockfile_integrity_mismatch`.
- **Edges.** Dependencies come from the registry's record too (dependencies,
  optional and peer dependencies, npm aliases resolved), never from the
  lockfile. Each one is matched to the lockfile entry npm would use (the
  nearest enclosing package's `node_modules/<name>`), and counts only when
  that entry is the declared package at a version inside the declared range
  (strict semver, as the walk matches).
- **Reachability.** It starts from the project's own dependencies (and
  workspaces') that are allowlist entries, at a version inside the
  allowlisted range; a scope wildcard such as `@heroui/*` counts here, since
  the lockfile names the exact package. From there it follows only verified
  edges. An entry nothing reaches is refused with `wardby_package_not_allowed`.
- **Release age and advisories.** Each version's publish time (read once by
  streaming the package's full document for its `time` field, never holding
  it) must be older than `minReleaseAgeDays`, and one OSV `querybatch`
  request covers every version (1000 per request), with each advisory's
  severity read once (a version's results are cached for an hour, so a
  repeated plan doesn't query again). Too new, or a HIGH/CRITICAL or
  malware advisory: `wardby_version_filtered`. If OSV can't be reached, the whole plan fails
  closed with `503 wardby_audit_unavailable` (unless
  `REGISTRY_AUDIT_FAIL_OPEN` is set).
- **Other sources.** An entry installed from git, a URL or a path is refused
  with `wardby_lockfile_entry_unsupported`; a bundled dependency is part of
  its parent's tarball and needs nothing.

A refused entry refuses only itself and whatever is reachable only through
it; everything else is approved, as exact `name@version` pairs for the run.
The response is `{ "approved": <count>, "refused": [{ "name", "version",
"code", "reason" }] }`, and each refusal is recorded like any other (within
the 500-per-run cap). A tarball request for an approved `name@version` is then served directly,
checked against the approved integrity, with no graph walk.

A version the plan refused for a reason about that `name@version` itself is
answered straight from the plan, with no walk either: `403` with the plan's
code and reason. That is a version too new (`wardby_version_filtered`, until
it is old enough: the age is re-checked at each request), one with a
HIGH/CRITICAL or malware advisory (`wardby_version_filtered`, naming it), one
npm doesn't have (`wardby_package_not_found`), one npm publishes no integrity
for (`wardby_registry_integrity_missing`), and one hosted outside npm
(`wardby_upstream_host_not_allowed`). A refusal that depends on the lockfile
(`wardby_package_not_allowed`, `wardby_lockfile_integrity_mismatch`,
`wardby_lockfile_entry_unsupported`) is reported in the plan's response, but
isn't used to answer downloads: the same version reached another way (an
`overrides` entry, a later `npm install`) goes through the usual checks, and
a hostile lockfile entry can't block a package by claiming its name. Neither
does a version the registry couldn't be read for, nor one the plan never
mentioned (a package added with `npm install <new-package>`, an install
without a lockfile): they go through the allowlist and the dependency-graph
walk below.

The per-version facts (integrity, publish time, dependencies, download URL)
never change, so they are stored in the database and reused by every later
plan; decisions are always recomputed from the run's own allowlist. A plan is
bounded by `REGISTRY_PLAN_MAX_ENTRIES` entries (`413
wardby_lockfile_too_large`, as is a lockfile over 20 MiB) and
`REGISTRY_PLAN_TIMEOUT_MS` (`503 wardby_plan_incomplete`; what was verified is
kept, so a retry resumes). The proxy checks the registry token and waits for
one of two plan slots before it reads the lockfile at all, so an
unauthenticated or queued plan holds none of it; a run may run one plan at a
time and make `REGISTRY_PLAN_MAX_PER_RUN` in all (`429 wardby_plan_limit`).
It only reads the registry for entries it reaches, so a lockfile full of
unrelated packages costs nothing upstream. Measured
against real npm and OSV with a 0-day release age, the knock-knock `web/`
lockfile (216 entries: React 19, HeroUI 3, Vite 8, Vitest 5, jsdom) was
verified in 9.5 s cold and 0.7 s with stored facts, and its whole `npm ci`
took 12 s cold and 3 s warm, with the proxy at 183 MiB peak RSS (30 MiB
heap). At the default 3 days the same plan
took 10 s and refused 53 entries (vite and vitest were days old, plus what
only they reach), and `npm ci` failed on those refusals in 14 s with the
proxy at 179 MiB peak RSS (24 MiB heap), with no walk.

### Lockfile installs without a plan: the dependency-graph walk

When a tarball request names a package the run hasn't approved or seen yet,
the proxy resolves the approved dependency graph on demand. The graph is
range-aware:

- It starts from the allowlisted packages, at their kept versions: those
  inside the allowlisted range, past the minimum release age, and not
  withheld by the vulnerability audit.
- From each kept version it follows every declared dependency `name@range`
  only into that dependency's kept versions that **satisfy the declared
  range** (npm semver), and continues only from those versions. A
  dependency's newer major, or an old version outside the range, never
  contributes its own dependencies.
- Every in-range kept version counts, not just the newest one, so a
  lockfile pinned to an older version inside the range still gets that
  version's dependencies.
- A spec that isn't a range (a dist-tag such as `latest`, an empty spec)
  counts every kept version. A range no kept version satisfies contributes
  nothing.
- A package joins the graph, and is recorded as allowed, once one of its
  kept versions satisfies a range that reached it. The walk stops as soon as
  it finds the requested package.

The walk is done at most once per run (concurrent and later misses share its
result), and it is bounded by `REGISTRY_MAX_GRAPH_PACKAGES` and
`REGISTRY_GRAPH_TIMEOUT_MS` (see [Operator limits](#operator-limits)).
Allowances are per package name, so once a package is allowed any of its
kept versions can be downloaded. Serving a package's metadata directly (a
plain `npm install`) still allows the dependencies of all its kept versions,
because the proxy doesn't record which ranges a package was allowed under.
A scope wildcard such as `@testing-library/*` can't be enumerated, so it is
never a starting point of the walk. A package allowed _only_ by a scope
wildcard is installable, but under a lockfile its own dependencies are not
found by the walk (it never expands that package unless an exact allowlist
entry's graph reaches it). When npm reads that package's metadata, as a plain
`npm install` does, its dependencies are allowed as usual. With `npm ci`, give
its dependencies their own allowlist entries, or also list the package itself
by exact name. PyPI's index carries no dependencies (pip reads them from each
wheel), so there is no walk for PyPI.

Dependencies are followed by the package they install: an npm alias such as
`"string-width-cjs": "npm:string-width@^4"` allows `string-width`, not
`string-width-cjs`, and follows it under the alias's own range (`^4`).
Dependency specs that aren't fetched from the registry
(`file:`, `link:`, local paths, git URLs and `github:`/`user/repo`
shorthands, `http(s):` tarball URLs, `workspace:`) allow nothing.

If an upstream (the npm registry or the OSV audit) fails while the walk reads
part of the graph, that part is retried: once more straight away, then again
on later requests, up to four attempts per package per run. Until it can be
read, a package that wasn't found is answered with a "could not be checked…
try again" error (`502 wardby_upstream_error`, or
`503 wardby_audit_unavailable` if it was the audit), not with
`wardby_package_not_allowed`.

Likewise, if the walk is cut short before it reaches the requested package,
the package isn't proven absent, so the answer is never
`wardby_package_not_allowed`. After `REGISTRY_GRAPH_TIMEOUT_MS` the answer is
`503 wardby_graph_incomplete`: the next request resumes the walk where it
stopped (npm retries a 5xx on its own), so a retry can succeed. After
`REGISTRY_MAX_GRAPH_PACKAGES` trips, the bound is permanent for the run, so
the answer is a definitive `403 wardby_graph_limit` that clients don't retry:
allowlist the package directly or raise the bound.

The walk reads full npm packuments (the largest are tens of MB) but keeps
only what it needs from each: per version, its dependency specs, publish
time, tarball URL and integrity. A packument is garbage as soon as that is
extracted, and the rendered form npm is served is built only when a client
asks for a package's metadata. The walk's state is dropped when the run's
deadline passes. Even so, a lockfile install of a large graph is the proxy's
largest memory user: a measured `npm ci` of a ~220-package lockfile (React
19, Vite 8, Vitest 5, jsdom) peaked at 1752 MiB RSS (549 MiB heap), which is
why the GKE overlay gives the proxy 3Gi. A lockfile the shim verified
avoids the walk for every version the plan approved or refused.

## What the agent can then run

Inside the run, `npm install <package>` and `pip install <package>` (into
`/workspace/.venv`) work exactly as they would against the real registries,
for anything reachable from the allowlist. Installed `node_modules`, the
`.venv`, and package-manager caches are never collected: they don't count
toward workspace size or checks, and they're never part of the resulting
commit or diff.

## Safeguards

- **Dependency graph only.** Only packages on the allowlist, or reachable
  through the dependency graph of an allowlisted package, can be installed —
  an agent cannot fetch an arbitrary unrelated package just because _some_
  package is allowed.
- **Minimum release age.** A version has to be at least a few days old before
  it can be installed, so a newly published (and potentially not-yet-flagged)
  malicious release is excluded by default. The default is 3 days; a
  profile's `packagePolicy.minReleaseAgeDays` can override it to any integer
  0–30. A version with no publish timestamp is treated as too new to install.
  For PyPI the age applies to each file on its own upload time: a wheel added
  to an old release yesterday is hidden from the index and refused
  (`404 wardby_version_filtered`) until it is old enough, while the release's
  older wheels are served. npm versions are immutable, so each version's
  tarball has the version's publish time.
- **OSV vulnerability audit.** Every package version is checked against the
  OSV database; versions affected by a **high** or **critical** severity
  advisory, or by a **malware** advisory (an OSV `MAL-…` entry, which has no
  severity, one aliasing or importing one, or a CWE-506 "embedded malicious
  code" advisory), are withheld, and lower-severity advisories are allowed but
  reported. A version is affected when an advisory entry for that exact
  package (same ecosystem and name) lists it, or when it falls inside one
  of the entry's version ranges, compared with the ecosystem's own version
  rules (semver for npm, PEP 440 for PyPI). A version the audit cannot
  parse counts as affected. If OSV can't be reached, installs in that request fail closed
  (`503 wardby_audit_unavailable`) rather than skipping the check — an
  operator can opt out of fail-closed with `REGISTRY_AUDIT_FAIL_OPEN=true`.
- **Wheels only for Python.** PyPI source distributions (sdists), which can
  run arbitrary code at install/build time, are never served — only wheels.
- **npm install scripts are off, but only by configuration.** The proxy sets
  `npm_config_ignore_scripts=true` in the agent's environment, which disables
  npm's install-time script hooks. This is a configuration default, not
  something the proxy can enforce on the downloaded tarball itself: the
  proxy cannot strip scripts from a package, so an agent that deliberately
  overrode this setting could still run one. A script that ran would still be
  confined to the same sandbox — no network, no credentials, only the
  workspace writable — but this is a documented limit, not a guarantee.

## Operator limits

These per-run limits protect the proxy process and are configured with
environment variables (defaults shown); they're enforced by the single proxy
process handling the run, counting files and bytes currently in flight as well
as what's already been recorded, so parallel downloads (for example npm's
default concurrent connections) can't add up to more than the limit before any
one of them finishes:

| Setting                        | Default | Meaning                                                       |
| ------------------------------ | ------- | ------------------------------------------------------------- |
| `REGISTRY_MAX_FILE_MB`         | 200     | Largest single downloaded file.                               |
| `REGISTRY_MAX_TOTAL_MB`        | 2048    | Total bytes downloaded in one run.                            |
| `REGISTRY_MAX_FILES`           | 5000    | Total files served in one run.                                |
| `REGISTRY_IDLE_TIMEOUT_MS`     | 120000  | Idle time allowed on one download.                            |
| `REGISTRY_AUDIT_FAIL_OPEN`     | `false` | Allow-and-report instead of refusing when OSV is unreachable. |
| `REGISTRY_METADATA_TIMEOUT_MS` | 30000   | Time allowed for one metadata or OSV request, body included.  |
| `REGISTRY_MAX_METADATA_MB`     | 64      | Largest metadata or OSV response the proxy reads.             |
| `REGISTRY_MAX_GRAPH_PACKAGES`  | 3000    | Packages the on-demand graph walk may expand in one run.      |
| `REGISTRY_GRAPH_TIMEOUT_MS`    | 180000  | Time allowed for one on-demand graph walk.                    |
| `REGISTRY_PLAN_MAX_ENTRIES`    | 5000    | Entries a lockfile plan (`POST /-/plan`) may have.            |
| `REGISTRY_PLAN_TIMEOUT_MS`     | 120000  | Time allowed for one lockfile plan.                           |
| `REGISTRY_PLAN_MAX_PER_RUN`    | 20      | Lockfile plans one run may make.                              |

Metadata is cached for five minutes in a bounded cache (500 packages and
64 MiB of trimmed metadata, least recently used evicted first), and
concurrent requests for the same package share one upstream fetch.

At most 500 refusals are recorded per run. Refusals past that still return
their normal error to npm or pip; they just aren't added to the run's record,
so a worker retrying refused names in a loop can't grow it without bound.

## Integrity

Every file the proxy resolves from its own copy of the upstream metadata
(never a client-supplied URL) is streamed to the agent with its checksum
verified while downloading, aborting on a mismatch — but only when the
ecosystem actually publishes one. npm packages carry `dist.integrity` or
`dist.shasum`, and PyPI wheels carry a SHA-256 hash, so both are verified
today. An ecosystem whose files sometimes ship with no published checksum
(for example some Composer archives, if that ecosystem is added later) is
streamed unverified for those files — there is nothing to verify against.

## What the reviewer sees

Every package the proxy served during a run is recorded, and so is every
refusal up to the 500-per-run cap above. `get_run` returns `packages` and
`packageRefusals` for a coding run, each deduplicated (a retried download is
one package):

```json
{
  "packages": [
    { "ecosystem": "npm", "name": "@heroui/react", "version": "3.2.6", "size": 482113 },
    { "ecosystem": "pypi", "name": "flask", "version": "3.0.0", "size": 101817 }
  ],
  "packageRefusals": [{ "ecosystem": "npm", "name": "left-pad", "reason": "wardby_package_not_allowed" }]
}
```

`size` is the number of bytes served, or `null` if none was recorded.
`get_run` also returns `packagePlan: { "approved": <n>, "refused": <n> }`:
the exact versions lockfile plans approved for the run, and the distinct
entries they refused (each refusal is also in `packageRefusals`).

The pull request finalization also appends a collapsed **Packages installed
during this run** section listing the same information, so a reviewer
doesn't have to ask the agent what it added. It lists at most 100 packages
and 100 refusals, followed by "…and N more — see get_run for the full list";
`get_run` always has the complete list. If the report can't be loaded or
rendered, the section is left out and the pull request is still opened.

## Error codes

npm and pip print the proxy's error body verbatim, so these are what you'll
see on a failed install:

| Code                                 | Status | Meaning / what to do                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wardby_package_not_allowed`         | 403    | The package isn't on the allowlist and isn't reachable from an allowlisted package's dependency graph. Add it (or its top-level dependent) to `packageAllowlist`.                                                                                                                                                                  |
| `wardby_file_not_allowed`            | 403    | The specific file type is never served for this ecosystem (for example a PyPI sdist). Nothing to configure; use a wheel.                                                                                                                                                                                                           |
| `wardby_version_filtered`            | 404    | Every matching version is too new (younger than `minReleaseAgeDays`) or withheld by the vulnerability audit. Wait for it to age past the threshold, or lower `minReleaseAgeDays` if you understand the risk.                                                                                                                       |
| `wardby_package_not_found`           | 404    | The upstream registry has no such package name. Check the spelling (npm names are case-sensitive).                                                                                                                                                                                                                                 |
| `wardby_package_too_large`           | 413    | The file exceeds `REGISTRY_MAX_FILE_MB`. Ask the operator to raise it if the file is legitimately larger.                                                                                                                                                                                                                          |
| `wardby_package_limit`               | 429    | The run hit `REGISTRY_MAX_FILES` or `REGISTRY_MAX_TOTAL_MB`. Trim what the run installs, or ask the operator to raise the limit.                                                                                                                                                                                                   |
| `wardby_audit_unavailable`           | 503    | OSV couldn't be reached and `REGISTRY_AUDIT_FAIL_OPEN` isn't set. Retry, or have the operator set that flag if the outage is expected to be long. Also returned, as "could not be checked against this agent's approved dependency graph… try again", when the audit failed while resolving a lockfile install's dependency graph. |
| `wardby_graph_incomplete`            | 503    | A lockfile install requested a package the on-demand dependency-graph walk hadn't reached when it was cut short by `REGISTRY_GRAPH_TIMEOUT_MS`. Retry: the walk resumes where it stopped (npm retries 5xx on its own). Never means the package is outside the graph.                                                               |
| `wardby_graph_limit`                 | 403    | The walk hit `REGISTRY_MAX_GRAPH_PACKAGES` for this run before reaching the package. Permanent for the run, so retrying won't help: allowlist the package directly, or ask the operator to raise the limit. Never means the package is outside the graph.                                                                          |
| `wardby_lockfile_unsupported`        | 400    | The lockfile sent to `POST /-/plan` isn't lockfileVersion 2 or 3 (or has no `packages`). Regenerate it with npm 7 or later. The install still runs, through the walk.                                                                                                                                                              |
| `wardby_lockfile_too_large`          | 413    | The lockfile is over 20 MiB or has more than `REGISTRY_PLAN_MAX_ENTRIES` entries. The install still runs, through the walk.                                                                                                                                                                                                        |
| `wardby_lockfile_integrity_mismatch` | —      | A plan refusal: the lockfile's `integrity` for this entry isn't the registry's own (or the registry publishes none). Regenerate the lockfile entry; never edit integrity by hand.                                                                                                                                                  |
| `wardby_lockfile_entry_unsupported`  | —      | A plan refusal: the entry is installed from git, a URL or a path, or isn't an exact registry version. Only registry packages can be approved.                                                                                                                                                                                      |
| `wardby_plan_limit`                  | 429    | The run has made `REGISTRY_PLAN_MAX_PER_RUN` lockfile plans. The install still runs, through the usual checks.                                                                                                                                                                                                                     |
| `wardby_registry_integrity_missing`  | —      | A plan refusal: npm publishes no integrity for this version, so a download of it couldn't be checked.                                                                                                                                                                                                                              |
| `wardby_plan_in_progress`            | 429    | A lockfile plan is already running for this run (one at a time). Wait for it; the install still runs, through the walk.                                                                                                                                                                                                            |
| `wardby_plan_incomplete`             | 503    | The plan didn't finish within `REGISTRY_PLAN_TIMEOUT_MS` (or the client went away). What was verified is kept, so a retry resumes; the install still runs, through the walk.                                                                                                                                                       |
| `wardby_bad_request`                 | 400    | The request path is malformed (bad percent-encoding, or not a valid package name). A client or agent bug, not a package choice.                                                                                                                                                                                                    |
| `wardby_upstream_error`              | 502    | The upstream registry answered with an error, or the download failed partway. Retry. Also returned, as "could not be checked against this agent's approved dependency graph… try again", when the registry failed while resolving a lockfile install's dependency graph.                                                           |
| `wardby_upstream_unavailable`        | 504    | The upstream registry didn't answer a metadata request within `REGISTRY_METADATA_TIMEOUT_MS`. Retry.                                                                                                                                                                                                                               |
| `wardby_metadata_too_large`          | 502    | The package's metadata document is larger than `REGISTRY_MAX_METADATA_MB`. Ask the operator to raise it.                                                                                                                                                                                                                           |
| `wardby_upstream_host_not_allowed`   | 502    | The file's download URL points outside that ecosystem's own upstream hosts, so the proxy won't fetch it.                                                                                                                                                                                                                           |
| `invalid_capability`                 | 401    | The run's registry token doesn't match a live session (the run has ended or the token is malformed). Not something a package choice can fix.                                                                                                                                                                                       |

## Adding an ecosystem

npm and PyPI are the two ecosystems registry mode supports today; the adapter
interface is designed to add more (Composer, RubyGems, Go modules are the
known candidates) without changing the schema or the allowlist format. Adding
one means:

1. Implement `RegistryAdapter` and add it to `REGISTRY_ADAPTERS`. No schema
   change is needed.
2. Set `upstreamHosts` to the smallest set of hosts its downloads use.
3. Mark `allowed: false` on file types that run code at install time where the
   proxy can tell them apart, and use `workerConfig` to disable install-time
   code where only the client can.
4. Record upstream fixtures, and add a real-client integration test.
5. Provide a worker image with the language runtime.
6. Document every safeguard the ecosystem cannot enforce.

For example, Composer downloads from GitHub and GitLab archive hosts, often
with `integrity: null`, and needs `--no-plugins` and `--no-scripts` set
through a `COMPOSER_HOME/config.json` file from `workerConfig`. Go fits most
directly, because `GOPROXY` is designed for this kind of proxy.
