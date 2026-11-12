---
id: errors/repository-ref-unreadable
title: Repository ref could not be read (repository_ref_unreadable)
summary: A read link's ref file is missing, empty, too long or not a ref, or its ref does not exist or could not be resolved; no run was started.
audience: operator
tags: [error, coding-agents, repository_ref_unreadable, link_repository, fork-sync, read-only repository]
appliesTo: ">=0.10.0"
---

# Repository ref could not be read

`repository_ref_unreadable` means Wardby could not turn one read link of a
coding run into a commit. It is raised at dispatch, so no run was started.

For a link made with `ref: { "fromFile": "<path>" }`, the file is read from the
default repository's base branch when the run is dispatched. It must hold one
trimmed line of at most 255 bytes that is a branch, a tag or a 40-hex commit
SHA. The message says what failed, and names the link and the file's path but
never the file's content:

- the file does not exist at the default repository's base branch;
- the file is empty, longer than 255 bytes, or does not hold a branch, tag or
  commit SHA;
- the ref it names does not exist in the linked repository (a link with a fixed
  `ref` fails the same way and names the ref, which you set yourself);
- the host could not be asked right now (`unavailable`, for example an API
  failure or rate limit). Try again later.

A webhook gets a 400 `{ "error": "repository_ref_unreadable" }`; a lead's
`delegate_to_<name>` call gets `{ "error", "message" }`.

## What to do

- Fix the file on the default repository's base branch, or re-link with
  `link_repository` and a fixed `ref`.
- Check the ref exists in the linked repository and the agent owner can read it.
- For a fork sync, see [Keep a fork in sync](../fork-sync.md).

See [Several repositories in one coding run](../multi-repository-runs.md).
