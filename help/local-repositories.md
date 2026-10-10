---
id: local-repositories
title: Use local git repositories without a GitHub App
summary: Point coding and review agents at a git folder on the wardby host (local:/abs/path), with no GitHub App and no git worktree. Results land as branches in that repository. Needs LOCAL_REPO_ROOTS trusted folders and the Docker or Kubernetes job launcher.
audience: operator
tags: [local, local-repo, worktree, git, quickstart, review, coding, LOCAL_REPO_ROOTS]
appliesTo: ">=0.5.0"
---

# Use local git repositories without a GitHub App

A coding or review agent can work on a git folder on the machine that runs the
wardby server instead of a GitHub repository. You write the repository as
`local:/absolute/path`. No GitHub App, GitHub account link or webhook is needed.

- A **coding agent** clones the repository's committed history, works in the
  sandbox as usual, and wardby pushes the result into your repository as a new
  branch `wardby/run-<run id>`. Wardby clones; it does not create a git
  worktree in your repository.
- A **review agent** reviews a branch of the repository against a base branch
  when you ask for it with `trigger_agent`.

The easiest way to try it is the optional coding step of
`npx --yes @wardby/cli@latest quickstart` (see
[Quickstart coding step](#quickstart-coding-step)).

## Requirements

- **A single-user or personal server.** Set `LOCAL_REPO_ROOTS` only on a
  server that you alone use. Every principal who can create or update agents
  or link repositories can use every repository under the trusted folders:
  its committed code is sent to the model, and runs push `wardby/run-*`
  branches into it. Anyone with execute access to a local coding agent can
  trigger such pushes.
- **Trusted folders.** Set `LOCAL_REPO_ROOTS` on the wardby server to the
  folders wardby may use, separated by the platform's path delimiter (`:` on
  macOS and Linux, `;` on Windows). While it is unset, every `local:` repository
  is refused with `local_repo_not_allowed`. A repository must be a git work tree
  whose real path (symlinks resolved) is at or below one of the folders.
  Wardby stores the repository by that real path. It checks the folders again
  when you create or update an agent, link a repository, trigger a run, and
  while a run uses the repository. Restart the server after changing the
  variable.
- **The Docker or Kubernetes job launcher.** Coding agents run in an isolated
  worker, so set `JOB_LAUNCHER=docker` (or `kubernetes`). With
  `JOB_LAUNCHER=local` a coding run ends with "Coding agents need a container
  executor". Review agents are native agents and need no worker.
- **The server on the same machine as the folders.** Wardby reads and writes
  your repository directly. A control plane in a container, a pod or on another
  machine cannot see the folder: it ignores a trusted folder that does not
  exist, so the repository fails with `local_repo_not_allowed`, and `doctor`
  reports the folder as missing.
- **git 2.24 or newer** on the machine that runs the wardby server.
- **Worker images from this release or later.** An older worker image rejects
  a `local:` repository and the run fails with `worker_input_failed`. That
  includes a bring-your-own `workerImageRef` image: rebuild it on a current
  driver image.

## Coding agents

Create a coding agent with `create_agent` and
`codingProfile.repository: "local:/abs/path"`, or change an existing agent with
`update_agent`. Start it with `trigger_agent {agentId, task, baseRef?}`.
`baseRef` defaults to the profile's base ref.

What happens:

1. Wardby clones the repository's **committed** history. Untracked and
   uncommitted files, such as a `.env.local`, never leave your machine.
2. The worker makes its changes in the sandbox, as it does for GitHub.
3. Wardby validates the result and pushes a single commit to the branch
   `wardby/run-<run id>` in your repository. Your working tree, index and
   checked-out branch are never modified.
4. `get_run` shows `resultBranch` and `baseSha` (the commit the run started
   from). Merge the branch the way you merge any branch.

Things to know:

- Your repository's own receive-side hooks (for example `pre-receive` and
  `update`) run when wardby pushes. A hook that rejects the push fails the run.
