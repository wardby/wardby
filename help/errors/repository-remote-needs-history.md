---
id: errors/repository-remote-needs-history
title: Remote link needs git history (repository_remote_needs_history)
summary: A run's repositories include a remote link but the agent's codingProfile.gitHistory is off.
audience: operator
tags: [error, coding-agents, repository_remote_needs_history, remote link, git history, gitHistory]
appliesTo: ">=0.9.13"
---

# Remote link needs git history

A remote link (`as: "remote"`) is fetched into the run's `.git`, which exists
only when `codingProfile.gitHistory` is on. A run whose set includes such a link
while history is off is refused before it starts with
`repository_remote_needs_history`. A scheduled run is recorded as `refused`.

Either:

- turn history on with `update_agent`:
  `{"codingProfile": {"gitHistory": {"depth": "full"}}}`, or
- leave the link out of the run (`repositories` on `trigger_agent` without it,
  or unmark `inDefaultSet`), or re-link it without `as`.

See [Git history in coding runs](../git-history.md).
