---
id: errors/graph-limit
title: Dependency graph over the limit (wardby_graph_limit)
summary: The run's dependency graph walk hit REGISTRY_MAX_GRAPH_PACKAGES before reaching the package; the owner can allowlist it directly, or the operator can raise the limit.
audience: operator
tags: [error, coding-agents, packages, allowlist, wardby_graph_limit, REGISTRY_MAX_GRAPH_PACKAGES]
appliesTo: ">=0.7.0"
---

# Dependency graph over the limit

`wardby_graph_limit` (HTTP 403) means this run's dependency graph walk reached
its limit of `REGISTRY_MAX_GRAPH_PACKAGES` package names (default 3000, counted
per run and ecosystem) before it reached the requested package, so the package
may not be in the graph at all. The bound is permanent for the run, so
retrying does not help. It arises only when the
registry walks the graph: for a tarball download the run hasn't resolved (a
lockfile install), or for a metadata request after a lockfile plan of the run
failed or refused an entry.

Large frameworks (for example Expo) can exceed the limit, because the walk
follows every in-range kept version plus optional and peer dependencies, so its
graph is usually several times larger than a single install.

## What the agent should do

Stop retrying. Report the package so its owner can act.

## What the owner does

1. Open the agent with `get_agent`, then add the package (or the top-level package that needs it) to `codingProfile.packageAllowlist` with `update_agent`. This needs `packages:approve` or `agents:admin`.
2. Run the request again. Allowing a package name allows all of its kept versions, subject to the release-age and vulnerability checks.

The operator, not the owner, can instead raise `REGISTRY_MAX_GRAPH_PACKAGES` on the
coding proxy. A higher limit uses more proxy memory and walk time.

## Related

- [Package not reached: `wardby_package_not_allowed_pending`](package-not-allowed-pending.md)
- [Not allowed: `wardby_package_not_allowed`](package-not-allowed.md)
- [Still being checked: `wardby_graph_incomplete`](graph-incomplete.md)
- [Package audit mode](../package-audit-mode.md): find out which packages a task needs without refusals, for a limited time.
- [Coding packages](../../docs/coding-packages.md#operator-limits)
