---
id: errors/repository-name-taken
title: Repository link name already used (repository_name_taken)
summary: link_repository was given, or defaulted to, a name another link of the same coding agent already uses; pass a different name.
audience: operator
tags: [error, coding-agents, repository_name_taken, link_repository, name]
appliesTo: ">=0.10.0"
---

# Repository link name already used

A coding agent's links each have a `name`, the folder a repository gets under
`/repos/` and the way `repositories` lists refer to it. Names are unique per
agent. `repository_name_taken` means `link_repository` named, or defaulted to
(the repository's short name in lower case), a name another link of the agent
already uses. The same repository may be linked twice under different names.
Nothing is linked, and Wardby never adds a suffix on its own.

## What to do

Call `link_repository` again with a different `name` that matches
`[a-z0-9][a-z0-9._-]{0,62}`. `list_repositories` shows the names in use. The
message names the repository the existing link points to. If two requests raced
for one name, retry with another.

See [Invalid repository link name](repository-name-invalid.md) and
[Several repositories in one coding run](../multi-repository-runs.md).
