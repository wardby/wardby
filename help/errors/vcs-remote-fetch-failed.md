---
id: errors/vcs-remote-fetch-failed
title: Remote could not be fetched (vcs_remote_fetch_failed)
summary: Wardby could not fetch a remote link's commit, or deepen the target branch, into the run's git history; the host's detail is kept out of the message.
audience: operator
tags: [error, coding-agents, vcs_remote_fetch_failed, vcs_history_shortened, remote link, git history]
appliesTo: ">=0.9.13"
---

# Remote could not be fetched

Before a git-history run starts, Wardby fetches each remote link's pinned commit
into the default repository's history. `vcs_remote_fetch_failed:<name>` names the
remote that failed. The run fails in preparation with the category `workspace`.
The message carries only the code: git's and the host's output is not copied
into the run record.

`vcs_remote_fetch_failed:origin` is the same failure while a continuation
deepens the default repository's history to merge the target branch. It is also
how a shortened history is reported (`vcs_history_shortened`): rare, with
merge-heavy shallow histories. Use `gitHistory: { "depth": "full" }`.

## What to check

- The agent owner can still read the upstream, and for GitHub the App is
  installed on it or it is public; see [Repository access refused](repo-access.md).
- The upstream's account is in `WARDBY_GITHUB_ALLOWED_ACCOUNTS`.
- The pinned commit still exists (a force-pushed or deleted branch can remove
  it); trigger a fresh run so the ref is resolved again.
- The host was reachable from the control plane. The operator's logs have the
  redacted detail.

See [Git history in coding runs](../git-history.md) and
[`vcs_read_only_fetch_failed`](vcs-read-only-fetch-failed.md).
