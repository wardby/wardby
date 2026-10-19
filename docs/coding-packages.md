# Installing packages in coding runs

A coding agent's worker has no direct network access — it can reach only the
coding proxy. Registry mode lets it run `npm install` (or pnpm or yarn) and
`pip install` anyway, by routing those requests through the proxy to a per-agent allowlist,
with supply-chain safeguards and a full record of what was fetched.

**Registry mode works for both providers.** Claude Code runs every shell
command inside a separate, credential-free tool-runner container that shares
the run's proxy network with the agent, so it can reach the proxy the same
way Codex's driver does; it never receives the run's model capability, only
the registry-only settings the trusted launcher builds for it (delivered as
`WARDBY_TOOL_SETUP`). Both providers support the `node` toolchain (npm) and
the `node-python` toolchain (npm and pip). See [Claude Code](#claude-code)
below.

## Claude Code

`npm install` and, on the `node-python` toolchain, `pip install` run inside
Claude Code's tool-runner container, the same container that mounts the
workspace and runs every other shell command — the agent container never runs
one. The toolchain picks the tool-runner image: `node` uses
`CODING_CLAUDE_TOOL_RUNNER_IMAGE`, and `node-python` with toolchain version
`3.12` uses `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12` (Python with
pytest and ruff, the same packages as the Codex `node-python` worker). As with
Codex, pip installs go into a virtual environment
(`python -m venv --system-site-packages .venv`), and pip there reaches only the
registry. The lockfile check
(the shim on `PATH` that plans `npm ci`/`npm install`, and the pnpm and yarn
installs, against the proxy before they run; see "Lockfile installs:
verified, then approved exactly" below) applies there exactly as it does for
Codex. Before a Claude Code run's
changes are committed, the control plane rewrites any collected lockfile's
proxy URLs back to the ecosystem's real public registry URL (for example
`https://registry.npmjs.org/...`), so a lockfile in the resulting pull
request never names the internal proxy.

## Three ways to get dependencies into a run

1. **The standard worker image plus a package allowlist (recommended
   default).** Use wardby's stock `node` or `node-python` worker image and
   enable the packages your agent needs on its allowlist (below). No custom
   image to build or maintain; the agent installs what it needs at run time.
2. **A custom `workerImageRef` with dependencies baked in.** Still supported:
   point the agent's profile at your own image, built on wardby's driver base
   image for a Codex agent, or `FROM` the same release's tool runner image for
   a Claude Code agent (see
   [Bring-your-own worker images](coding-worker-byo-images.md)), with
   everything preinstalled. Setting `workerImageRef` needs `agents:admin`
   and the admin role, and the image must be pinned by digest.
3. **Both together.** Use a custom image for a toolchain or system libraries
   the registry can't provide (a compiler, a non-Node/Python runtime, apt
   packages), and the registry for the project-level npm/PyPI packages your
   agent adds during the run.

