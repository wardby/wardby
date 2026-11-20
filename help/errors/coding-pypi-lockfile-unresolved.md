---
id: errors/coding-pypi-lockfile-unresolved
title: Coding run left a uv.lock that still names the registry proxy
summary: The registry proxy could not give a real download address for some package in a coding run's uv.lock, so wardby did not collect the changes.
audience: operator
tags: [error, coding-agents, uv, lockfile, registry-proxy]
appliesTo: ">=0.10.2"
---

# Coding run left a uv.lock that still names the registry proxy

`coding_pypi_lockfile_unresolved` means a coding run finished with changes, but
a `uv.lock` in the workspace still names the registry proxy for at least one
package. During a run wardby points an existing `uv.lock` at the proxy, and uv
writes the proxy's URLs for any package it adds or upgrades. Before collecting
the changes, wardby asks the proxy for the real address of every one of those
files (the PyPI or Artifactory URL the proxy itself reads it from) and writes
it back. A pull request with a lock that still names the proxy could not
install outside the sandbox, so the run fails instead of collecting it.

This is not caused by adding or upgrading a dependency: those are expected,
and their addresses are looked up like any other. It means a lookup was
refused or could not be made. With debug tracing on, the run records, for the
lock, how many entries are left and the code the proxy gave for each, for
example `wardby_origin_not_allowed x2`:

- `wardby_origin_not_allowed`: the run was never allowed that project. Add it to
  the agent's package allowlist (see [Approve packages for coding agents](../coding-packages.md)).
- `wardby_origin_file_unknown`: the registry has no such file for the run:
  the version is outside the allowlisted range, is newer than the release-age
  limit, or is withheld by a vulnerability advisory (see accepting advisories
  in the same article), or the file was removed upstream.
- `wardby_origin_url_unsafe`: the registry lists the file at an address the
  proxy will not hand out (not HTTPS, another host, or carrying credentials).
  Check the registry's index settings.
- `wardby_origin_unavailable`, `wardby_origin_unreachable` or
  `wardby_origin_bad_answer`: the registry, the advisory audit or the proxy
  could not be reached or answered something unreadable. Run the task again.
  A proxy older than this check has no such route and shows as
  `wardby_origin_unreachable`: upgrade the proxy.

A run that changed no `uv.lock`, a project without one, and a lock that holds
no proxy URL are not affected. See
[Troubleshoot coding workers](../troubleshooting/coding-workers.md).
