---
id: errors/package-refusals
title: Package registry refused an install
summary: When a package refusal blocks a run and when it is only a warning, what each refusal code means, and how to unblock a run.
audience: operator
tags: [error, packages, allowlist, refused, blocked, run_blocked, warning, lockfile, wardby_graph_incomplete, wardby_graph_limit, wardby_package_not_allowed, wardby_package_not_allowed_pending, wardby_version_filtered, wardby_file_not_allowed, wardby_lockfile_entry_unsupported]
appliesTo: >=0.2.1
---

# Package registry refused an install

A coding run can finish successfully after restoring its changes because a
needed package was refused. GitHub and Jira status comments then say
⛔ **Blocked by the package registry: no changes were made.**, or add a ⚠️
**Dependency install incomplete.** warning below the run's own outcome. Slack's
`run_blocked` event, and a run hook on it, follow the same rule.

## When a refusal blocks the run

The status is ⛔ blocked only when all of these hold:

- the run succeeded, and no pull request or pushed changes resulted;
- a coding sub-run made no changes, or failed;
- the run requested a refused package itself: the installer asked the
  registry for it and was refused;
- no workflow sub-run posted a reply (a workflow run with `replyField`).

Every other refusal is a ⚠️ warning only, and the comment keeps the run's
outcome, its reply, or its pull request link:

- refusals only the lockfile plan found. When an install sends its lockfile,
  the registry checks every entry ahead, including packages the run never
  asks for (a dev dependency, say). `get_run` marks such a refusal
  `"planOnly": true`. If the installer then asks for the package and is
  refused, it counts as requested;
- refusals only an index listing found. The installer may only have looked at
  the name. `get_run` marks such a refusal `"listingOnly": true`. It blocks
  only when a coding sub-run failed, and adds nothing when a pull request
  resulted;
- any refusal on a run that posts a workflow reply. The reply is posted word
  for word, followed by the warning.

A refusal the run got past (the registry later served the same package to the
same coding run) is not listed anywhere.

When an install sends a lockfile the registry can't read, such as a
`poetry.lock`, nothing is checked ahead. The refusal list then says: "The
lockfile wasn't checked ahead (the registry can't read its format), so
refusals appear as the installer meets them." Each run may show only the
next refused package. `get_run` shows the same line in `packagePlan`
(`unchecked`, `uncheckedNote`). Export a pinned requirements file, or use
uv, so every refusal shows in one run.

## Refusal codes

- `wardby_package_not_allowed`, `wardby_package_not_allowed_pending`, and
  `wardby_graph_limit`: add the needed package to the coding agent's
  `codingProfile.packageAllowlist` with `update_agent`.
- `wardby_graph_incomplete`, `wardby_upstream_error`,
  `wardby_upstream_unavailable`, `wardby_audit_unavailable`, and
  `wardby_download_idle`: the registry could not finish checking the package,
  usually because an upstream was slow or failing. Mention `@wardby` again to
  retry.
- `wardby_version_filtered`: no version passed the release-age, advisory, or
  malware checks. For release age, wait or adjust
  `codingProfile.packagePolicy.minReleaseAgeDays`. For an advisory, upgrade
  to a safe version or accept the advisory after reviewing exposure using
  `codingProfile.packagePolicy.acceptedAdvisories`. Malware is never waivable:
  use a safe alternative, never bypass the malware check. The code alone
  does not distinguish which check blocked the version.
- `wardby_lockfile_entry_unsupported`: the lock file installs the package
  from git or a URL, which the registry cannot verify. Depend on a registry
  version instead.
- `wardby_file_not_allowed`: the release has no file the registry may serve.
  On PyPI, the release has no wheel, only a source distribution. The lockfile
  plan names this for every such entry, including ones the allowlist doesn't
  reach. Pick a version that publishes wheels, or drop the dependency.
- Other codes: inspect the registry error and package policy before retrying.

Changing allowlists or policy needs `packages:approve` or `agents:admin`.
`update_agent` replaces the whole package policy, so send all intended fields.
After fixing the refusal, mention `@wardby` again. An existing run's package
policy does not change.

See [Approve packages for coding agents](../coding-packages.md) and
[Run status comments](../status-comments.md).
