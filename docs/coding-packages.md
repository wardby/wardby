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
   and the image must be pinned by digest.
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
needs the `packages:approve` scope (or `agents:admin`) — holding only
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

An absent or empty allowlist leaves registry mode off for that agent (the
default). Only _top-level_ entries need to be on the allowlist — once a
version is approved, the proxy reads its dependency graph from registry
metadata and grows the run's allowance automatically as npm or pip requests
each dependency's metadata, so you don't have to enumerate transitive
dependencies yourself.

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
- **OSV vulnerability audit.** Every package version is checked against the
  OSV database; versions affected by a **high** or **critical** severity
  advisory are withheld, and lower-severity advisories are allowed but
  reported. If OSV can't be reached, installs in that request fail closed
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

| Setting                    | Default | Meaning                                                       |
| -------------------------- | ------- | ------------------------------------------------------------- |
| `REGISTRY_MAX_FILE_MB`     | 200     | Largest single downloaded file.                               |
| `REGISTRY_MAX_TOTAL_MB`    | 2048    | Total bytes downloaded in one run.                            |
| `REGISTRY_MAX_FILES`       | 5000    | Total files served in one run.                                |
| `REGISTRY_IDLE_TIMEOUT_MS` | 120000  | Idle time allowed on one download.                            |
| `REGISTRY_AUDIT_FAIL_OPEN` | `false` | Allow-and-report instead of refusing when OSV is unreachable. |

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

Every package the proxy served or refused during a run is recorded. `get_run`
returns `packages` (the ecosystem, name, and version of everything served)
and `packageRefusals` (the ecosystem, name, and reason for everything
refused) for a coding run. The pull request finalization also appends a
collapsed **Packages installed during this run** section listing the same
information, so a reviewer doesn't have to ask the agent what it added.

## Error codes

npm and pip print the proxy's error body verbatim, so these are what you'll
see on a failed install:

| Code                         | Status | Meaning / what to do                                                                                                                                                                                         |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wardby_package_not_allowed` | 403    | The package isn't on the allowlist and isn't reachable from an allowlisted package's dependency graph. Add it (or its top-level dependent) to `packageAllowlist`.                                            |
| `wardby_file_not_allowed`    | 403    | The specific file type is never served for this ecosystem (for example a PyPI sdist). Nothing to configure; use a wheel.                                                                                     |
| `wardby_version_filtered`    | 404    | Every matching version is too new (younger than `minReleaseAgeDays`) or withheld by the vulnerability audit. Wait for it to age past the threshold, or lower `minReleaseAgeDays` if you understand the risk. |
| `wardby_package_not_found`   | 404    | The upstream registry has no such package name. Check the spelling.                                                                                                                                          |
| `wardby_package_too_large`   | 413    | The file exceeds `REGISTRY_MAX_FILE_MB`. Ask the operator to raise it if the file is legitimately larger.                                                                                                    |
| `wardby_package_limit`       | 429    | The run hit `REGISTRY_MAX_FILES` or `REGISTRY_MAX_TOTAL_MB`. Trim what the run installs, or ask the operator to raise the limit.                                                                             |
| `wardby_audit_unavailable`   | 503    | OSV couldn't be reached and `REGISTRY_AUDIT_FAIL_OPEN` isn't set. Retry, or have the operator set that flag if the outage is expected to be long.                                                            |
| `invalid_capability`         | 401    | The run's registry token doesn't match a live session (the run has ended or the token is malformed). Not something a package choice can fix.                                                                 |

## Adding an ecosystem

npm and PyPI are the two ecosystems registry mode supports today; the adapter
interface is designed to add more (Composer, RubyGems, Go modules are the
known candidates) without changing the schema or the allowlist format. See
the design spec's [§5 checklist](superpowers/specs/2026-09-25-coding-package-registry-design.md#5-ecosystem-adapters)
for what a new adapter needs to provide and document.