- `trigger_agent` returns `warnings` when the repository has uncommitted files,
  submodules or Git LFS files. The run still starts, but uncommitted files are
  not included and submodules and LFS are **not supported**: submodules are not
  initialized and LFS files are not fetched.
- A run can start from an earlier result: pass `baseRef: "wardby/run-<run id>"`
  to build on that branch. A continuation of a run (a lead agent revising its
  earlier work) fast-forwards the same branch. If that branch has moved, or is
  checked out in your repository, the run fails with `local_branch_conflict`.
- Wardby never deletes result branches. Remove one you no longer need with
  `git branch -D wardby/run-<run id>`.
- `.wardby/services.yaml` works for local runs. It is read from the committed
  file at the run's base ref, never from your working tree, and fails with the
  same errors as on GitHub (for example `service_declaration_invalid`). See
  [Give coding runs the services their tests need](coding-services.md).

## Review agents

1. Create a native review agent (a normal agent with a review prompt that uses
   the `repo_*` tools) and link it with `link_repository` using
   `provider: "local"`, `repository: "local:/abs/path"` and `access: "write"`
   (publishing a review needs write). A local link is manual only: give it no
   `triggers` and no `checkName`.
2. Start a review with
   `trigger_agent {agentId, review: {repository?, branch, base?}}`. Only the
   agent's owner can. `repository` defaults to the agent's only local link, and
   `base` defaults to the branch checked out in the repository.
3. The `repo_pr_read`, `repo_read_file`, `repo_list_files`, `repo_publish_review`
   and `repo_comment` tools work unchanged, reading committed content at the
   branch and never your working tree.
4. `get_run` returns the result in `review`: `number`, `branch`, `base` and
   `reviews`, each with `verdict`, `summary`, `body` and `comments`.

There are no check runs and no CI results for a local review, and event
triggers (`pull_request`, `push`, `mention`, `review_fix`) are rejected for
local repositories.

A typical loop: trigger the coding agent, read `resultBranch` from `get_run`,
then trigger the review agent with `review: {branch: "<resultBranch>"}`.

## Quickstart coding step

`quickstart` asks "Set up coding + review agents against a local git repo?"
after the sample agent. It needs Docker and, for the coding provider you
choose, an `OPENAI_API_KEY` (Codex) or `ANTHROPIC_API_KEY` (Claude Code). It
then:

- asks which folders to trust (offering the git root of the current directory)
  and writes `LOCAL_REPO_ROOTS` and `JOB_LAUNCHER=docker` to `.wardby/.env`;
- gets only the chosen provider's images, pulled by digest from a release or
  built from a wardby source checkout: the runtime image plus the Codex worker
  for Codex, or the runtime image plus the Claude worker and tool-runner images
  for Claude Code. A Claude-only setup does not need or set
  `CODING_WORKER_IMAGE`; images another provider set up on an earlier run are
  kept. `WARDBY_RUNTIME_IMAGE` together with `CODING_WORKER_IMAGE`, or
  `CODING_CLAUDE_WORKER_IMAGE` plus `CODING_CLAUDE_TOOL_RUNNER_IMAGE`, override
  them with your own digests;
- starts the coding proxy and runs the coding preflight;
- detects Python projects: if the repository's committed root holds
  `pyproject.toml`, `setup.py`, `setup.cfg`, `Pipfile` or a `requirements*.txt`,
  `local-builder` gets a Node + Python 3.12 workspace (`toolchain: node-python`)
  for Codex and Claude Code, with `pytest` and `ruff`, so it can run the tests.
  The images come from `CODING_WORKER_IMAGE_NODE_PYTHON_3_12` (Codex) and
  `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12` (Claude Code); set them to
  override. If this version has no Python image, quickstart says so and the
  builder uses the Node workspace (it can edit but not run Python tests). Other
  languages need a bring-your-own image via `workerImageRef`. See the BYO
  worker images guide in the long-form docs;
