---
id: coding-packages
title: Approve packages for coding agents
summary: Let coding workers install vetted npm (also with pnpm or yarn) and PyPI dependencies through Wardby's registry proxy.
audience: operator
tags: [coding-agents, packages, npm, pnpm, yarn, pypi, uv, supply-chain, refusals, lockfile, extras, pip-extras]
appliesTo: >=0.2.1
---

# Approve packages for coding agents

Coding workers have no direct registry network access. Wardby's registry
proxy can allow `npm install` (or `pnpm`/`yarn`) and `pip install` from a
per-agent npm or PyPI allowlist. The proxy records what was fetched and applies
supply-chain checks, including package graph validation, release-age policy,
and vulnerability filtering.

An empty allowlist keeps registry mode off. Approve only top-level packages;
Wardby validates and permits the required transitive dependency graph for the
run. A package the project adds as a new top-level dependency must itself be
approved (or already be in the verified lockfile), even if an approved
package depends on it: when npm asks for a package that is not approved and
was not declared by a package already resolved in the run, Wardby refuses it
at once with `wardby_package_not_allowed`. Changing a package allowlist or
policy needs `packages:approve` (or `agents:admin`) and a Wardby `admin` or
`package-approver` role.

If the repository uses npm `overrides`, also approve each overridden package:
an override installs a version its parent doesn't ask for, so Wardby approves
it, and what it depends on, only when its name is on the allowlist.

Registry mode works for Codex and Claude Code runs alike, on the `node`
toolchain (npm) and the `node-python` toolchain (npm and pip). Claude Code runs
its shell commands in a separate, credential-free tool-runner container that
reaches the registry through the run's proxy network. Use a pinned custom
worker image when an agent needs system packages, another runtime, or
dependencies that should be baked into the image.

When the registry refuses a package, the pull request opens with a
**Dependency install incomplete** warning naming each refused package and
any lock file the run changed. A changed lock file may then fail a clean
install in CI until it is regenerated, and the run's status comment shows ⚠️
if its own checks failed. A package reachable only through a refused one is
refused too, so a high-severity advisory deep in a toolchain blocks every run
that installs it.

## Allowlist refusals

Four codes say a package could not be reached through the allowlist. The agent
should stop on all of them except `wardby_graph_incomplete`; the owner fixes
them by allowlisting the package directly (`update_agent`,
`codingProfile.packageAllowlist`). Each code has an article under `errors/` (for example `errors/package-not-allowed-pending`), available from release 0.6.1.

- `wardby_package_not_allowed`: not on the allowlist and not declared by a package already resolved in the run, or only reachable through a refused package.
- `wardby_package_not_allowed_pending`: the dependency walk stopped before reaching it; retrying rarely helps.
- `wardby_graph_limit`: the dependency graph is over `REGISTRY_MAX_GRAPH_PACKAGES`.
- `wardby_graph_incomplete`: still being checked; retry shortly.

The last three arise only when the proxy walks the dependency graph: for a
tarball download the run hasn't resolved (a lockfile install the plan did not
approve), or for a metadata request after a lockfile plan of the run failed
or refused an entry. Otherwise a metadata request never walks. A
lockfileVersion 1 lockfile can't be planned, so regenerate it with a current
npm to avoid the slower walk.

To find out which packages a task needs without a round of refusals for each
one, turn on package audit mode for a limited time (from Wardby 0.6.1): the
registry installs packages outside the allowlist and records them for you to
approve. Read the `package-audit-mode` help article, "Package audit mode".

## pnpm and yarn

From Wardby 0.6.1, pnpm, yarn classic (1.x) and yarn 2 or later (Berry, with
node-modules or Plug'n'Play) install from the same npm allowlist as npm, and
their lockfiles are verified the same way: before `pnpm install`/`add` or
`yarn`/`yarn install`/`yarn add`, the worker's shim sends `pnpm-lock.yaml`
(lockfileVersion 6 or 9) or `yarn.lock` to the registry, which approves its
exact versions, so `pnpm install --frozen-lockfile`, `yarn install
--frozen-lockfile` and `yarn install --immutable` need no slow graph walk.

- The stock images have npm, yarn classic and corepack. The shim runs pnpm,
  and a yarn 2+ release a project pins in `packageManager`, through corepack,
  which downloads it through the registry: allowlist `pnpm` or
  `@yarnpkg/cli-dist` (or bake the tool into a custom worker image).
- yarn 2+ records yarn's own `checksum`, not npm's integrity: its plan
  approves exact versions, and each download is checked against the
  registry's integrity.
- yarn 2+ adds an implicit `node-gyp` dependency to packages with install
  scripts (such as `fsevents`); allowlist `node-gyp` when the lockfile has it.
- Install scripts stay off for every client, and lockfiles a run commits
  name only public registry URLs.

See [pnpm and yarn](../docs/coding-packages.md#pnpm-and-yarn) for each
client's settings and the plan's rules.

## PyPI extras

A PyPI entry may name extras, as pip does: `psycopg[binary]`,
`uvicorn[standard]>=0.30`. An extra allows only the dependencies that
package's own metadata declares under that extra (for `psycopg[binary]`, the
`psycopg-binary` wheel); a bare `psycopg` entry follows no extra, so
`psycopg-binary` is refused with `wardby_package_not_allowed`. A plain entry
follows no extras at all, its own or its dependencies': a plain `fastapi`
whose metadata asks for `uvicorn[standard]` gets bare `uvicorn` only. Extras a
dependency line names are followed only below an entry that names extras
(`fastapi[standard]`), once the proxy has served that parent's metadata: if
an extra's packages are still refused with `403 wardby_package_not_allowed`,
name the extra on the allowlist directly (`uvicorn[standard]`). Every
safeguard still applies to what an extra adds. Extras need the coding proxy
and control plane on the same Wardby version: a proxy from before extras
support cannot load an allowlist with a `name[extra]` entry, so every registry
request of that run fails; and once a profile stores an extras entry, do not
downgrade below the release that added extras.

