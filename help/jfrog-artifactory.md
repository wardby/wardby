---
id: jfrog-artifactory
title: Private packages from JFrog Artifactory
summary: Let Claude Code runs install private npm and PyPI packages from a JFrog Artifactory through Wardby's registry proxy, with the credential kept on the proxy.
audience: operator
tags: [packages, artifactory, jfrog, private-packages, npm, pypi, scopes, credentials]
appliesTo: ">=0.10.2"
---

# Private packages from JFrog Artifactory

Set these on the coding proxy (and the first three also on the launcher host)
to install private packages in Claude Code runs. Nothing set means public npm
and PyPI, as before.

| Setting                         | Meaning                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `REGISTRY_JFROG_URL`            | HTTPS base URL with the context path, e.g. `https://your-org.jfrog.io/ctx`. |
| `REGISTRY_JFROG_NPM_REPO`       | npm repository key, e.g. `npm-local`.                                       |
| `REGISTRY_JFROG_NPM_SCOPES`     | Scopes served by it, e.g. `@your-org`. Required with the repository.        |
| `REGISTRY_JFROG_PYPI_REPO`      | PyPI repository key, e.g. `pypi`. Replaces public PyPI.                     |
| `REGISTRY_JFROG_PYPI_TRUST_ALL` | `true` allows every package the PyPI repository serves (default `false`).   |
| `REGISTRY_UPSTREAM_USERNAME`    | Proxy only: `env:NAME` reference to the username.                           |
| `REGISTRY_UPSTREAM_PASSWORD`    | Proxy only: `env:NAME` reference to the password or token (Basic auth).     |

- npm names in the listed scopes come only from Artifactory, with the
  credential; every other name comes from public npm without it.
- The credential never reaches the worker or tool runner, and is sent only to
  the Artifactory host.
- The allowlist, release-age rule and OSV audit still apply. If OSV does not
  answer, a private-scope name is not refused.
- By default every PyPI package needs an allowlist entry. With
  `REGISTRY_JFROG_PYPI_TRUST_ALL=true` the whole PyPI repository is trusted for
  every agent on the proxy: use it only for a curated repository, since one
  that proxies public PyPI unfiltered would allow all of PyPI. Release age, OSV
  and wheels-only still apply.
- The credential settings are `env:NAME` references: the variables they name
  must be set in the proxy's environment too. The `deploy/local/` Compose files
  pass them through to the proxy from the shell, so export them first. Pass
  them to the proxy only.
- The proxy refuses to start on an invalid or incomplete setting.

A `uv.lock` a run changes is written back with the Artifactory addresses (the
simple index as `registry`, and each file's own Artifactory URL), for Claude
Code and Codex alike, including private packages and versions the committed
lock did not have. If the proxy cannot give an address the run fails with
[`coding_pypi_lockfile_unresolved`](errors/coding-pypi-lockfile-unresolved.md).

Limitations: Codex runs are not covered for npm yet (use Claude Code), and a
repository's own `.npmrc` that maps a scope to Artifactory is not routed
through the proxy, so those installs fail. The PyPI index must serve the JSON
Simple API (PEP 691).

`uv sync` and `uv run` go straight to an index named in a project's `uv.lock`
or `pyproject.toml`, not through the proxy: export the locked versions and run
`uv pip install --no-config` from outside the repository instead. A locked
version with a blocking advisory is withheld, and uv reports it as
unsatisfiable until the advisory is accepted for the agent. Details in
[`docs/coding-packages.md`](../docs/coding-packages.md#uv-and-poetry).

Redirect downloads: if Artifactory answers a download with a redirect to a
signed cloud-storage URL, the proxy follows that one redirect to an HTTPS URL,
without the credential. Any other redirect, or one from that URL, is refused.

Read [`docs/coding-packages.md`](../docs/coding-packages.md#private-packages-from-jfrog-artifactory)
for the full behaviour, and [Approve packages for coding agents](coding-packages.md)
for allowlists. A refused host shows as `wardby_upstream_host_not_allowed`.
