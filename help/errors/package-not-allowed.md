---
id: errors/package-not-allowed
title: Package not allowed (wardby_package_not_allowed)
summary: The coding package registry refused a package because it is not on the agent's allowlist, or is only reachable through a refused package.
audience: operator
tags: [error, coding-agents, packages, allowlist, wardby_package_not_allowed]
appliesTo: ">=0.7.0"
---

# Package not allowed

`wardby_package_not_allowed` (HTTP 403) is a final answer from the package
registry: the package is not on the agent's `packageAllowlist`, and nothing
the run has resolved allows it. It is also returned for a package reachable
only through a package that was itself refused (for example one with a
high-severity advisory).

- When npm resolves a package (a metadata request), the package is refused at
  once unless it is allowlisted, was declared as a dependency by a package
  already resolved in the run, or was approved by the run's lockfile plan. So
  a new top-level package must be allowlisted, even if an allowlisted
  package's dependency graph contains it. (After a lockfile plan of the run
  failed or refused an entry, the metadata request walks the dependency graph
  first, as a download does.)
- When npm downloads a tarball the run has not resolved (a lockfile install),
  it is refused once the dependency-graph walk finds no allowlisted package
  that reaches it.

## What the agent should do

Stop. Do not retry, and do not look for a way around the refusal. Pick an
already-approved alternative, or report that the package needs approval.

## What the owner does

1. Open the agent with `get_agent`, then add the package to `codingProfile.packageAllowlist` with `update_agent`. This needs `packages:approve` or `agents:admin`. For a package the project adds directly, allowlist the package itself; allowlisting a dependent only helps for a package something already in the project depends on.
2. Run the request again. Allowing a package name allows all of its kept versions, subject to the release-age and vulnerability checks.

For a PyPI package pulled in by an extra (`psycopg-binary` for
`psycopg[binary]`), name the extra on the entry instead.

If the package is only reachable through a refused one, allowlisting more
packages will not help; change or drop the refused dependency.

## Related

- [Pending answer: `wardby_package_not_allowed_pending`](package-not-allowed-pending.md): the walk stopped before reaching the name.
- [Graph limit: `wardby_graph_limit`](graph-limit.md)
- [Still being checked: `wardby_graph_incomplete`](graph-incomplete.md)
- [Package audit mode](../package-audit-mode.md): find out which packages a task needs without refusals, for a limited time.
- [Coding packages](../coding-packages.md): the allowlist, the walk and the full error table.
