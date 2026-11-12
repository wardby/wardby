---
id: errors/repository-name-invalid
title: Invalid repository link name (repository_name_invalid)
summary: A coding agent's link name does not match [a-z0-9][a-z0-9._-]{0,62}, is workspace, or the repository's short name cannot be used as a default; pass name.
audience: operator
tags: [error, coding-agents, repository_name_invalid, link_repository, name]
appliesTo: ">=0.10.0"
---

# Invalid repository link name

The link's `name` becomes a folder, `/repos/<name>`, so it must match
`[a-z0-9][a-z0-9._-]{0,62}` and must not be `workspace` (that is the default
repository's folder). `repository_name_invalid` means the `name` passed to
`link_repository`, or the default taken from the repository's short name in
lower case, does not fit: it is over 63 characters, starts with a symbol, or
uses characters outside the pattern. Nothing is linked.

## What to do

Call `link_repository` again with an explicit `name` that fits, for example
`"name": "upstream"`.

See [Repository link name already used](repository-name-taken.md) and
[Several repositories in one coding run](../multi-repository-runs.md).
