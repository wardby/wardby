---
id: package-audit-mode
title: Package audit mode
summary: Let a coding agent install packages outside its allowlist for a limited time, recorded for approval afterwards; full mode also installs versions with high-severity advisories. Malware and the release-age limit are always enforced.
audience: operator
tags: [coding-agents, packages, allowlist, package audit, package audit mode, audit mode, packageAuditMode, packageAuditMinutes, approve_audited_packages, packages_audited, npm, pypi, supply-chain]
appliesTo: >=0.6.1
---

# Package audit mode

From Wardby 0.6.1, a coding agent's registry can run in package audit mode for
a limited time. Instead of refusing a package that is not on the agent's
allowlist, the registry installs it and records it. Use it to find out which
packages a task needs, then approve them and turn the mode off.

## Modes

| Mode    | Packages outside the allowlist | High or critical advisories | Malware | Release age |
| ------- | ------------------------------ | --------------------------- | ------- | ----------- |
| off     | refused                        | withheld unless accepted    | refused | enforced    |
| `audit` | installed and recorded         | withheld unless accepted    | refused | enforced    |
| `full`  | installed and recorded         | installed and recorded      | refused | enforced    |

Everything else still applies in every mode: integrity checks, source
distributions, size and file limits, and a version outside an allowlist
entry's own range (`foo@^1` never serves `foo@2`).

## Turn it on and off

The agent's owner sets it with `update_agent` (needs `packages:approve` or
`agents:admin`):

```json
{ "id": "<agent id>", "codingProfile": { "packageAuditMode": "audit", "packageAuditMinutes": 1440 } }
```

- `packageAuditMinutes` defaults to 1440 (24 hours); the most is 10080 (7 days).
- `packageAuditMinutes` alone re-arms the stored mode for that long.
- `"packageAuditMode": null` turns it off.
- `create_agent` does not accept it.

`get_agent` shows `packageAuditActive` and a warning while the window is
open. Each coding run takes the mode when it is dispatched and keeps it for
its whole life, so a run that starts just before the window ends still runs
with it.

## Where audited packages show up

- `get_run`: `packageAuditMode` and `packageAudit`, one entry per version
  with its `relation` (`top-level`, `transitive` with `via`, `unknown`, or
  `allowed`) and, in `full` mode, its `advisories`.
- The pull request body: a caution banner, **Packages outside the
  allowlist**, and in `full` mode **Served despite advisories**.
- The run's status comment on GitHub or Jira, and a `packages_audited` Slack
  message on linked channels (see [Slack notifications](slack-notifications.md)).
- The proxy log: one `registry.audited` line per version.

A lockfile plan in audit mode approves what passes every other check, and the
dependency cache never restores or saves a lockfile whose plan audited
anything.

## Keep the packages

Approve the names a run recorded with `approve_audited_packages`
(`{ "runId": "<run id>" }`), or add them to `codingProfile.packageAllowlist`
with `update_agent`. Then turn the mode off.

Without `names`, the tool adds only `top-level` packages. A package recorded
as `unknown` (installed with no metadata or plan to show its parent) may be a
dependency of an allowlisted package, so every report lists it apart as
"Relation unknown — may be a dependency; approve only if needed directly".
Add one only if the project uses it directly, by listing it in `names`.

## Risks

Audit mode weakens the supply-chain guard while it is on. `audit` keeps the
malware, advisory and release-age checks; `full` keeps only malware and
release age. A confused or prompt-injected agent could install a lookalike
package that has no advisory yet. Install scripts stay off, but tests and
builds still run what was installed. Keep the window short, review the
caution banner on every affected pull request, and never leave it on.

## Related

- [Coding packages](coding-packages.md)
- [Not allowed: `wardby_package_not_allowed`](errors/package-not-allowed.md)
- [Package not reached: `wardby_package_not_allowed_pending`](errors/package-not-allowed-pending.md)
- [Graph limit: `wardby_graph_limit`](errors/graph-limit.md)
- [Still being checked: `wardby_graph_incomplete`](errors/graph-incomplete.md)
- [Package audit mode guide](../docs/coding-packages.md#package-audit-mode)