## Python: pip and uv

The `node-python` images ship pip (used in a virtual environment) and uv,
and the worker points both at the registry (`PIP_INDEX_URL`, and
`UV_DEFAULT_INDEX` with `UV_NO_BUILD=1` for wheels only). Top-level installs
work with either: `pip install -r requirements.txt`, `uv pip install …`.

- **Fully pinned requirements** (`pip-compile`, `pip freeze`) list
  dependencies as top-level lines, so the file is verified first, like an
  npm lockfile: `uv pip install -r` does it itself; for pip, run
  `wardby-packages plan requirements.txt` first. Every pin the allowlist
  reaches is then allowed; the rest are named with their reason (too new,
  no wheel, not reachable).
- **`uv sync`, `uv run`, `uv add` with a committed `uv.lock`** work: the
  worker's `uv` verifies the lock and points its PyPI URLs at the registry
  for the command, then puts the file back (a committed lock never names
  the registry).
- **Project installs** (`pip install .`, `uv sync`, `uv run`) need the build
  backend from `[build-system] requires` (`hatchling`, `setuptools`, …)
  allowlisted, plus what it asks for while building (hatchling: `editables`
  for an editable install).
- **Poetry** doesn't work in the sandbox, and a `poetry.lock` or
  `pylock.toml` can't be verified (`wardby_lockfile_unsupported`): export a
  pinned requirements file, or use uv.

pip and uv don't print why the registry refused a package (pip says
`from versions: none`, uv `403 Forbidden`). The agent is told to run
`wardby-packages`, which lists the run's recent refusals with their codes
and hints; a Claude Code agent also gets those lines after any failed
command. The registry also records packages it hides from the index: one
with only source distributions (`wardby_file_not_allowed`), or whose every
wheel is too new (`wardby_version_filtered`).

The quickstart's coding step offers the packages a local repository declares
(`package.json`, `pyproject.toml` including its build-system packages,
`requirements*.txt`, keeping Python extras such as `psycopg[binary]`) as
`local-builder`'s allowlist after asking, or with `--allow-repo-packages` in a non-interactive
run. See [Local repositories](local-repositories.md).

> Re-running the quickstart replaces `local-builder`'s package allowlist with
> what the repository declares (or empties it), discarding any packages you
> added with `update_agent`; re-add them after a re-run.

Review agents see the pull request's CI results in `repo_pr_read` and are
told to trust CI over the sandbox's **Tests**.

## Accepting advisories

From Wardby 0.6.1, a version withheld only by a high or critical advisory
(refused with `wardby_version_filtered`) can be served for one agent once an
approver accepts the advisory. Set `codingProfile.packagePolicy.acceptedAdvisories`
with `create_agent` or `update_agent` (needs `packages:approve` or
`agents:admin`):

```json
{
  "codingProfile": {
    "packagePolicy": { "minReleaseAgeDays": 3, "acceptedAdvisories": ["GHSA-xxxx-xxxx-xxxx"] }
  }
}
```

- `update_agent` replaces `packagePolicy` as a whole: send the full object
  (omitting `minReleaseAgeDays` resets it to the default 3). To remove a
  waiver, re-send the whole object without that id.

- Up to 32 unique ids (`GHSA-…`, `CVE-…`, `PYSEC-…`), matched case-sensitively
  against an advisory's id and its aliases.
- A version is served only when every blocking advisory is accepted; the
  refusal names the ones still blocking.
- Malware is never waivable: `MAL-…` ids are rejected, and malware advisories
  stay blocked even if listed.
- Waivers show as `acceptedAdvisories` per package in `get_run` and in an
  **Accepted advisories** section of the pull request. The policy is fixed
  when a run starts.
- Find the id from the package named in the refusal: `https://osv.dev/list?q=<package>`
  or `npm audit`. Accept only after judging the exposure (for example, a
  build-time-only dependency), and remove the entry once a fixed version ships.

Read [`docs/coding-packages.md`](../docs/coding-packages.md) for allowlist
syntax (including [PyPI extras](../docs/coding-packages.md#pypi-extras)), package-policy controls, lockfile behavior, and refusal errors.

## Dependency cache

From Wardby 0.6.1, a coding agent can start with `node_modules` already
restored from a verified snapshot instead of running `npm ci`. Read the
`dependency-cache` help article, "Dependency cache for coding runs".

## Blocked status comments

If a coding child records package refusals, reports no changes or fails, and no
pull request or pushed changes result, GitHub and Jira status comments show
⛔ **Blocked by the package registry: no changes were made.** Otherwise, the
status keeps the agent's reply or answer, or the pull request link, and adds a
⚠️ dependency install warning. Refusal lists show at most ten distinct entries and a count
of the rest; `get_run` has the full list.

For next steps, see [Package refusal errors](errors/package-refusals.md) and
[Run status comments](status-comments.md). After an approver updates the
agent's allowlist or policy, mention `@wardby` again to start a new attempt.
