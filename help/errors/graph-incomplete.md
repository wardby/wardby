---
id: errors/graph-incomplete
title: Package still being checked (wardby_graph_incomplete)
summary: The registry's walk reached the package but timed out before checking its versions, usually a slow upstream; retry shortly.
audience: operator
tags: [error, coding-agents, packages, allowlist, wardby_graph_incomplete]
appliesTo: ">=0.6.1"
---

# Package still being checked

`wardby_graph_incomplete` (HTTP 503) means the requested package is still
being checked against the allowed packages' dependency graph. It arises only when the
registry walks the graph: for a tarball download the run hasn't resolved (a
lockfile install), or for a metadata request after a lockfile plan of the run
failed or refused an entry. The walk reached
the name (an expanded version declares it) but timed out
(`REGISTRY_GRAPH_TIMEOUT_MS`) before the name's own versions were checked. That
is usually a slow or failing upstream for that package, or another request's
walk running out of time. The error message shows the walk's progress. It never
means the package is outside the graph. When a completed walk has failed
nodes, the answer is `wardby_upstream_error` or `wardby_audit_unavailable`
instead.

## What the agent should do

This is the one allowlist-related code worth retrying: try again shortly (npm
retries a 5xx on its own). If it keeps happening, report the package so its
owner can allowlist it directly.

## What the owner does

If retries do not clear it, add the package to
`codingProfile.packageAllowlist` with `update_agent` (needs
`packages:approve` or `agents:admin`).

## Related

- [Package not reached: `wardby_package_not_allowed_pending`](package-not-allowed-pending.md)
- [Not allowed: `wardby_package_not_allowed`](package-not-allowed.md)
- [Graph limit: `wardby_graph_limit`](graph-limit.md)
- [Package audit mode](../package-audit-mode.md): find out which packages a task needs without refusals, for a limited time.
- [Coding packages](../coding-packages.md)