- finds the repository: a trusted folder that is a git repository, or the
  repositories directly inside a trusted folder (hidden folders are skipped).
  With several it asks which to use; non-interactively it uses the first in
  sorted order and prints the choice. Re-run with `--trust <repo>` to pick
  another: folders passed on a run take precedence over saved ones;
- offers the packages the repository declares (`package.json` dependencies,
  `pyproject.toml` dependencies including optional groups and Poetry, with
  Poetry's legacy `[tool.poetry.dev-dependencies]`, the `[build-system]
requires` build packages (or `setuptools` and `wheel` when there is no
  `[build-system]` table), and
  `requirements*.txt`, read from the committed root) as `local-builder`'s
  package allowlist: names without versions (Python extras such as
  `psycopg[binary]` are kept), up to 200 per ecosystem. It lists them
  and asks "Allow local-builder to install these packages through Wardby's
  registry? [Y/n]"; every registry safeguard still applies. If you decline, or
  run non-interactively without `--allow-repo-packages`, the allowlist stays
  empty: add packages later with `update_agent` and
  `codingProfile.packageAllowlist`. A re-run replaces the allowlist with what
  the repository declares now. A manifest quickstart cannot read is skipped
  with a note. See [Approve packages for coding agents](coding-packages.md);
- creates `local-builder` (a coding agent, $2 budget) and `local-reviewer`
  (a review agent, $1.50 budget, on Claude Sonnet 5 or `gpt-5.6-terra` by
  default, with the thorough review prompt quoted in
  [Set up an architecture agent](architecture-agent.md#reviewer-system-prompt))
  for the repository and prints the two `trigger_agent` calls to try; and
- if the repository has no `.wardby/services.yaml`, offers a starter one with
  PostgreSQL and/or Redis. It is committed to the branch
  `wardby/quickstart-services` without touching your working tree. Merge that
  branch, or set the agent's `baseRef` to it. When a services file exists
  already, quickstart shows what it declares or why it is invalid. The "default
  branch" is whichever branch is checked out when quickstart runs.

Flags: `--coding` (run the step), `--no-coding` (skip it), `--trust <dir>`
(repeatable), `--coding-provider codex|claude-code`,
`--starter-services postgres,redis|none` and `--allow-repo-packages` (or
`--no-allow-repo-packages`). In `--non-interactive` mode the step
only runs with `--coding`, and it needs at least one `--trust`. `doctor` and
`status` report the trusted folders, worker image, coding proxy and each local
agent's repository, and `down` stops the proxy with the database. Quickstart
ends with a menu of next things to ask your assistant, each naming the help
article it follows; see [Get started](getting-started.md).

## Errors

- [`local_repo_not_allowed`](errors/local-repo-not-allowed.md): outside every
  trusted folder, `LOCAL_REPO_ROOTS` is unset, or the server cannot see the
  trusted folder.
- [`local_repo_not_found`](errors/local-repo-not-found.md): missing, not a git
  work tree, or not readable by the server.
- [`local_ref_not_found`](errors/local-ref-not-found.md): the branch or base
  does not exist.
- [`local_ref_invalid`](errors/local-ref-invalid.md): not a valid branch name.
- [`local_path_invalid`](errors/local-path-invalid.md): an unsafe file path in
  a repository read.
- [`local_branch_conflict`](errors/local-branch-conflict.md): the result branch
  moved or is checked out.
- [`vcs_github_not_configured`](errors/vcs-github-not-configured.md): a coding
  agent uses a GitHub repository on a server with only local repositories
  configured.

Related: [Get started](getting-started.md),
[Connect GitHub repositories](github.md) (the alternative to a local
repository), [Run GitHub code-review agents](code-review-agents.md) and
[Give coding runs the services their tests need](coding-services.md). Operator
guide: [`docs/coding-agent-setup.md`](../docs/coding-agent-setup.md).