npm, pnpm, yarn, pip and uv in every coding run are always pointed at the proxy —
this is not optional per run (see [pnpm and yarn](#pnpm-and-yarn) for how
each client is configured). If an agent has no allowlist entries for an ecosystem (the
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
version range in that ecosystem's own syntax, (PyPI only) a name with extras,
or (npm only) a scope wildcard:

```json
{
  "codingProfile": {
    "packageAllowlist": {
      "npm": ["react@^19", "@testing-library/*"],
      "pypi": ["flask>=3", "psycopg[binary]>=3.2"]
    }
  }
}
```

- `react@^19` — npm semver range syntax.
- `@testing-library/*` — every package under that npm scope.
- `flask>=3` — PEP 440 specifier syntax for PyPI.
- `psycopg[binary]>=3.2` — a PyPI package with the extras it is installed
  with, in PEP 508 form: `name[extra1,extra2]`, optionally followed by a
  specifier. See [PyPI extras](#pypi-extras).
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
dependencies yourself. A package the project adds as a new _top-level_
dependency, though, must be on the allowlist itself (or already in the
lockfile the run verified), even if some allowlisted package's dependency
graph contains it: see
[Metadata requests are answered at once](#metadata-requests-are-answered-at-once).

### PyPI extras

A PyPI package can declare optional dependencies under named _extras_:
`pip install "psycopg[binary]"` also installs `psycopg-binary`, which
`psycopg` declares only under its `binary` extra. Without the extra on the
allowlist, the proxy follows only a package's plain dependencies, so
`psycopg-binary` would be refused with `wardby_package_not_allowed` even
though `psycopg` is allowed.

Name the extras on the entry, exactly as you would to pip:

```json
{ "pypi": ["psycopg[binary]", "uvicorn[standard]>=0.30", "celery[redis,msgpack]"] }
```

- Each extra must be a valid extra name (letters, digits, and `.`, `_` or `-`
  between them), at most 32 per entry. Extras are compared after PEP 685
  normalization (lower case, runs of `-`, `_` and `.` become `-`), so
  `[Foo_Bar]` and `[foo-bar]` are the same extra.
- An extra allows only the dependencies the package's own metadata declares
  under that extra (`Requires-Dist: psycopg-binary==3.2.3; implementation_name
!= "pypy" and extra == "binary"`). The rest of such a line's environment
  marker is not evaluated, so the extra's dependencies are allowed on every
  platform; pip still installs only what applies. Dependencies under any
  other extra stay refused.
- An entry without brackets follows no extras at all — neither its own nor
  its dependencies'. When a plain entry's metadata asks for a dependency with
  extras (`fastapi` declaring `uvicorn[standard]>=0.30`), the dependency is
  allowed as the bare package, exactly as for any plain dependency, and the
  packages under its extra stay refused. To allow them, name the extra on the
  allowlist: `fastapi[standard]`, or `uvicorn[standard]` directly.
- Dependencies' extras are followed only below a package the run allows with
  extras: an entry that names extras, or a dependency such a package's
  metadata asks for with extras. Below `fastapi[standard]`, a
  `uvicorn[standard]` dependency line allows `uvicorn`'s `standard` packages
  too. A dependency reached that way without extras of its own gets only its
  plain dependencies.
- The same package may appear in several entries; their extras are combined.
- An extra that a dependency line asks for is followed only once the proxy has
  served that parent's metadata. If pip reads the dependency before its parent
  (for example because the dependency is also an allowlist entry) and the
  extra's packages are refused with `403 wardby_package_not_allowed`, name the
  extra on the allowlist directly, e.g. `uvicorn[standard]`.
- The extra markers the proxy recognises are `extra == "name"`,
  `extra === "name"`, and the reversed forms `"name" == extra` and
  `"name" === extra` (single or double quotes, inside `and`/`or` and
  parentheses).
- A marker that mentions `extra` in any other form (`"name" in extra`,
  `extra in "a b"`, a bare `extra`, or a marker with an unbalanced quote) is
  treated as gated on no extra: that line is never followed, for any entry,
  plain or not. Allowlist the package it names directly if you need it.
- The proxy reads a wheel's `METADATA` only up to the end of its headers (the
  first empty line); `Requires-Dist` text in the package description after
  them is ignored.

The last two rules apply to every PyPI allowlist, including ones without any
extras, and are deliberately fail-closed: a dependency line the proxy cannot
read with certainty is not followed. If a package that installed before is now
refused with `403 wardby_package_not_allowed` because its parent declares it
that way, add it to the allowlist directly.

Extras on allowlist entries need the coding proxy and the control plane at the
same Wardby version. A proxy from before extras support cannot parse a
`name[extra]` entry at all: the whole allowlist fails to load, so **every**
registry request of a run with such an entry fails, not just that package.
Upgrade the proxy before (or with) the control plane. For the same reason,
once any coding profile stores an extras entry, downgrading the control plane
or proxy below the release that added extras is unsafe; remove the extras
entries first.

Every safeguard below (release age, advisories, wheels only, the record of
what was fetched) applies to packages reached through an extra.

### Accepting advisories

A version withheld only because of a **high** or **critical** advisory can be
served for one agent once an approver accepts that advisory. List the advisory
ids in the coding profile's `packagePolicy.acceptedAdvisories` with
`create_agent` or `update_agent` (up to 32 unique ids; needs `packages:approve`
or `agents:admin`, like any other package-policy change):

```json
{
  "codingProfile": {
    "packagePolicy": {
      "minReleaseAgeDays": 3,
      "acceptedAdvisories": ["GHSA-xxxx-xxxx-xxxx"]
    }
  }
}
```

`update_agent` replaces `packagePolicy` as a whole, so always send the full
object: leaving out `minReleaseAgeDays` resets it to the default of 3. To
remove a waiver, send the whole object again without that id.

Upgrade the coding proxy together with the control plane before setting
`acceptedAdvisories`: an older proxy rejects the unknown policy key and fails
package requests for that run (it fails closed).

- Ids are matched exactly as OSV prints them (case-sensitive, for example
  `GHSA-…`, `CVE-…`, `PYSEC-…`) against an advisory's id and its aliases, so
  accepting a `CVE-…` id also waives the `GHSA-…` advisory that aliases it.
- The registry serves a version only when **every** advisory blocking it is
  accepted. Otherwise it is still refused with `wardby_version_filtered`, and
  the refusal names only the advisories still blocking.
- **Malware is never waivable.** `MAL-…` ids are rejected when you set the
  policy, and an advisory that is malware (a `MAL-…` id or alias, or CWE-506)
  is still withheld even if its id is listed.
- Each served version that needed a waiver is recorded with the reason
  `accepted advisories: <ids>`. `get_run` shows `acceptedAdvisories` per
  package, and the pull request body gets an **Accepted advisories** section
  listing `name@version: ids` (only when a waiver was used).
- The policy is fixed when a run starts; a change applies to the next run.

To find the id, take the package named in the refusal and look it up at
`https://osv.dev/list?q=<package>`, or run `npm audit`. Accept an advisory only
after reading it and judging whether the vulnerable code is actually exposed
(for example, a dependency used only at build time). Remove the entry once a
fixed version ships, so the waiver does not outlive its reason.

### The quickstart offers a repository's declared packages

The quickstart's coding step (see
[Get started](getting-started.md#packages-the-repository-declares)) reads the
dependencies the chosen local repository declares at the root of its base
commit — `package.json` (`dependencies`, `devDependencies`,
`optionalDependencies`), `pyproject.toml` (`[project]` dependencies, optional
dependency groups, Poetry dependencies and groups, and Poetry's legacy
`[tool.poetry.dev-dependencies]`, plus its `[build-system] requires` build
packages, or `setuptools` and `wheel` when there is no `[build-system]` table)
and `requirements*.txt` —
and offers them as `local-builder`'s allowlist: names without versions (PyPI
names PEP 503-normalized, keeping the extras a requirement names, such as
`psycopg[binary]`, merged per package), invalid names dropped, at most 200 per
ecosystem. It asks
before adding them; a `--non-interactive` run adds them only with
`--allow-repo-packages`. Every safeguard on this page still applies to those
entries. A re-run of the quickstart replaces the builder's allowlist with the
repository's current set (or an empty one if declined), so make lasting
additions on a builder you created yourself, or re-apply them after a re-run.

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
still runs npm: the install then goes through the usual checks below, and
for the rest of the run metadata requests the proxy can't otherwise answer
fall back to the slower dependency-graph walk (see
[Metadata requests are answered at once](#metadata-requests-are-answered-at-once)).
A lockfileVersion 1 lockfile can't be planned (`400
wardby_lockfile_unsupported`), so regenerate it with a current npm before the
run to avoid that fallback. An npm started by another npm (a lifecycle
script's) doesn't plan again; its installs also go through the usual
checks. Python lockfiles are verified the same way, with differences listed
under [Python installers](#python-installers-pip-uv-and-poetry).

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
- **Reachability.** It starts from every lockfile entry that is an allowlist
  entry, at a version inside the allowlisted range, wherever it sits in the
  lockfile and whether or not a project declares it; a scope wildcard such as
  `@heroui/*` counts here, since the lockfile names the exact package. From
  there it follows only verified edges, each inside the declared range. An
  entry nothing reaches is refused with `wardby_package_not_allowed`.
- **Overrides.** An npm `overrides` entry can install a version that its parent's
  declared range doesn't allow, so the plan can't reach it through that
  parent. It's approved, with its own dependencies, when the overridden
  package's name is on the allowlist (and the version is inside the
  allowlisted range); otherwise it's refused with
  `wardby_package_not_allowed`. Allowlist the target of each override your
  repository uses. Release age, advisories and integrity are checked as for
  any other entry.
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
it; everything else is approved, as exact `name@version` pairs for the run,
and each approved package name is allowed for the run, so npm can read its
metadata again (as `npm install <new-package>` does for the packages already in
the lockfile).
The response is `{ "approved": <count>, "refused": [{ "name", "version",
"code", "reason" }] }` (plus `"audited": <count>` in a
[package audit mode](#package-audit-mode) run), and each refusal is recorded like any other (within
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
without a lockfile): their metadata requests go through the allowlist and the
run's allowances (see
[Metadata requests are answered at once](#metadata-requests-are-answered-at-once)),
and their downloads also through the dependency-graph walk below.

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
unrelated packages costs nothing upstream. As a rough guide, a web-app
lockfile of about 200 entries verifies in seconds the first time and in under a
second once its package facts are stored. When the release-age policy refuses
some entries, packages that are refused only because they're reachable through
those entries can't be answered from the plan, so npm's requests for them fall
back to the dependency-graph walk below (after a plan with any refusal, this
applies to metadata requests as well as downloads). That can make a failing install take
minutes and use much more proxy memory; fix the refusals (wait out the release
age or adjust the agent's policy) rather than retrying.

### pnpm and yarn

pnpm and yarn install from the same npm allowlist and the same registry
route as npm, with the same safeguards. The worker configures each of them
to reach only the proxy, with the run's registry token:

| Client                  | How the worker points it at the proxy                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm                     | `npm_config_registry`, and an npmrc (`npm_config_userconfig`) holding the token. Install scripts, the update notifier, audit and fund are off.                                                                                                                                                                                                                                   |
| pnpm                    | npm's settings above (pnpm reads the same ones), so install scripts and the update check are off too. The shim puts its store and cache under the workspace's `.cache` (`npm_config_store_dir` and `npm_config_cache_dir`, set for pnpm alone: npm warns about settings it doesn't know).                                                                                        |
| yarn classic (1.x)      | npm's registry and npmrc. yarn classic sends the token only with `always-auth`, which npm warns about, so the shim sets `npm_config_always_auth` for yarn alone. Install scripts are off with `YARN_IGNORE_SCRIPTS` (yarn classic ignores `npm_config_ignore_scripts`); the shim puts its cache under `.cache` (`npm_config_cache_folder`, for yarn alone).                      |
| yarn Berry (2 or later) | Berry reads none of npm's settings: `YARN_NPM_REGISTRY_SERVER`, `YARN_NPM_AUTH_TOKEN` with `YARN_NPM_ALWAYS_AUTH`, and the proxy's host in `YARN_UNSAFE_HTTP_WHITELIST` when the proxy is plain HTTP (Berry refuses an `http:` registry otherwise). Telemetry and scripts are off (`YARN_ENABLE_TELEMETRY=0`, `YARN_ENABLE_SCRIPTS=false`); its global folder is under `.cache`. |
| corepack                | `COREPACK_NPM_REGISTRY` and `COREPACK_NPM_TOKEN`, so it downloads a pinned pnpm or yarn release from the proxy; no download prompt, no `packageManager` pinning, no lookup of the latest release.                                                                                                                                                                                |

Berry's per-project `cacheFolder` is left alone, so a repository that
commits its cache (zero-install) keeps using it. A service's `testEnv` can't
set `YARN_*`, `PNPM_*` or `COREPACK_*` variables.

**Getting pnpm or yarn Berry into the run.** The stock worker images ship
npm, yarn classic and corepack, not pnpm or yarn Berry. The shim runs
`pnpm`, and `yarn` in a project whose `package.json` (or, for a workspace
package, the workspace root's) pins yarn 2 or later
(`"packageManager": "yarn@4.x"`), through corepack, which downloads that
release through the registry like any other package: allowlist `pnpm` for
pnpm, `@yarnpkg/cli-dist` for yarn 2 or later, or `yarn` for a pinned yarn
1.x other than the image's. The release-age policy applies to it too, so a
release pinned the day it shipped is refused until it is old enough.
corepack reads one version's document at
`/registry/npm/<name>/<version>`, which the proxy serves with the same checks
as the package's whole document. A repository that commits its yarn release
(`yarnPath` in `.yarnrc.yml`) needs none of this. Alternatively, bake the
tool into a custom worker image.

**Lockfile plans.** The shim acts as `pnpm` and `yarn` too: before
`pnpm install`/`i`/`add` it sends `pnpm-lock.yaml`, and before a bare
`yarn`, `yarn install`, `add`, `remove`, `upgrade`, `upgrade-interactive`
or `up` (also as `yarn workspace <name> <command>`) it sends `yarn.lock` (the nearest one
from the project up, so a workspace root's lockfile counts), to the same
`POST /registry/npm/-/plan`, which tells the formats apart by content.
Supported:

| Lockfile                     | Versions                                   | Integrity checked against the registry | How a dependency is matched to its entry                                          |
| ---------------------------- | ------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------- |
| `package-lock.json`          | lockfileVersion 2 and 3                    | `integrity`                            | npm's: the nearest enclosing `node_modules/<name>`                                |
| `pnpm-lock.yaml`             | lockfileVersion 6 (pnpm 8) and 9 (pnpm 9+) | `resolution.integrity`                 | the reference the parent's entry records (`ms: 2.1.3`, an alias's `name@version`) |
| `yarn.lock`, yarn classic    | `# yarn lockfile v1`                       | `integrity`                            | the parent's `name@range` descriptor                                              |
| `yarn.lock`, yarn 2 or later | `__metadata.version` 4 or later            | none: see below                        | the parent's `name@range` descriptor                                              |

Every other check is the one described above: reachability from allowlist
entries over dependencies the registry declares, inside their declared
ranges, release age, advisories, the plan's refusal records and allowances,
and the fallback to the walk after a failed or partial plan. Workspace
packages and `link:`, `portal:`, `file:`, `exec:` and `patch:` entries are
local and skipped (a yarn patch applies to an npm entry the lockfile lists
on its own); git and URL entries are refused with
`wardby_lockfile_entry_unsupported`. pnpm's older `lockfileVersion` 5.x
(pnpm 7) is refused with `400 wardby_lockfile_unsupported`: regenerate it
with pnpm 8 or later. The YAML lockfiles are read as plain strings, and one
using YAML anchors or aliases (which pnpm and yarn never write) is refused.
The proxy reads a `pnpm-lock.yaml` or `yarn.lock` in a separate worker
thread, never on the thread that serves every run's registry and model
traffic. The read is bounded to 15 seconds and to 384 MiB of memory for
every 5000 entries `REGISTRY_PLAN_MAX_ENTRIES` allows (384 MiB at the
default). A lockfile not read in time is answered with
`503 wardby_plan_incomplete`, and one that needs more memory with
`413 wardby_lockfile_too_large`; a retry of the same lockfile fails the same
way, and the install falls back to the walk, as for any failed plan. A
reader that fails for any other reason is the proxy's own failure: it is
logged (`registry.failed`) and answered with `502 wardby_upstream_error`.
A realistic lockfile at the default entry bound (a 3.4 MiB
`pnpm-lock.yaml`) reads in under a second using about 160 MiB.

**Proxy memory.** Each lockfile plan being read can use that bound on top of
the proxy's own memory, and two plans are read at once, so allow about
800 MiB of headroom for lockfile reads at the default settings (more if you
raise `REGISTRY_PLAN_MAX_ENTRIES`).

**yarn Berry's `checksum` is not npm's integrity.** It is yarn's own hash
of its cache archive, so the plan can't compare it with the registry's.
A Berry plan approves exact `name@version` pairs, and each download is then
checked against the registry's own integrity for that version, as every
download is. A tampered tarball is still refused (`wardby_integrity_mismatch`);
what a Berry plan can't catch is a lockfile entry whose checksum was edited,
which yarn itself rejects at install.

**yarn Berry adds `node-gyp`.** Berry gives every package with an install
script (such as `fsevents`) an implicit dependency on `node-gyp`, which no
registry metadata declares. Allowlist `node-gyp` for a Berry project whose
lockfile has it, or the install is refused at `node-gyp`.

**yarn classic downloads from the URLs in yarn.lock**, never from its
configured registry, so a frozen install can't reach the proxy on its own.
For the install, the shim points the lockfile's `registry.yarnpkg.com` and
`registry.npmjs.org` URLs at the proxy, and afterwards puts the file back
byte for byte; if yarn rewrote the lockfile (`yarn add`), each entry's
proxy URL goes back to the host that entry had (a new entry gets the host
most of the lockfile uses). The shim does this for every command above. A yarn classic install that
bypasses the shim (the real `yarn` called by its full path) gets neither this
nor the token, and fails.

**What a run commits.** The proxy serves each download at the registry's
usual path (`<proxy>/registry/npm/<name>/-/<name>-<version>.tgz`), and pnpm
and yarn 2 or later record a download URL only when it isn't the usual one,
so their lockfiles, yarn's `.pnp.cjs` and install state, and the names in
`.yarn/cache` name nothing of the proxy: a zero-install repository can
commit them as they are. npm and yarn classic record every download URL, so
before a run's changes are collected Wardby rewrites their `resolved` URLs
to public registry URLs (yarn classic's on `registry.yarnpkg.com`). It
also drops a pnpm `tarball` or a yarn 2+ `__archiveUrl` that still names the
proxy (from an older Wardby). A committed lockfile never names the proxy or
the token.

### Metadata requests are answered at once

When a package manager resolves a package, it reads the package's metadata
(npm's packument) first. The proxy serves it if the name is allowlisted, was
declared as a dependency (regular, optional or peer) by a package whose metadata
was already served in this run, or was approved by the run's lockfile plan.
Package managers resolve top-down, reading a parent's metadata before asking for
its dependencies, so every genuine dependency is already allowed when it is
requested. Any other name is refused at once with
`403 wardby_package_not_allowed`, with no dependency-graph walk.

The exception is a run whose lockfile plan failed (any error answer, such as
an unsupported lockfileVersion 1, `wardby_lockfile_too_large`,
`wardby_plan_incomplete`, `wardby_plan_limit` or `wardby_plan_in_progress`)
or refused an entry. Then some of the lockfile's packages may have no
allowance, and npm may read their metadata in no particular order (for
example, when it upgrades a lockfileVersion 1 lockfile or re-reads the
lockfile's packages on `npm install <new-package>`). For the rest of that run
and ecosystem, a metadata request for an unknown name goes through the
dependency-graph walk below, exactly as a download does, even if a later plan
succeeds. The proxy keeps this per run in memory, like the walk itself.

As a consequence, a **new top-level package must be allowlisted** (or already
be in the lockfile the run's plan approved), even if some allowlisted
package's dependency graph contains it. For example, if `framework` is
allowlisted and depends on `helper`, `npm install framework` installs `helper`
as its dependency, but `npm install helper` (adding it as a top-level
dependency) is refused until `helper` is allowlisted too.

### Lockfile installs without a plan: the dependency-graph walk

When a tarball request names a package the run hasn't approved or seen yet
(a lockfile install requests tarballs without first reading each parent's
metadata), the proxy resolves the approved dependency graph on demand. A
metadata request starts this walk only after a lockfile plan of the run failed
or refused an entry (see above). The graph is
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

The walk expands the requested name first, so a request is answered as soon as
the walk reaches it. It groups all of a package's ranges together, so each
package is expanded once however many dependents ask for it, and it reuses
already expanded packages through a bounded memo (entries are per run, kept for 15
minutes; its 32 MiB budget is shared by the whole proxy process). Because it follows every kept version inside each range, plus
optional and peer dependencies, its graph is usually several times larger than
the graph of one install. The walk runs only while a request waits for it; its
state is per run, so it resumes within the run and starts again in a new run.
Each time a walk ends, the proxy logs `registry.graph_walk` with how far it
got. (A run in [package audit mode](#package-audit-mode) never walks; it logs
`registry.audited` for each package it installs outside the allowlist.)

A request the walk could not settle gets one of four answers (a metadata
request gets the last three only after a failed or partial lockfile plan,
since otherwise it never walks):

- `403 wardby_package_not_allowed`: final. The walk finished and the package is
  not on the allowlist, or is only reachable through a refused package. The
  agent's owner must allowlist it.
- `403 wardby_package_not_allowed_pending`: the walk stopped (at
  `REGISTRY_GRAPH_TIMEOUT_MS`) before reaching the name, so it may still be
  reachable. The message shows how many packages were walked and how many were
  queued. It is not transient: the agent should stop, because retrying rarely
  helps, and the owner should allowlist the package directly.
- `403 wardby_graph_limit`: this run's walk reached `REGISTRY_MAX_GRAPH_PACKAGES`
  (counting package names) before it reached the name, so the name may not be in
  the graph at all. The bound is permanent for the run: the agent's owner can
  allowlist the package directly, or the operator can raise the limit.
- `503 wardby_graph_incomplete`: only for a name that is still being checked.
  The walk reached the name (an expanded version declares it) but timed out
  (`REGISTRY_GRAPH_TIMEOUT_MS`) before the name's own versions were checked,
  usually a slow or failing upstream for that package, or another request's walk
  running out of time. Retry shortly (npm retries a 5xx on its own). When a
  completed walk has failed nodes, the answer is `wardby_upstream_error` or
  `wardby_audit_unavailable` instead.

Large frameworks (for example Expo) can exceed the graph limit, because the
walk follows every in-range version plus optional and peer dependencies.
Allowlist the packages the project needs directly.

The walk reads full npm packuments (the largest are tens of MB) but keeps
only what it needs from each: per version, its dependency specs, publish
time, tarball URL and integrity. A packument is garbage as soon as that is
extracted, and the rendered form npm is served is built only when a client
asks for a package's metadata. The walk's state is dropped when the run's
deadline passes. Even so, a lockfile install of a large graph is the proxy's
largest memory user: a measured `npm ci` of a ~220-package lockfile (React
19, Vite 8, Vitest 5, jsdom) peaked at 1752 MiB RSS (549 MiB heap), which is
why the GKE overlay gives the proxy 3Gi. A lockfile the shim verified
avoids the walk for every version the plan approved, and for every version it
refused for a reason about the version itself (too new, an advisory, ...).

## Package audit mode

From Wardby 0.6.1, an agent's owner can switch its coding runs' registry into
package audit mode for a limited time. A package outside the allowlist is then
installed instead of refused, and recorded so it can be approved afterwards.
Use it to find out which packages a task actually needs (a new framework, a
large toolchain) without a round of refusals for each one, then approve them
and let the mode lapse.

### What each mode does

"Outside the allowlist" means a name that is neither an allowlist entry nor
allowed for the run as a dependency of one.

| Situation                                                    | Off (default)                      | `audit`                                                                                                   | `full`                                                                         |
| ------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Metadata for a package outside the allowlist                 | `403 wardby_package_not_allowed`   | served; the package is recorded as `top-level` (`unknown` after a failed or partial lockfile plan)        | same as `audit`                                                                |
| Download of a package outside the allowlist                  | lockfile plan, graph walk, refusal | served with no walk; recorded as `unknown` unless its metadata or a plan said more                        | same as `audit`                                                                |
| A dependency an audited package declares                     | not applicable                     | allowed for the run; recorded as `transitive`, with the top-level audited package that brought it (`via`) | same as `audit`                                                                |
| A version outside an allowlist entry's own range (`foo@^1`)  | `wardby_version_filtered`          | unchanged: an entry's range is the owner's explicit restriction                                           | unchanged                                                                      |
| A high or critical advisory, not accepted                    | withheld                           | withheld                                                                                                  | served, and every blocking advisory recorded (also for an allowlisted package) |
| An advisory in `packagePolicy.acceptedAdvisories`            | waived, recorded on the served row | same                                                                                                      | same                                                                           |
| Malware (`MAL-…`, an alias of one, CWE-506)                  | withheld                           | withheld                                                                                                  | withheld                                                                       |
| Release age (`minReleaseAgeDays`, per file)                  | enforced                           | enforced                                                                                                  | enforced                                                                       |
| OSV unreachable                                              | `503 wardby_audit_unavailable`     | same                                                                                                      | same                                                                           |
| Source distributions, size and file limits, integrity, hosts | enforced                           | enforced                                                                                                  | enforced                                                                       |

No graph walk runs in an audit-mode run, so `wardby_graph_limit`,
`wardby_graph_incomplete` and `wardby_package_not_allowed_pending` can't
occur there.

### Turning it on

The agent's owner sets it with `update_agent`. It needs `packages:approve` or
`agents:admin` (the gate for `packageAllowlist`), and `create_agent` doesn't
accept it:

```json
{ "id": "<agent id>", "codingProfile": { "packageAuditMode": "audit", "packageAuditMinutes": 1440 } }
```

| Input                                         | Effect                                                         |
| --------------------------------------------- | -------------------------------------------------------------- |
| `packageAuditMode: "audit"` or `"full"`       | on for 24 hours                                                |
| …with `packageAuditMinutes: <m>` (1 to 10080) | on for `m` minutes (at most 7 days)                            |
| `packageAuditMinutes: <m>` alone              | re-arms the stored mode for `m` minutes (an error without one) |
| `packageAuditMode: null`                      | off                                                            |

Each change is logged as `coding.package_audit.set` with the agent, mode,
end time and who set it. `get_agent` and `update_agent` return
`codingProfile.packageAuditMode`, `packageAuditUntil` and
`packageAuditActive`, plus a warning while the window is open. An expired
window keeps the stored mode but is inactive.

A coding run takes the mode when it is dispatched and keeps it for its whole
life, queued or long-running. A run dispatched just before the window ends
runs with the mode for up to the agent's `timeoutSec`. Continuations and
review fix rounds are new dispatches and read the window again.

### What is recorded, and where

Each package version served only because of the mode (or, in `full`, served
despite a blocking advisory) is recorded once per run, when its first file
finishes downloading. A HEAD request, a metadata request or a refusal records
nothing. If the record can't be written, the download fails instead of being
installed unrecorded. The record shows up in:

- `get_run`: `packageAuditMode` and `packageAudit` (an empty list when the mode
  was on and nothing was recorded; both absent when it was off).
- The pull request body: a `[!CAUTION]` banner above the agent's summary,
  **Packages outside the allowlist** (the `top-level` names to approve, each
  with a count of its dependencies), a separate **Relation unknown** list (see
  below), and in `full` mode **Served despite advisories**. When
  the mode was on and nothing was recorded, the banner says so in one line. A
  later run on the same pull request merges the lists across its runs, and the
  banner is kept when the **Packages** section is dropped for size.
- The run's GitHub or Jira status comment: a short block above the run line,
  with `unknown` names in their own labelled sentence.
- Slack: a `packages_audited` event for the top-level run (see
  [Slack notifications](slack-notifications.md)).
- The proxy log: `registry.audited`, one line per version, with the run,
  ecosystem, name, version, size, relation, `via`, mode and advisory ids.

```json
{
  "packageAuditMode": "full",
  "packageAudit": [
    { "ecosystem": "npm", "name": "vite-plugin-pwa", "version": "1.0.3", "size": 41210, "relation": "top-level" },
    {
      "ecosystem": "npm",
      "name": "workbox-build",
      "version": "7.3.0",
      "size": 90231,
      "relation": "transitive",
      "via": "vite-plugin-pwa"
    },
    {
      "ecosystem": "npm",
      "name": "lodash",
      "version": "4.17.20",
      "size": 1200,
      "relation": "allowed",
      "advisories": [{ "id": "GHSA-35jh-r3h4-6jhm", "severity": "HIGH", "summary": "Command injection in lodash" }]
    }
  ]
}
```

`relation` is best effort. `unknown` means the registry couldn't tell how the
package reached the run (a direct tarball download, or a metadata request
after a lockfile plan fell back). A dependency that an audited package
declared first stays recorded as audited even if an allowlisted package
declares it later. Both errors over-report, never under-report. Because an
`unknown` package may really be a dependency of an allowlisted package that
was installed without its parent's metadata, every surface lists `unknown`
names apart, labelled "Relation unknown — may be a dependency; approve only
if needed directly", and they aren't approved unless you name them.

### Lockfile plans and the dependency cache

In audit mode a lockfile plan (`POST /registry/<ecosystem>/-/plan`) also
approves the lockfile entries the allowlist doesn't reach, when they pass
every other check. An entry a lockfile project declares is `top-level`, one
an audited top-level entry reaches is `transitive`, and anything else is
`unknown`. The projects are the root and workspaces a `package-lock.json`,
`pnpm-lock.yaml` or yarn 2+ `yarn.lock` lists. A yarn classic `yarn.lock`
lists none, so there a package is `top-level` when no other entry depends on
it at the same range; one that another package also requires at that range
shows as `transitive`. An allowlisted name at a version outside its entry's range is never
approved this way. The plan's response adds `audited`, the number of
approvals carrying an audit record, and each download of such an approval is
recorded like any other audited package.

A plan that audited anything never records its lockfile for the
[dependency cache](#dependency-cache). A restore installs packages without
downloading them, so they would go unrecorded. The run installs normally
instead, and no snapshot of that lockfile is saved from it.

### Promoting audited packages

Add what a run recorded to the allowlist with `approve_audited_packages`
(`{ "runId": "<run id>" }`, optionally `"names": [...]`). Without `names` it
adds the `top-level` names as bare entries to the agent's `packageAllowlist`;
their dependencies then follow through the allowlist graph. It adds an
`unknown` name only when `names` lists it, and otherwise returns those names
as `unknown` for you to judge. For a parent run, each coding sub-run's names go to that sub-run's own
agent. It needs the same access as `packageAllowlist` (`packages:approve` or
`agents:admin`, owner only), skips names already allowed, keeps the 256-entry
limit per ecosystem, and is logged as `coding.package_audit.promoted`. It
checks every agent before writing any, so a refusal (another owner's agent, a
full allowlist) changes nothing. It
doesn't turn the mode off. You can also edit `packageAllowlist` with
`update_agent` yourself, for example to pin a range.

### Risks

Package audit mode weakens the supply-chain guard while it is on:

- `audit` keeps the malware, advisory and release-age checks. `full` keeps
  only malware and release age. A confused or prompt-injected agent can
  install a lookalike package that has no advisory yet and is older than the
  release age.
- npm runs with `--ignore-scripts` and pip installs only wheels, so nothing
  runs at install time, but the run's tests and builds still execute what was
  installed.
- A scheduled agent can run many times inside one window. Keep windows short,
  turn the mode off once you've approved what you need, and read the caution
  banner on every affected pull request before merging.

The mode is never on by default, needs an approver's scope and the agent's
owner, lasts at most 7 days, is logged when set, and is reported on every
run it affected.

### Upgrading

The coding proxy reads each run's mode from `CodingRun.packageAuditMode` and
writes `RegistryAuditRecord` rows. The GKE `up.sh` applies these grants from
`deploy/gke/database-grants.sql` after its migrations. If you manage the proxy
database role yourself, grant it `SELECT` on `CodingRun.packageAuditMode` and
`SELECT, INSERT` on `RegistryAuditRecord` before upgrading the proxy.
Without them, every registry request fails with `502 wardby_upstream_error`
and the proxy logs `registry.failed` with a permission error.

## Dependency cache

Installing a large `node_modules` on every run is slow. With the dependency
cache on, Wardby prepares an npm project's `node_modules` **before the agent
starts**, from a snapshot kept in a blob store, and tells the agent not to
reinstall it. It is off by default and is turned on per agent.

### What it does

For each eligible npm project the worker prepares `node_modules` in one of
these ways, reported per project in [`get_run`](#what-get_run-reports):

- **`hit`**: a snapshot for exactly this lockfile exists. It is downloaded,
  verified, and put in place. Nothing is installed. A snapshot that fails to
  download or verify is not used: the project is installed `cold` instead.
- **`nearest`**: no exact snapshot, but one exists for the same repository,
  folder and worker image with a different lockfile. It is
  restored, `npm install --no-save` brings it to the committed lockfile
  (usually a small change), the committed `package.json` and
  `package-lock.json` are put back byte for byte, and a new snapshot is
  stored.
- **`cold`**: no usable snapshot. `npm ci` runs and its result is stored.
- **`skipped`** or **`refused`**: nothing was prepared and the agent installs
  for itself as it always did. A skip never fails the run.

Snapshots are keyed by repository, project folder, lockfile hash and worker
image (the Claude Code tool-runner image for Claude Code runs), all derived on
the server. Changing the image starts a new key; changing the lockfile falls
back to `nearest`. The agent's package policy is not part of the key: a
snapshot holds exactly the lockfile's integrity-checked packages, so agents on
the same repository share snapshots, and each restore is still gated by the
restoring agent's own current policy (see
[A restore needs the plan first](#the-trust-model)).

### The trust model

A snapshot holds only what Wardby's own code installed, from packages the
uploading run's policy approved, before the run's agent existed; and a run restores
one only after the proxy re-approves the committed lockfile for that run. The
packages themselves are whatever your allowlist and policy approve: the cache
doesn't vet their contents beyond what a normal install through the registry
does. A `nearest` base may come from another agent on the same repository and
contain packages outside this agent's policy; the delta install prunes them,
and the consistency check verifies that the tree matches the approved lockfile
before the agent starts.

- **Only Wardby builds snapshots, and only before the agent exists.** The
  worker uploads a snapshot as part of its own preparation step, then seals the
  run's upload window with the proxy. The proxy also seals the window itself on
  the run's first model request: the worker sends none before its preparation
  step is over, so the window is closed before the agent can act even when the
  worker never sealed it. After the seal the proxy refuses every lookup,
  download and upload for the run, and bytes of an upload that finish after the
  seal are discarded. A proxy-side deadline
  (`WARDBY_DEPENDENCY_CACHE_UPLOAD_SECONDS` after the run's proxy session
  starts) is the last backstop. A run uploads at most once per project.
- **A restore needs the plan first.** The worker sends the committed lockfile
  to the proxy's lockfile plan (see
  [Lockfile installs: verified, then approved exactly](#lockfile-installs-verified-then-approved-exactly)).
  The proxy records the lockfile's hash only if the plan approved every package
  under the agent's _current_ allowlist, release-age rule and advisory policy,
  and serves a snapshot only for a recorded hash. If the policy now refuses
  something, the project is `refused` and no snapshot is used.
- **Keys are server-derived.** The worker supplies only the project folder and
  the lockfile hash. The repository and image come from the run's own
  record, and an id that is neither the run's own key nor the recomputed
  nearest snapshot for the same scope is answered 404.
- **Integrity is checked on download.** The proxy stores each snapshot's
  SHA-256 and size and sends them with the download; the worker checks both
  while streaming. A blob whose bytes no longer match its record is deleted by
  the proxy when it is served, so the next run rebuilds it. The worker then
  scans the archive before writing anything (regular files, folders and
  relative links inside `node_modules` only; no absolute or `..` paths, hard
  links, devices, duplicate paths, including by case or Unicode form, or links
  that leave `node_modules`), extracts it into a private temporary folder,
  re-verifies the tree on disk, compares the recorded package metadata (npm's
  hidden lockfile and each package's `package.json` version) with the committed
  lockfile, and only then renames it into place. The integrity of the bytes
  comes from the checksum the proxy holds, not from this comparison. Any
  failure removes the temporary tree, and the project is installed `cold`
  instead (except when the run's time is up or the tree would not fit the
  run's disk). The worker records that scan's result with each snapshot it
  uploads; a restore whose downloaded bytes match the recorded digest skips
  the separate scan, and extraction still enforces every archive rule above
  and the disk budget.
- **Install scripts are not cached.** Every preparation step runs npm with
  `--ignore-scripts`. After the upload window is sealed, and only for a project
  whose committed lockfile lists a package with an install script, the worker
  runs `npm rebuild` so native add-ons (esbuild, sharp and the like) work. It
  runs with a minimal environment (`PATH`, `HOME`, `LANG`, `TMPDIR` and the
  registry settings, never the run's credentials), starts only after the proxy
  confirmed the seal, and nothing it writes can be uploaded.

### When it applies

- npm only: a `package.json` and a `package-lock.json` with `lockfileVersion`
  2 or 3, at the repository root and/or in other folders up to **3 levels
  deep**, at most **4 projects** in all (the root first, then the others in
  path order; any further ones are skipped `too_many_projects`).
- Folders named `node_modules`, folders whose name starts with a dot or has a
  space or other characters outside letters, digits and `_@+-.`, and symlinked
  folders or lockfiles are not searched or used.
- npm workspaces monorepos are not supported. A project that declares
  `workspaces`, and any project covered by another project's `workspaces`
  globs, is skipped, and so is a folder with an `npm-shrinkwrap.json`.
- A folder that already has a `node_modules` is left alone.
- The agent needs a package allowlist (registry mode): the restore is approved
  by the lockfile plan.
- Codex and Claude Code runs on the `node` and `node-python` toolchains, with
  worker images from a Wardby release that includes the cache. See
  [Worker images](#worker-images) before you turn it on.

### Worker images

Use the worker images from the same release as the control plane before you
turn `dependencyCache` on for any agent: the Codex worker images
(`CODING_WORKER_IMAGE` and its toolchain variants such as
`CODING_WORKER_IMAGE_NODE_PYTHON_3_12`), the Claude Code worker image
(`CODING_CLAUDE_WORKER_IMAGE`) and the Claude Code tool runner images
(`CODING_CLAUDE_TOOL_RUNNER_IMAGE` and its variants). An older Codex or
Claude Code worker image validates its input strictly and rejects a run whose
agent has the cache on: the run fails with `worker_input_failed`. A
`workerImageRef` image must also be rebuilt for this release: `FROM` this
release's driver image for a Codex agent, or `FROM` this release's tool runner
image for a Claude Code agent. `create_agent` and `update_agent` return a
warning when an agent has both `dependencyCache` and a `workerImageRef`;
Wardby can't tell how old a custom image is. A Claude Code tool runner without
the cache doesn't fail the run: its projects report `tool_unavailable`. See
[Bring-Your-Own Coding-Worker Images](coding-worker-byo-images.md#the-dependency-cache-needs-a-current-driver).

### Enable it

1. **Deployment.** On the **coding proxy**, which is the only component that
   touches the store, set `WARDBY_DEPENDENCY_CACHE=true` and a blob store
   (`BLOB_STORE` plus its per-store variables: `BLOB_STORE=gcs` with
   `BLOB_STORE_GCS_BUCKET`, `BLOB_STORE=s3` with `BLOB_STORE_S3_BUCKET` and
   `BLOB_STORE_S3_REGION`, or `BLOB_STORE=local` with `BLOB_STORE_LOCAL_DIR`).
   With the switch on but no blob store the cache stays off and the proxy logs
   a warning. Per target:
   - **GKE**: set `dependency_cache_enabled = true` and
     `dependency_cache_bucket_name` in `terraform.tfvars`, then run
     `deploy/gke/up.sh` with `WARDBY_DEPENDENCY_CACHE=true`. See
     [`deploy/gke/README.md`](../deploy/gke/README.md#run-dependency-cache).
   - **AWS (EKS)**: set the Terraform variables of the same names, and give the
     proxy container `BLOB_STORE=s3`, `BLOB_STORE_S3_BUCKET` (the
     `dependency_cache_bucket` output), `BLOB_STORE_S3_REGION` and
     `WARDBY_DEPENDENCY_CACHE=true`. See
     [`deploy/aws/README.md`](../deploy/aws/README.md#run-dependency-cache).
   - **kind harness**:
     `WARDBY_DEPENDENCY_CACHE=true bash deploy/kind-coding/up.sh`. The store is
     the proxy pod's `emptyDir`, so snapshots are lost when the pod restarts.
   - **Docker quickstart**: add `WARDBY_DEPENDENCY_CACHE=true` to
     `.wardby/.env` and restart the stack. Snapshots live on a named volume
     that `docker compose down -v` removes. This requires wardby 0.6.1 or
     later (earlier runtime images can't write to the volume).
2. **Database grants.** Where the coding proxy has its own restricted database
   role (GKE), it needs access to `DependencySnapshot` and a few `CodingRun`
   columns. `deploy/gke/up.sh` applies them before the rollout; see
   [Upgrading an existing deployment](getting-started-gke.md#upgrading-an-existing-deployment).
3. **Per agent.** Once the [worker images](#worker-images) are current, set
   `codingProfile.dependencyCache` to `true` with `create_agent` or
   `update_agent`. Like the package allowlist, it needs
   `packages:approve` or `agents:admin`. The setting is read when a run
   starts.

### Dependency cache limits

These variables are read by the coding proxy, and only when
`WARDBY_DEPENDENCY_CACHE=true`. Each limit must be a positive integer; the
proxy refuses to start otherwise.

| Variable                                  | Default | Meaning                                                                                                                        |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `WARDBY_DEPENDENCY_CACHE`                 | `false` | Master switch (`true` or `false`). Also needs `BLOB_STORE`.                                                                    |
| `WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB` | 1024    | Largest snapshot accepted. A bigger one is not stored.                                                                         |
| `WARDBY_DEPENDENCY_CACHE_REPO_CAP_MB`     | 4096    | Snapshot bytes kept per repository. Least recently used go first.                                                              |
| `WARDBY_DEPENDENCY_CACHE_TOTAL_CAP_MB`    | 20480   | Snapshot bytes kept in all. Least recently used go first.                                                                      |
| `WARDBY_DEPENDENCY_CACHE_MAX_AGE_DAYS`    | 14      | A snapshot's lifetime, counted from creation rather than last use, so even a constantly used snapshot is rebuilt periodically. |
| `WARDBY_DEPENDENCY_CACHE_UPLOAD_SECONDS`  | 900     | How long after a run's proxy session starts the proxy still accepts an upload.                                                 |

The proxy evicts hourly: snapshots past the maximum age, then least recently
used ones over the per-repository cap, then over the total cap. It deletes the
stored object before its database record. On GKE and AWS the bucket also
deletes objects older than `dependency_cache_max_age_days + 7` days, which
removes objects that were never recorded; keep that Terraform variable equal
to `WARDBY_DEPENDENCY_CACHE_MAX_AGE_DAYS` by hand. The kind harness and
Docker quickstart stores are local and have no such rule.

Other bounds:

- The cache works within a disk budget: the run's workspace disk
  (`workspaceDiskMb`) less what the workspace already uses and a safety
  margin. If that can't be measured, or leaves under 64 MiB, the cache is
  skipped (`budget_unknown`, `budget_too_small`). Restores and the snapshot
  archive are held to the budget while they are written; an install is only
  checked before it starts, since npm's own writes can't be bounded while it
  runs.
  - A restore must fit: the downloaded archive plus its unpacked tree. A
    `nearest` snapshot is restored only when one and a half times its
    unpacked size fits, leaving room for the update and the new archive.
  - An install (`cold`) starts only when at least 1 GiB is left, or twice
    the project's tree size when a snapshot of it was already seen. Otherwise
    the project is skipped `budget_too_small` and the workspace is left as it
    was, so the agent installs for itself. A tree much larger than that can
    still fill the disk during the install, as it would for the agent.
  - After its own install, the worker deletes npm's download cache (the
    `_cacache` folder under the npm cache folder in the workspace's `.cache`;
    the registry settings beside it stay). It is about as large as
    `node_modules` again, and the agent's npm downloads what it needs.
  - Before archiving a tree for upload, the worker measures the workspace
    again. It doesn't write the archive when the estimated size (the tree
    at its last snapshot's compression, or a third of the tree) doesn't fit
    what is left, and stops and deletes an archive that outgrows it while
    being written. The installed tree stays and the project is still
    `cold` or `nearest`; only the upload is skipped. The worker log records
    this as `snapshot_skipped` with reason `budget` (it isn't a `get_run`
    reason).
- The worker gives the lockfile plan up to 10 minutes (a proxy with a cold
  package cache checks every package of a large lockfile first), and each
  other proxy call up to 2 minutes. When the proxy stops at its own
  `REGISTRY_PLAN_TIMEOUT_MS` (`503 wardby_plan_incomplete`), the worker sends
  the plan again after 2 seconds and the proxy resumes from what it already
  verified, until the 10 minutes or 5 attempts are up (`timeout`). Each
  attempt counts toward `REGISTRY_PLAN_MAX_PER_RUN`; the cache sends at most
  8 plans per run, leaving the rest for the agent's own installs (a project
  past that is `plan_failed`). Raising `REGISTRY_PLAN_TIMEOUT_MS` is optional
  tuning: it means fewer, longer attempts.
- The whole preparation, measuring the disk included, is bounded to 20
  minutes or half the time left before the run's deadline, whichever is
  sooner, so a short run keeps most of its time for the agent. A rebuild is
  bounded to 5 minutes, and the worker stops uploading once the proxy's upload
  window is nearly over.
- Packing a snapshot (`tar` and gzip) gets 5 minutes plus 0.5 seconds per MiB
  of the installed tree (a 1 GiB tree gets about 13.5 minutes), and never runs
  past the upload window: a snapshot that couldn't be uploaded isn't packed.
  When a step runs out of time, the worker log records `snapshot_skipped` with
  reason `timeout`, the `stage` (`archive`, `scan` or `upload`),
  `writtenBytes`, `estimateBytes`, `elapsedMs`, and the `limit` that fired
  with its `limitMs`. No snapshot is stored, so every run on that lockfile
  installs again. What to raise depends on `limit`:
  - `pack`: the pod is short on CPU for gzip; raise `CODING_CPUS`.
  - `upload_window`: the install took most of the window; raise
    `WARDBY_DEPENDENCY_CACHE_UPLOAD_SECONDS`, or `CODING_CPUS` to install
    faster.
  - `upload`: the blob store is slow to accept the archive; check the proxy's
    path to it.
  - `deadline`: the whole preparation ran out (20 minutes, or half the time
    left before the run's deadline); raise `CODING_CPUS` or the agent's
    `timeoutSec`.
- A large tree also needs memory: an npm install of about 1 GiB and 400,000
  files can need more than the default 2048 MiB under gVisor, and a pod that
  runs out is killed before anything is cached. Raise `CODING_MEMORY_MB` (6144
  is enough for a tree that size).
- On Docker the workspace can be a tmpfs, whose inode limit can bind before
  its byte limit on a very large restore. The cache is then skipped
  (`internal_error`) and the run continues.

### What the agent sees

When at least one project was restored or installed, the agent's task carries a
note naming the folders: "Dependencies are pre-installed from the committed
lockfile in: the repo root, web. Don't run `npm ci` there; add packages with a
single install command." `npm ci` deletes `node_modules` and installs
everything again, which throws away the prepared tree and the time saved,
whereas `npm install <package>` works on top of it. A pull request Wardby opens
gets a line, "Dependency cache: restored `node_modules` for the repo root,
`web`.", naming the folders restored from a snapshot (`hit` or `nearest`).

### What `get_run` reports

`get_run` returns `dependencyCache` for a run that used the cache:

```json
{
  "dependencyCache": {
    "projects": [
      { "path": ".", "result": "hit", "key": "9f2c…", "sizeBytes": 148000000, "restoreMs": 4100, "rebuild": "ok" },
      { "path": "web", "result": "cold", "installMs": 61000, "sizeBytes": 91000000 },
      { "path": "tools", "result": "skipped", "reason": "workspaces" }
    ]
  }
}
```

- `result` is `hit`, `nearest`, `cold`, `skipped` or `refused`.
- `key`, `sizeBytes`, `restoreMs` and `installMs` appear where they apply.
- `reason` explains a `skipped` or `refused` project, or a `cold` project whose
  tree was kept but not stored (`inconsistent`).
- `rebuild` is `ok`, `failed`, `timeout`, `skipped` (no install scripts) or
  `unsealed` (the proxy did not confirm the seal, so no script ran).
- A top-level `reason` with an empty `projects` list means the whole step
  failed or was skipped. `omitted` counts projects that couldn't be listed.

The field is absent for a run that didn't use the cache, and for one that
failed before its result was collected.

### Cache reason codes

A skipped project never fails the run. Look the `reason` up here. A snapshot
that a `hit` or `nearest` restore rejects (`download_failed`, `size_mismatch`,
`sha_mismatch`, `too_large`, `unsafe_archive`, `inconsistent`) is not reported
as the project's reason: the project installs `cold` instead, and a traced
Codex run's worker log records the code as `hit_rejected` or
`nearest_rejected`. The same log times each restore's stages as
`restore_phase` events (`stage` is `download`, `scan`, `extract`,
`verify_links` or `check_consistency`, with `ms`), for finding a slow restore.

| Reason                                                        | Meaning and what to do                                                                                                                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no_lockfile`, `lockfile_unreadable`, `no_package_json`       | Nothing eligible in that folder. Expected for repositories without npm.                                                                                                                                          |
| `lockfile_version`                                            | The lockfile is below `lockfileVersion` 2. Regenerate it with npm 7 or later.                                                                                                                                    |
| `workspaces`, `workspace_member`, `shrinkwrap_present`        | An npm workspaces root, a folder inside one, or an `npm-shrinkwrap.json`: not supported. The agent installs for itself.                                                                                          |
| `node_modules_present`                                        | The checkout already has a `node_modules` there. It is left alone.                                                                                                                                               |
| `no_dependencies`                                             | The lockfile installs nothing.                                                                                                                                                                                   |
| `too_many_projects`                                           | More than 4 projects were found. The rest are skipped.                                                                                                                                                           |
| `cache_dir_unsafe`                                            | `.cache` in the checkout isn't a plain folder (for example a committed symlink). Remove it from the repository.                                                                                                  |
| `no_registry`                                                 | The worker got no registry settings: the agent has no package allowlist. Enable registry mode first.                                                                                                             |
| `plan_failed`                                                 | The lockfile plan didn't answer properly. See [Error codes](#error-codes); retry.                                                                                                                                |
| `plan_refused` (result `refused`)                             | The plan refused at least one package under the agent's current policy (not allowlisted, too new, advisory). Fix the allowlist or policy; no snapshot is used.                                                   |
| `cache_unavailable`                                           | The proxy has no cache for this run: the switch is off, there is no blob store, or the run's flag or image is missing. Check `WARDBY_DEPENDENCY_CACHE` and `BLOB_STORE` on the proxy.                            |
| `plan_required`, `sealed`                                     | The proxy refused a lookup because the lockfile wasn't approved by a plan, or the window was already sealed. Usually the preparation was cut short.                                                              |
| `lookup_failed`, `download_failed`                            | The proxy or the blob store answered unexpectedly. Check the proxy log and the store's permissions.                                                                                                              |
| `size_mismatch`, `sha_mismatch`                               | The download didn't match its recorded size or digest. It is not used, and the proxy deletes the damaged snapshot. Repeats point at the blob store.                                                              |
| `too_large`                                                   | A snapshot is larger than the maximum the proxy reported. Raise `WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB` if that is intended.                                                                                   |
| `unsafe_archive`                                              | The archive failed a safety rule or its extracted tree didn't verify. Runs install `cold` instead until it ages out and is rebuilt. A package shipping two files that differ only in case is not cached.         |
| `over_budget`                                                 | The unpacked snapshot is larger than the disk budget. Raise the agent's `workspaceDiskMb`.                                                                                                                       |
| `inconsistent`                                                | The tree doesn't match the committed lockfile. A restored one is discarded and the project installs `cold`; a `cold` one is kept for the agent but not stored.                                                   |
| `install_failed`                                              | `npm ci`, or the `npm install` that updates a nearest snapshot, exited non-zero. The agent installs for itself and sees the real error.                                                                          |
| `budget_unknown`, `budget_too_small`                          | The run's workspace disk couldn't be measured, under 64 MiB would remain, or too little is left for an install (see "Other bounds" above). The workspace is unchanged. Raise `workspaceDiskMb`.                  |
| `timeout`, `cancelled`                                        | A step or the preparation's bound (20 minutes, or half the time left before the run's deadline) ran out, or the run was cancelled.                                                                               |
| `internal_error`, `worker_error`                              | Something unexpected in the worker, including a full disk or inode table. The run continues without the cache; check the worker's log.                                                                           |
| `tool_unavailable`                                            | Claude Code only: the tool-runner image predates the cache or is a custom image without it. Rebuild it `FROM` the current tool-runner image. The proxy still seals the window on the run's first model request.  |
| `report_invalid`                                              | The worker's report was malformed and was replaced by this code.                                                                                                                                                 |
| `already_started`                                             | A command ran before preparation finished. Not expected in normal operation.                                                                                                                                     |
| `invalid_deadline`                                            | Claude Code only: the worker passed the tool runner a deadline it couldn't read. Not expected; the worker and tool runner images are from different releases.                                                    |
| `worker_input_failed` (the run's error, not a project reason) | The run failed before the agent started: a Codex or Claude Code worker image older than the cache, or a `workerImageRef` image not rebuilt from a release that includes it. See [Worker images](#worker-images). |

For `rebuild`, `failed`, `timeout` and `unsealed` mean native add-ons may be
unbuilt; the agent can run `npm rebuild` itself.

The proxy answers its `/cache/npm/` routes with `{"error": "<code>"}` and a
`404 not_found` when the cache is off; those codes show up as the reasons
above, never to the agent.

## What the agent can then run

Inside the run, `npm install <package>` and `pip install <package>` (into
`/workspace/.venv`) work exactly as they would against the real registries,
for anything reachable from the allowlist. Installed `node_modules`, the
`.venv`, and package-manager caches are never collected: they don't count
toward workspace size or checks, and they're never part of the resulting
commit or diff. The agent's shells get `TMPDIR` pointed at the workspace's
`.cache/tmp` rather than the sandbox's small in-memory `/tmp`, since an
install like `pip install -e '.[test]'` unpacks and builds in `TMPDIR` and
can otherwise run out of space on a large package; that directory counts
toward the run's `workspaceDiskMb` and, like the rest of `.cache`, is never
collected either.

### Python installers: pip, uv and Poetry

The `node-python` worker images ship pip (inside a virtual environment) and
uv. The worker points both at the registry for every run:

| Setting                         | Client | What it does                                                                  |
| ------------------------------- | ------ | ----------------------------------------------------------------------------- |
| `PIP_INDEX_URL`                 | pip    | The registry, with the run's registry-only token, as the only index           |
| `PIP_ONLY_BINARY=:all:`         | pip    | Wheels only; source distributions are never installed                         |
| `UV_DEFAULT_INDEX`              | uv     | The same registry URL as `PIP_INDEX_URL` (uv reads none of pip's settings)    |
| `UV_NO_BUILD=1`                 | uv     | Wheels only from the index; the project itself still builds                   |
| `PIP_CACHE_DIR`, `UV_CACHE_DIR` | both   | Caches under the workspace's `.cache`, never collected                        |
| `UV_PYTHON_DOWNLOADS=never`     | uv     | uv never tries to download a Python interpreter (the sandbox can't reach one) |

These are set by the worker, not by an operator, and an agent's or
service's own environment can't override `PIP_*` or `UV_*` names.

What works, and what doesn't yet:

- **`pip install <package>`, `pip install -r requirements.txt` with
  top-level requirements, and `uv pip install …`** resolve top-down, so
  every dependency is allowed by the time it is requested.
- **A fully pinned requirements file** (`pip-compile`, `uv pip compile` or
  `pip freeze` output, with or without `--hash`) lists transitive packages
  as top-level lines, which pip and uv request before reading any parent's
  metadata. Verify it first, as npm lockfiles are: `uv pip install -r` and
  `uv pip sync` do this themselves (see below); for pip, run
  `wardby-packages plan requirements.txt` before `pip install -r
requirements.txt` (pip has no hook, and in the worker it only exists
  inside a virtual environment). The worker tells the agent so.
- **`uv sync`, `uv run`, `uv add`, `uv remove` and `uv lock` with a
  committed `uv.lock`** work: the worker's `uv` is a small shim
  (`/opt/wardby/bin/uv`) that verifies the lock first. uv installs a locked
  project from the file URLs the lock records, never from its index, so for
  the command the shim also points the lock's PyPI URLs at the registry
  (without credentials; uv sends the index's), and afterwards puts the file
  back: exactly as it was when uv left it alone, otherwise with PyPI's URLs
  (a file the lock already had keeps its URL; a new one gets PyPI's
  redirecting `files.pythonhosted.org/packages/<tag>/<letter>/<name>/<file>`
  path). Before the workspace is collected, any registry URL left in a
  `uv.lock` is rewritten the same way, so a committed lock never names the
  registry.
- **`pip install .`, `uv sync`, `uv run` and other project installs** build
  the project, which installs its build backend (`[build-system] requires`:
  `hatchling`, `setuptools`, `poetry-core`, …) and whatever the backend asks
  for while building (hatchling asks for `editables` for an editable install,
  which `uv sync` and `uv run` do). A lockfile doesn't record these, so
  allowlist them like any other package.
- **Poetry** is not supported in the sandbox: it can't be pointed at the
  registry by environment alone (it needs a primary source in
  `pyproject.toml` plus credentials), and a `poetry.lock` (or a
  `pylock.toml`) is refused by the plan with `wardby_lockfile_unsupported`.
  Export a pinned requirements file, or use uv.

A Python lockfile plan (`POST /registry/pypi/-/plan`) trusts nothing the
file claims, like an npm one, with these differences:

- **Entries.** A `uv.lock` (`version = 1`): every package from PyPI (or the
  registry). Its own projects (editable, virtual and directory sources) are
  where the lock starts; a package from git, a URL, a path or another index
  is refused with `wardby_lockfile_entry_unsupported`. A requirements file:
  every exact `name==version` line (options, `-r`/`-c` includes, local
  projects and unpinned lines are not entries; pip resolves those the usual
  way, so plan an included file separately); a `name @ url` line is refused.
- **Facts.** Each pinned release is read from PyPI's JSON API
  (`pypi.org/pypi/<name>/<version>/json`, stored for reuse): its dependency
  lines (`requires_dist`) and its wheels. A release with no wheel is refused
  with `wardby_file_not_allowed`; its publish time, for the release-age
  check, is its earliest wheel's. Hashes a lockfile records are not compared
  (pip and uv check them on install).
- **Edges and extras.** A dependency line counts when the locked version is
  inside its specifier (a pinned pre-release included). Extras follow the
  same rule as the dependency walk: a line gated on an extra (`extra ==
"test"`) is followed only for an install with that extra, and extras are
  followed only along a chain that starts at an allowlist entry naming them
  (`psycopg[binary]`).
- **Approvals are names.** An approved package is allowed by name for the
  run; its downloads still go through every usual check (wheels only, each
  file's own release age, the index's sha256, advisories). A pin refused as
  too new or with no wheel is named in the plan's output with its reason.

**Why an install was refused.** npm prints the registry's refusal body, so
the agent sees the code and the hint. pip doesn't (a refused package shows
as `from versions: none`), and uv shows only `403 Forbidden`. So the worker
tells the agent to run `wardby-packages` after an install that failed
without saying why: it lists the packages the registry refused for the run
in the last 15 minutes, each with its code and what to do. For a Claude Code
agent, the tool runner also adds those lines to any failed command's output
by itself. The command reads the run's registry-only token from the worker's
environment and sends it only to the registry.

The registry also records what it hides from a Python index, which pip and
uv report only as "no versions": a package whose allowed versions publish
only source distributions (`wardby_file_not_allowed`), or whose every wheel
is newer than the release-age limit (`wardby_version_filtered`). One case
stays unrecorded: a single pinned version withheld while others are listed
(`jinja2==2.10` with a blocking advisory), since the registry never sees
the client's pin.

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
  An approver can accept specific advisories for one agent with
  `packagePolicy.acceptedAdvisories` (see
  [Accepting advisories](#accepting-advisories)); malware is never waivable,
  and every waiver is reported in the run's packages and in the pull request.
- **Wheels only for Python.** PyPI source distributions (sdists), which can
  run arbitrary code at install/build time, are never served — only wheels.
  The index still lists them, so a `uv.lock` uv writes in a run keeps them
  as one written against PyPI does, but a download of one is refused with
  `wardby_file_not_allowed`.
- **npm install scripts are off, but only by configuration.** The proxy sets
  `npm_config_ignore_scripts=true` in the agent's environment, which disables
  npm's (and pnpm's) install-time script hooks; `YARN_IGNORE_SCRIPTS` and
  `YARN_ENABLE_SCRIPTS=false` do the same for yarn classic and yarn Berry. This is a configuration default, not
  something the proxy can enforce on the downloaded tarball itself: the
  proxy cannot strip scripts from a package, so an agent that deliberately
  overrode this setting could still run one. A script that ran would still be
  confined to the same sandbox — no network, no credentials, only the
  workspace writable — but this is a documented limit, not a guarantee.
  The one exception is the [dependency cache](#dependency-cache)'s
  `npm rebuild`, which Wardby runs itself before the agent starts.

## Operator limits

These per-run limits protect the proxy process and are configured with
environment variables (defaults shown); they're enforced by the single proxy
process handling the run, counting files and bytes currently in flight as well
as what's already been recorded, so parallel downloads (for example npm's
default concurrent connections) can't add up to more than the limit before any
one of them finishes:

| Setting                        | Default | Meaning                                                        |
| ------------------------------ | ------- | -------------------------------------------------------------- |
| `REGISTRY_MAX_FILE_MB`         | 200     | Largest single downloaded file.                                |
| `REGISTRY_MAX_TOTAL_MB`        | 2048    | Total bytes downloaded in one run.                             |
| `REGISTRY_MAX_FILES`           | 5000    | Total files served in one run.                                 |
| `REGISTRY_IDLE_TIMEOUT_MS`     | 120000  | Idle time allowed on one download.                             |
| `REGISTRY_AUDIT_FAIL_OPEN`     | `false` | Allow-and-report instead of refusing when OSV is unreachable.  |
| `REGISTRY_METADATA_TIMEOUT_MS` | 30000   | Time allowed for one metadata or OSV request, body included.   |
| `REGISTRY_MAX_METADATA_MB`     | 64      | Largest metadata or OSV response the proxy reads.              |
| `REGISTRY_MAX_GRAPH_PACKAGES`  | 3000    | Package names the graph walk may expand per run and ecosystem. |
| `REGISTRY_GRAPH_TIMEOUT_MS`    | 180000  | Time one download's graph walk may take.                       |
| `REGISTRY_DB_POOL_MAX`         | 3       | Database connections for the registry's own pool.              |
| `CODING_PROXY_DB_POOL_MAX`     | 5       | Database connections for the budget ledger (model requests).   |
| `REGISTRY_PLAN_MAX_ENTRIES`    | 5000    | Entries a lockfile plan (`POST /-/plan`) may have.             |
| `REGISTRY_PLAN_TIMEOUT_MS`     | 120000  | Time allowed for one lockfile plan.                            |
| `REGISTRY_PLAN_MAX_PER_RUN`    | 20      | Lockfile plans one run may make.                               |

A large allowlist can reach the package bound: the walk follows every kept
version in each range plus optional and peer dependencies, so a graph is
usually several times larger than one install. Allowlist the packages a
project needs directly, or raise `REGISTRY_MAX_GRAPH_PACKAGES` (which costs
proxy memory and walk time).

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
  "packageRefusals": [
    {
      "ecosystem": "npm",
      "name": "left-pad",
      "reason": "wardby_package_not_allowed",
      "hint": "The package is not on the agent's allowlist and no allowlisted package the run resolved depends on it. The agent's owner must allowlist the package directly; retrying will not help."
    }
  ]
}
```

`hint` says what the refusal code means and what to do about it; it is
present for the allowlist codes below and omitted for codes without guidance.
`size` is the number of bytes served, or `null` if none was recorded.
`get_run` also returns `packagePlan: { "approved": <n>, "refused": <n> }`:
the exact versions lockfile plans approved for the run, and the distinct
entries they refused (each refusal is also in `packageRefusals`). A run with
[package audit mode](#package-audit-mode) on also returns `packageAuditMode`
and `packageAudit`, and its pull request opens with a caution banner listing
the packages installed outside the allowlist.

The pull request finalization also appends a collapsed **Packages installed
during this run** section listing the same information, so a reviewer
doesn't have to ask the agent what it added. It lists at most 100 packages
and 100 refusals, followed by "…and N more — see get_run for the full list";
`get_run` always has the complete list. If the report can't be loaded or
rendered, the section is left out and the pull request is still opened.

A later run on the same pull request (a review fix round, a mention
follow-up, a continuation) rewrites the section as **Packages installed by
wardby's runs on this pull request**: every package installed by the runs
that pushed to the pull request plus the latest run's, each package and
version once. Refusals, and the warning below, cover the latest run only. See
[How the pull request description is kept current](code-review-agents.md#how-the-pull-request-description-is-kept-current).

When the registry refused anything during the run, the pull request also
opens with a **Dependency install incomplete** warning, above the agent's
summary. It names the refused packages grouped by refusal code, says what
each code means (in the same terms as `hint`), and notes that failed checks under **Tests** may come from
the sandbox rather than the change. If the run changed a lock file
(`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`,
`poetry.lock`, `uv.lock` or `Pipfile.lock`), the warning names it: the lock
file may be missing entries, so a clean install in CI can fail until it is
regenerated outside the sandbox. Wardby writes this from the registry's
records and the run's diff, not from the agent's summary.

Review agents see the pull request's CI results through `repo_pr_read`
(`ci`), and its note tells them to trust CI over a sandbox **Tests**
failure; see
[code-review-agents.md](code-review-agents.md#the-repo_-tools).

GitHub and Jira status comments show a package-registry blocked message only
when no pull request resulted and a coding child reported no changes or failed.
Otherwise, recorded refusals add a dependency install warning while preserving
the agent's reply or answer, or the pull request link. A recorded refusal alone
does not mean the final install or the run failed.

A package that is only reachable through a refused one is refused too, as
`wardby_package_not_allowed`. When a dependency deep in a toolchain has a
high-severity advisory and no fixed version, every run that installs that
tree is refused at the same place; approving more packages won't help.

## Error codes

npm prints the proxy's error body verbatim, so these are what you'll see on
a failed npm install. pip and uv don't print it: `wardby-packages` lists the
same codes for the run (see
[Python installers](#python-installers-pip-uv-and-poetry)), and so do
`get_run` and the pull request.

| Code                                 | Status | Meaning / what to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wardby_package_not_allowed`         | 403    | The package isn't on the allowlist and wasn't declared by a package already resolved in the run (a new top-level package must be allowlisted itself), or is only reachable through a refused package. Final: the agent's owner must allowlist it. For a package the project adds directly, allowlist the package itself; allowlisting a dependent only helps for a package something already in the project depends on. For a PyPI package an extra pulls in (`psycopg-binary` for `psycopg[binary]`), name the extra on the entry instead. |
| `wardby_package_not_allowed_pending` | 403    | Only for a download the run hasn't resolved (a lockfile install), or a metadata request after a lockfile plan of the run failed or refused an entry: the dependency walk stopped before reaching the package, so it may still be reachable. Not transient and retrying rarely helps: the owner should allowlist the package directly.                                                                                                                                                                                                       |
| `wardby_file_not_allowed`            | 403    | The specific file type is never served for this ecosystem (for example a PyPI sdist). Nothing to configure; use a wheel.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `wardby_version_filtered`            | 404    | Every matching version is too new (younger than `minReleaseAgeDays`) or withheld by the vulnerability audit. Wait for it to age past the threshold, or lower `minReleaseAgeDays` if you understand the risk.                                                                                                                                                                                                                                                                                                                                |
| `wardby_package_not_found`           | 404    | The upstream registry has no such package name. Check the spelling (npm names are case-sensitive).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `wardby_package_too_large`           | 413    | The file exceeds `REGISTRY_MAX_FILE_MB`. Ask the operator to raise it if the file is legitimately larger.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `wardby_package_limit`               | 429    | The run hit `REGISTRY_MAX_FILES` or `REGISTRY_MAX_TOTAL_MB`. Trim what the run installs, or ask the operator to raise the limit.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `wardby_audit_unavailable`           | 503    | OSV couldn't be reached and `REGISTRY_AUDIT_FAIL_OPEN` isn't set. Retry, or have the operator set that flag if the outage is expected to be long. Also returned, as "could not be checked against this agent's approved dependency graph… try again", when the audit failed while resolving a lockfile install's dependency graph.                                                                                                                                                                                                          |
| `wardby_graph_incomplete`            | 503    | Only for a download the run hasn't resolved (a lockfile install), or a metadata request after a lockfile plan of the run failed or refused an entry: a dependency the walk reached but timed out (`REGISTRY_GRAPH_TIMEOUT_MS`) before checking its versions, usually a slow or failing upstream for that package. Retry shortly; npm retries 5xx on its own. Never means the package is outside the graph.                                                                                                                                  |
| `wardby_graph_limit`                 | 403    | Only for a download the run hasn't resolved (a lockfile install), or a metadata request after a lockfile plan of the run failed or refused an entry: the dependency graph is over `REGISTRY_MAX_GRAPH_PACKAGES` for this run. This run's walk reached the limit before the package, so it may not be in the graph. Permanent for the run, so retrying won't help: the owner can allowlist the package directly, or the operator can raise the limit.                                                                                        |
| `wardby_lockfile_unsupported`        | 400    | The lockfile sent to `POST /-/plan` isn't one the plan reads: a `package-lock.json` with lockfileVersion 2 or 3 (and a `packages` section), a `pnpm-lock.yaml` with lockfileVersion 6 or 9, or a yarn classic or yarn 2+ `yarn.lock`; for PyPI, a `uv.lock` (version 1) or a pinned requirements file (a Poetry `poetry.lock` or a `pylock.toml` is refused). Regenerate it with a current client. The install still runs, but downloads and, for the rest of the run, metadata requests fall back to the slower walk.                      |
| `wardby_lockfile_too_large`          | 413    | The lockfile is over 20 MiB or has more than `REGISTRY_PLAN_MAX_ENTRIES` entries. The install still runs, but downloads and, for the rest of the run, metadata requests fall back to the walk.                                                                                                                                                                                                                                                                                                                                              |
| `wardby_lockfile_integrity_mismatch` | —      | A plan refusal: the lockfile's `integrity` for this entry isn't the registry's own (or the registry publishes none, or the lockfile records none; a yarn 2+ `yarn.lock` is never checked this way, see [pnpm and yarn](#pnpm-and-yarn)). Regenerate the lockfile entry; never edit integrity by hand.                                                                                                                                                                                                                                       |
| `wardby_lockfile_entry_unsupported`  | —      | A plan refusal: the entry is installed from git, a URL or a path, or isn't an exact registry version. Only registry packages can be approved.                                                                                                                                                                                                                                                                                                                                                                                               |
| `wardby_plan_limit`                  | 429    | The run has made `REGISTRY_PLAN_MAX_PER_RUN` lockfile plans. The install still runs, but downloads and, for the rest of the run, metadata requests fall back to the walk.                                                                                                                                                                                                                                                                                                                                                                   |
| `wardby_registry_integrity_missing`  | —      | A plan refusal: npm publishes no integrity for this version, so a download of it couldn't be checked.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `wardby_plan_in_progress`            | 429    | A lockfile plan is already running for this run (one at a time). Wait for it; the install still runs, but downloads and, for the rest of the run, metadata requests fall back to the walk.                                                                                                                                                                                                                                                                                                                                                  |
| `wardby_plan_incomplete`             | 503    | The plan didn't finish within `REGISTRY_PLAN_TIMEOUT_MS` (or the client went away), or a `pnpm-lock.yaml` or `yarn.lock` wasn't read within 15 seconds (see [pnpm and yarn](#pnpm-and-yarn); a retry of that lockfile won't help). What was verified is kept, so a retry resumes; the install still runs, but downloads and, for the rest of the run, metadata requests fall back to the walk.                                                                                                                                              |
| `wardby_bad_request`                 | 400    | The request path is malformed (bad percent-encoding, or not a valid package name). A client or agent bug, not a package choice.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `wardby_upstream_error`              | 502    | The upstream registry answered with an error, or the download failed partway. Retry. Also returned, as "could not be checked against this agent's approved dependency graph… try again", when the registry failed while resolving a lockfile install's dependency graph.                                                                                                                                                                                                                                                                    |
| `wardby_upstream_unavailable`        | 504    | The upstream registry didn't answer a metadata request within `REGISTRY_METADATA_TIMEOUT_MS`. Retry.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `wardby_metadata_too_large`          | 502    | The package's metadata document is larger than `REGISTRY_MAX_METADATA_MB`. Ask the operator to raise it.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `wardby_upstream_host_not_allowed`   | 502    | The file's download URL points outside that ecosystem's own upstream hosts, so the proxy won't fetch it.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `invalid_capability`                 | 401    | The run's registry token doesn't match a live session (the run has ended or the token is malformed). Not something a package choice can fix.                                                                                                                                                                                                                                                                                                                                                                                                |

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
