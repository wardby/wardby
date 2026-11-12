---
id: errors/vcs-read-only-fetch-failed
title: Read-only repository could not be fetched (vcs_read_only_fetch_failed)
summary: Wardby could not fetch the pinned commit of a read link into a run's read-only folder; the host's detail is kept out of the message.
audience: operator
tags: [error, coding-agents, vcs_read_only_fetch_failed, read-only repository, link_repository]
appliesTo: ">=0.10.0"
---

# Read-only repository could not be fetched

Before a run starts, Wardby fetches the one commit a read link was pinned to
into `/repos/<name>`. `vcs_read_only_fetch_failed` means that fetch failed, or
the object it fetched was not a commit. The run fails in preparation with the
category `workspace` (`coding_failure_workspace`). The message carries only the
code: git's and the host's own output is not copied into the run record.

## What to check

- The agent owner can still read the repository, and for GitHub the App is
  installed on it or the repository is public. See
  [Repository access refused](repo-access.md).
- The repository's account is in `WARDBY_GITHUB_ALLOWED_ACCOUNTS`.
- The pinned commit still exists. A branch that was force-pushed or deleted
  between dispatch and the fetch can remove it; trigger a fresh run so the ref
  is resolved again.
- The host was reachable from the control plane. The operator's logs have
  the redacted detail.

See [Several repositories in one coding run](../multi-repository-runs.md).
