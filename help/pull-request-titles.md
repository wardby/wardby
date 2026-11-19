---
id: pull-request-titles
title: Pull request titles and commit messages
summary: How a coding run names its pull request and commits, the conventional-commit types the agent can pick, where the issue key goes, and how to steer the type.
audience: operator
tags: [pull-requests, commits, conventional-commits, titles, jira, coding-agents]
appliesTo: ">=0.10.2"
---

# Pull request titles and commit messages

A coding run's commit and the draft pull request it opens use a
[Conventional Commits](https://www.conventionalcommits.org/) subject:

```text
feat(webhooks): add retry to Jira webhook delivery (PROJ-123)
```

The commit body adds a `Wardby-Run: <run id>` line under the subject.

## Where each part comes from

- **`type(scope): title`** is written by the agent, from its task and what it
  changed. It returns them as `commitType`, `commitScope` and `commitTitle` with
  its result. The type is `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
  `test`, `build`, `ci` or `chore`. The scope is optional.
- **`(PROJ-123)`** is the issue that started the run
  ([Jira agents](help://jira)), or else the agent's `tag` when it is itself an
  issue key such as `GH-42`. No key means no suffix.
- **`Wardby-Run: <run id>`** names the run that made the commit. Open the
  commit, or expand it in the pull request's Commits tab, to see it.
  `git log --grep=<run id>` finds the commit.

## What to expect

- The pull request title is set once, when the pull request opens. Follow-up
  runs on the same pull request keep it and add commits that each have their
  own subject.
- A missing or unlisted type becomes `chore`. With no usable title the
  subject is `chore: Wardby run <run id>`. A key the agent also wrote into its
  title is not repeated. The subject is at most 72 characters; a long title is
  shortened, never the key.
- The branch comes from the issue key or a name you pass, else it is
  `wardby/run-<run id>`; see [Coding branch names](help://coding-branch-names).
- Commits carry no `Signed-off-by` line.

## Steer the type

The agent chooses the type, so say what kind of change you want in the task:
"add a new feature", "fix a bug", "only change documentation", "only add
tests", "refactor with no behavior change", "routine maintenance". A vague task
such as "add a line to the README" can come back as `chore` or `docs`.

See [Choose a native or coding agent](help://creating-agents) for when to use
a coding agent, and [Local repositories](help://local-repositories) for the
branch a local run pushes.
