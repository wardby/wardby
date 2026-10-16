---
id: errors/package-not-allowed-pending
title: Package not reached (wardby_package_not_allowed_pending)
summary: The dependency-graph walk stopped before reaching the requested package; the owner should allowlist it directly because retrying rarely helps.
audience: operator
tags: [error, coding-agents, packages, allowlist, wardby_package_not_allowed_pending]
appliesTo: ">=0.6.1"
---

# Package not reached

`wardby_package_not_allowed_pending` (HTTP 403) means the registry's
dependency-graph walk ended before it reached the requested package. The
package may still be reachable from an allowlisted one, but the walk was cut
short (by `REGISTRY_GRAPH_TIMEOUT_MS`), so it was not proven allowed. The error message shows
how many packages were walked and how many were still queued. It arises only when the
registry walks the graph: for a tarball download the run hasn't resolved (a
lockfile install), or for a metadata request after a lockfile plan of the run
failed or refused an entry. Otherwise a metadata request gets
`wardby_package_not_allowed` at once instead.

The answer is final for the agent and is not transient: the walk resumes
within the run, but each request continues the walk for at most
`REGISTRY_GRAPH_TIMEOUT_MS`, so a large allowlist can take several requests or
never finish in time. Retrying rarely helps; allowlisting the package directly
is the reliable fix.

## What the agent should do

Stop retrying. Report the package name so its owner can allowlist it.

## What the owner does

1. Open the agent with `get_agent`, then add the package (or the top-level package that needs it) to `codingProfile.packageAllowlist` with `update_agent`. This needs `packages:approve` or `agents:admin`.
2. Run the request again. Allowing a package name allows all of its kept versions, subject to the release-age and vulnerability checks.

Large frameworks (for example Expo) can have a very large graph, because the
walk follows every in-range version plus optional and peer dependencies.
Allowlisting the packages the project needs directly avoids the walk for them.

## Operator knobs

`REGISTRY_GRAPH_TIMEOUT_MS` is the time one request's walk may take. See
[Operator limits](../../docs/coding-packages.md#operator-limits).

## Related

- [Not allowed: `wardby_package_not_allowed`](package-not-allowed.md)
- [Graph limit: `wardby_graph_limit`](graph-limit.md)
- [Still being checked: `wardby_graph_incomplete`](graph-incomplete.md)
- [Package audit mode](../package-audit-mode.md): find out which packages a task needs without refusals, for a limited time.
- [Coding packages](../coding-packages.md)
