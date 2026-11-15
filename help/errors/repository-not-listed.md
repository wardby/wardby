---
id: errors/repository-not-listed
title: Repository not on the agent's list (repository_not_listed)
summary: The repository named for a coding run is not the agent's default or one of its write links; name a listed one, or add it with link_repository.
audience: operator
tags: [error, coding-agents, repository_not_listed, invalid_repository, link_repository]
appliesTo: ">=0.8.0"
---

# Repository not on the agent's list

`repository_not_listed` means the `repository` given to `trigger_agent` or to a
`delegate_to_<name>` call is neither the coding agent's default
(`codingProfile.repository`) nor one of its repository links (write access, no
triggers). No run was started. The message lists the repositories that are
allowed and never repeats the value that was sent.

The same code answers a `repositories` list (`trigger_agent`, a webhook's
`wardbyRepositories`, or a delegation) that names something that is not one of
the agent's links: use link names from `list_repositories` (the `name` of each
link, not the repository path). See
[Several repositories in one coding run](../multi-repository-runs.md) and
[Repositories list refused](invalid-repositories.md).

A webhook that sends `wardbyRepository` gets the same refusal as a 400
`{ "error": "invalid_repository" }` when
`codingProfile.allowWebhookTaskOverride` is on. A malformed value (not a string,
empty, or over 300 characters) is that same 400 with the flag on or off. With
the flag off, a well-formed value is refused with 403 `{ "error": "disabled" }`
before it is compared with the list, whoever created the webhook.

## What to do

- Name one of the listed repositories, spelled as `your-org/your-repo`.
- To add a repository, the agent's owner calls `link_repository` with
  `access: "write"`, no triggers and, optionally, a `baseRef`. The owner needs
  write access to it on the host, or an admin approves it.
- If a native (non-coding) sub-agent is the target, `repository` is refused
  with `repository_requires_coding_agent`: drop the argument.

See [Repository required](repository-required.md),
[Agent recipes](../agent-recipes.md) and the operator guide
`docs/coding-agent-setup.md`, section "A coding agent's repositories".
