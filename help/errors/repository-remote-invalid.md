---
id: errors/repository-remote-invalid
title: Remote link refused (repository_remote_invalid)
summary: A repository link with as "remote" is not allowed for that agent, access or host; or a run's set holds a remote link that no longer fits.
audience: operator
tags: [error, coding-agents, repository_remote_invalid, remote link, git history, link_repository]
appliesTo: ">=0.9.13"
---

# Remote link refused

`repository_remote_invalid` means a link with `as: "remote"` breaks one of its
rules. `link_repository` answers with HTTP 400 and the reason. A run refuses
the same way at dispatch (a scheduled run is recorded as `refused`) if a link
in its set no longer fits.

## The rules

- Only a **coding agent's** link can be a remote.
- It must be a **read** link (`access: "read"`).
- Its `name` becomes the git remote name, so it cannot be `origin`. Pass a
  different `name` (the default is the repository's short name).
- It must be on the **same host** as the agent's default repository
  (`codingProfile.repository`): GitHub with GitHub, `local:` with `local:`.

Fix the link, or link the repository as a normal read-only folder (leave out
`as`). See [Git history in coding runs](../git-history.md).
