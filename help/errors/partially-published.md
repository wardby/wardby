---
id: errors/partially-published
title: Some repositories published and others failed (partially_published)
summary: A coding run over several repositories published some pull requests and failed on others; what published stays published and a follow-up retries the rest.
audience: operator
tags: [error, coding-agents, partially_published, multiple repositories, pull request]
appliesTo: ">=0.9.13"
---

# Some repositories published and others failed

`partially_published` is the run error of a coding run with several writable
repositories when at least one pushed its changes and opened or updated its pull
request, and at least one other failed to publish. The run ends `failed`. When
none published and one failed, the run reports that failure as usual instead.

The error lists every repository in publish order, the default repository
first, as `name: status`, where the status is `published`, `no_changes` or
`failed(<category>)`. The category is a fixed word, such as `protected_path`,
`github` or `repo_access`; the failure's own message is never copied into it.

What published stays published. The other repositories were still tried, so one
failure does not stop the rest.

## What to do

- Open the run (`get_run`) and look at each repository's pull request and the
  category of the failed ones. Fix the cause, for example a protected path or
  lost access (see [Repository access refused](repo-access.md)).
- Mention `@<app-slug>` on a pull request of the set, or continue the run: a
  follow-up works in the same repositories and retries the failed ones, and
  repositories that already have a pull request are updated in place.

See [Several repositories in one coding run](../multi-repository-runs.md).
