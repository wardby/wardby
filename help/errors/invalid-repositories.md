---
id: errors/invalid-repositories
title: Repositories list refused (invalid_repositories)
summary: The repositories list sent for a coding run is malformed, repeats a name, is sent to a native agent, or is sent with a continuation; no run was started.
audience: operator
tags: [error, coding-agents, invalid_repositories, repositories, wardbyRepositories, trigger_agent]
appliesTo: ">=0.10.0"
---

# Repositories list refused

`invalid_repositories` means the `repositories` list for one run cannot be used.
No run was started. The list holds link names (`list_repositories`), not
repository paths. It is refused when:

- a name appears twice;
- the target is not a coding agent;
- it is sent with a continuation (`continuePriorRun`, or a follow-up). A
  continuation works in its root run's repositories, so leave `repositories` out;
- over HTTP, `wardbyRepositories` is not an array of 1 to 63 character strings
  with at most 32 entries.

A webhook gets a 400 `{ "error": "invalid_repositories" }`. When the list was
well formed but its content refused, the body also carries
`error_description`: `repository_not_listed` (a name that is not a link of the
agent that can be in a set) or `repository_set_too_large`. A webhook may carry
the list only when `codingProfile.allowWebhookTaskOverride` is on; with it off
a well-formed list is refused with 403 `{ "error": "disabled" }`. Likewise,
`trigger_agent` accepts `repositories` from anyone but the owner only with
`allowWebhookTaskOverride`. A lead's `delegate_to_<name>` call receives the
refusal as `{ "error", "message" }`.

## What to do

Send each link name once, only for a coding agent, and without a continuation.
See [Repository not on the agent's list](repository-not-listed.md),
[Too many repositories for one run](repository-set-too-large.md) and
[Several repositories in one coding run](../multi-repository-runs.md).
