# Local coding-agent setup

This setup starts a dedicated, trusted coding proxy while keeping the coding
worker untrusted and network-isolated. The proxy has the selected provider
credential and database access. A worker receives only a one-run capability
and can reach only the proxy on its internal Docker network. Claude Code uses
a second, credential-free tool-runner container for repository access; it
shares the run's network (so its package installs reach the proxy's
registry) but never holds the run capability.

## Prerequisites

- Docker Desktop is running.
- `.env.local` contains `DATABASE_URL`, `SECRET_APP_KEY`, and the credential
  for each enabled coding provider: `OPENAI_API_KEY` and/or
  `ANTHROPIC_API_KEY`.
- The local database has the current Prisma migrations applied.
- A GitHub App is installed on only the repository to be exercised. (Not needed
  for a repository on this machine; see
  [Local repositories](#local-repositories).) Grant it
  `Contents: Read and write` and `Pull requests: Read and write`; set
  `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in `.env.local`.

GitHub documents the available App permissions in its [permissions guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).
The same App can also run native agents as automated PR reviewers; see
[code-review-agents.md](code-review-agents.md) for the extra webhook
permissions and setup.

The GitHub App installation is the only step that cannot be created from this
repository. It is intentionally scoped to the test repository because a coding
run can push a branch and create a draft pull request.

Coding runs can also have services such as a PostgreSQL database next to them,
for Codex and Claude Code runs on the Kubernetes and Docker launchers; see
[coding-services.md](coding-services.md).

## Repository authorization

A coding agent's `codingProfile.repository` must be authorized for the agent's
owner: `create_agent` and `update_agent` (when the repository changes) check
that the owner's linked GitHub account has **write** access to it, or record
an explicit admin approval (`repositoryAdminOverride: true`, `admin` role
only). Link your GitHub account once with `link_host_account` first; see
[code-review-agents.md](code-review-agents.md#who-may-give-an-agent-a-repository),
which also covers the App's callback URL and client credentials
(`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`).

Every run checks again, before its workspace is prepared, against the agent's
current owner. A run whose owner has lost write access, unlinked their GitHub
account, or whose repository was never authorized ends `refused` with failure
category `repo_access` and nothing cloned. The check is repeated (usually from
the 5-minute cache) right before the run pushes: access lost while it worked
fails the run (`repo_access`) with nothing pushed. For a run already under way,
a transient GitHub error during either check is retried once; if it persists
the run fails with category `repo_access_unavailable` (GitHub could not be
asked — not a lost permission; re-run it later). `make_owner` to a different
owner turns an admin or grandfathered approval into a check of the new owner's
access. Coding agents must have an owner.

A continuation (`continuePriorRun`) checks separately that the pull request
it is asked to continue is still open on GitHub; one already merged or closed
fails with category `continuation_closed` and nothing pushed — see
[Continuation's pull request is no longer open](../help/errors/continuation-closed.md).
Over stdio, the local operator holds every role, so `repositoryAdminOverride`
is the way to approve a repository there.

## Local repositories

A coding agent (or a review agent) can work on a git repository on the same
machine as the wardby server instead of a GitHub repository. Write the
repository as `local:/absolute/path`. No GitHub App, GitHub account link or
webhook is involved, and no extra role is required: the trusted folders below
are the only boundary.

Set `LOCAL_REPO_ROOTS` only on a single-user or personal server. Every
principal who can create or update agents or link repositories can use every
repository under the trusted folders: its committed code is sent to the model,
and runs push `wardby/run-*` branches into it. Anyone with execute access to a
local coding agent can trigger such pushes.

Set these on the control plane:

```dotenv
# Folders wardby may use, separated by the platform path delimiter (":" on macOS
# and Linux, ";" on Windows). Unset = every local: repository is refused.
LOCAL_REPO_ROOTS=/home/you/projects:/srv/repos
# Coding runs need a container executor.
JOB_LAUNCHER=docker
```

- **Trusted folders.** A repository must be the top level of a git work tree
  whose real path (symlinks resolved) is at or below one of the folders.
  Wardby stores the repository by that real path and checks the folders again
  when an agent is created or updated, a repository is linked, a run is
  triggered, and while a run uses the repository. A change to the variable takes
  effect after a restart. An outside path fails with `local_repo_not_allowed`.
- **Launcher.** With `JOB_LAUNCHER=local` a coding run ends with "Coding agents
  need a container executor"; use `docker` or `kubernetes`. Review agents are
  native agents and do not need a worker.
- **The server runs on the host.** Wardby reads and writes the repository
  directly, so the control plane must not run in a container, a pod or on
  another machine. A trusted folder the server cannot see is ignored, so its
  repositories fail with `local_repo_not_allowed`, and `doctor` reports the
  folder as missing. The machine needs git 2.24 or newer.
- **Worker images.** Use worker images from the same release as the control
  plane. An older worker image rejects `local:` repositories (the run fails with
  `worker_input_failed`), including a bring-your-own `workerImageRef` image,
  which must be rebuilt on a current driver image.

### What a coding run does

1. Wardby clones the repository's **committed** history at the base ref
   (`baseRef`, default the profile's). Untracked and uncommitted files, such as
   `.env.local`, never leave the host. `trigger_agent` returns `warnings` when
   the working tree is dirty or the repository uses submodules or Git LFS;
   uncommitted changes are not included, and submodules and LFS are not
   supported (submodules are not initialized, LFS files are not fetched).
2. The worker runs in the usual sandbox. `.wardby/services.yaml` works: it is
   read from the committed file at the base ref (never the working tree) and
   fails with the same errors as on GitHub (see [coding-services.md](coding-services.md)).
3. Wardby validates the result and pushes one commit to the branch
   `wardby/run-<run id>` in the source repository. Your working tree, index
   and checked-out branch are never modified. `get_run` reports `resultBranch`
   and `baseSha`.
4. The repository's own receive-side hooks (`pre-receive`, `update`,
   `post-receive`) run on that push, as they would for any push.

To build on an earlier result, trigger with `baseRef: "wardby/run-<run id>"`. A
continuation of a run (a lead agent revising its earlier work) fast-forwards the
same branch; if the branch has moved, or is checked out, the run fails with
`local_branch_conflict` and nothing is pushed.

Result branches accumulate, and wardby does not delete them. Clean up with
`git branch -D wardby/run-<run id>`.

### Toolchains for local repositories

The default workspace is Node. A coding agent whose `codingProfile` sets
`toolchain: "node-python"` and `toolchainVersion: "3.12"` runs in a Node +
Python 3.12 workspace with `pytest` and `ruff`, for Codex and for Claude Code.
The server selects the image from `CODING_WORKER_IMAGE_NODE_PYTHON_3_12`
(Codex) or `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12` (Claude Code); a
`node-python` agent is refused when the variable for its provider is unset.
`quickstart` sets this up for you when the repository has a Python marker file
(`pyproject.toml`, `setup.py`, `setup.cfg`, `Pipfile` or `requirements*.txt`)
at its committed root; see
[Python projects](getting-started.md#python-projects).

For any other language, point a Codex agent at your own image with
`workerImageRef` ([Bring-your-own worker images](coding-worker-byo-images.md)).
Claude Code agents cannot use a custom toolchain yet.

### Review agents

Link a native review agent with `link_repository` (`provider: "local"`,
`repository: "local:/absolute/path"`, `access: "write"`). A local link is
manual only: it takes no `triggers` and no `checkName`, and event triggers
(`pull_request`, `push`, `mention`, `review_fix`) are rejected. The agent's
owner starts a review with:

```json
{ "agentId": "<review agent id>", "review": { "branch": "wardby/run-<run id>", "base": "main" } }
```

`repository` defaults to the agent's only local link, and `base` to the branch
checked out in the repository. The `repo_*` tools work unchanged and read
committed content at the branch, never the working tree. `get_run` returns the
result in `review` (`number`, `branch`, `base`, and `reviews` with `verdict`,
`summary`, `body` and `comments`). There are no check runs and no CI results.

### Quickstart

`quickstart` can set all of this up. See the coding step in
[Getting started](getting-started.md#coding-agents-on-a-local-repository).

## Start the trusted proxy

Run these commands from the repository root:

```sh
npm run coding:local:up
npm run worker:image:local
npm run claude:images:local
```

The image commands create local tags. Resolve every enabled image with
`docker image inspect --format '{{.Id}}' <tag>` and put the resulting immutable
`sha256:...` ID in `.env.local`; do not use the mutable tag at runtime. Add the
following values, replacing image IDs and GitHub values:

Set the images for the providers you use: `CODING_WORKER_IMAGE` for Codex
agents, and the `CODING_CLAUDE_*` pair for Claude Code agents. Each provider's
images are optional, but at least one provider must be configured. A Claude-only
deployment can leave `CODING_WORKER_IMAGE` unset (and skip
`npm run worker:image:local`); a Codex agent there is then refused with
`coding_provider_not_configured:codex` unless it names its own worker image
(see [Coding provider not configured](../help/errors/coding-provider-not-configured.md)).

```dotenv
# Leave this as local until every value below is set and reviewed.
JOB_LAUNCHER=local
# Codex agents only:
CODING_WORKER_IMAGE=sha256:replace-with-worker-image-id
# Claude Code agents only (both or neither):
CODING_CLAUDE_WORKER_IMAGE=sha256:replace-with-claude-worker-image-id
CODING_CLAUDE_TOOL_RUNNER_IMAGE=sha256:replace-with-claude-tool-runner-image-id
# Only for Claude Code agents on the node-python toolchain (version 3.12):
CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12=sha256:replace-with-claude-tool-runner-node-python-image-id
CODING_PROXY_CONTAINER=wardby-coding-proxy
VCS_WORK_ROOT=/tmp/wardby-vcs
CODING_JOB_STATE_ROOT=/tmp/wardby-docker-jobs
CODING_ARTIFACT_ROOT=/tmp/wardby-coding-artifacts
CODING_OPENAI_CREDENTIAL_REF=env:OPENAI_API_KEY
CODING_ANTHROPIC_CREDENTIAL_REF=env:ANTHROPIC_API_KEY
GITHUB_APP_ID=replace-with-app-id
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

`npm run claude:images:local` builds the Claude agent image and both tool-runner
images (`wardby-claude-tool-runner:phase5`, and
`wardby-claude-tool-runner:phase5-node-python` for the `node-python` toolchain).
This local, immutable-`sha256:` ID form of the `CODING_CLAUDE_*` images is only
accepted by the Docker launcher.
`JOB_LAUNCHER=kubernetes` needs both images pushed to a registry and set as
`repo@sha256:<64 hex>` registry digests instead — the control plane refuses
to start otherwise — which `deploy/gke/up.sh` and `deploy/kind-coding/up.sh`
build, push, and pin for you.

Once the GitHub App values are set and the target repository has been reviewed,
change `JOB_LAUNCHER=docker` and run:

```sh
npm run cli -- coding preflight
```

The preflight checks that every configured worker image (the Codex worker and/or
the Claude Code worker and tool runner) is immutable and that Docker can inspect
it. A real
run additionally verifies the proxy's isolated-network attachment immediately
before launching the worker.

Run the no-paid-service verification gates before an opt-in live smoke:

```sh
npm run verify:phase5
npm run test:phase5:database
npm run test:docker-isolation
npm run test:docker-job
npm run verify:claude-code
```

The live smoke remains manual because it spends provider credit and can create
a GitHub branch and draft pull request. Keep its budget deliberately small.

After the smoke completes, verify the run ID, terminal result, pull-request
URL, and final cost. Close the fixture PR and delete its `wardby/run-*` branch.
The worker's volume, artifact, and trusted checkout should be removed by
terminal cleanup; investigate any retained resource as a cleanup failure.

See [release verification](release-verification.md) for the complete gate.

If the repository has `docs/knowledge/index.md`, every coding run's prompt
includes it. See [Architecture knowledge bundles](knowledge.md).

## Repository instructions

Every coding run loads the repository's own instructions; there is no
`codingProfile` setting to turn this off. Codex reads the repository's
`AGENTS.md` itself, directly from the checkout. Claude Code is handed
`CLAUDE.md`, `.claude/CLAUDE.md`, and whatever either file pulls in with
`@path` imports, up to 5 import levels deep; a repository that only has
`AGENTS.md` gets a one-line `CLAUDE.md` that imports it, so a repository
written for another coding agent still has its instructions in Claude Code.
Subdirectory `CLAUDE.md` files (anything other than the repository root and
`.claude/CLAUDE.md`) are not loaded.

Claude Code's instructions and skills are read from the checkout and bounded:
at most 64 KiB per file, 200 files, and 256 KiB combined; symlinks and
non-UTF-8 files are refused. A file that doesn't pass is left out and logged
as `coding.claude_context_skipped` (the first 50 individually, then one
aggregate line with an overflow count); when the repository's context can't
be read at all, the run continues without it and logs
`coding.claude_context_unavailable`. A run never fails because its
repository context couldn't be loaded.

Claude Code never receives the repository's `.claude/settings.json`, hooks,
`.mcp.json`, agents, or commands — only Markdown instruction files and
`.claude/skills/<name>/SKILL.md` files pass the allowlist, whatever an
instruction file imports. Repository instructions and skills are untrusted
guidance: they can shape a run's work but never relax the worker's sandbox
rules.

## Claude Code loading mode

`codingProfile.claudeBareMode` controls how Claude Code uses the repository
instructions above. It defaults to `true` and only affects Claude Code
agents.

- **`true` (default, bare mode).** Claude Code keeps its hardened bare mode.
  Wardby adds the repository's instruction files to the system prompt in
  full, and lists each skill by name, description, and path; the model reads
  a skill's full `SKILL.md` itself with `run_command`.
- **`false`.** Bare mode is off. Claude Code loads `CLAUDE.md` and skills
  itself, through its native Skill tool, instead of reading them from the
  system prompt. Repository settings, hooks, MCP configuration, agents, and
  commands are still never loaded in either mode; native loading also locks
  Claude Code's own hooks to wardby's managed set.

If the worker can't write the native-mode context to disk for a run, that
run falls back to bare mode instead of failing, and the worker logs a
`claude_context_unavailable` warning.

The agent owner or an admin can change it:

```json
{ "id": "<agent-id>", "codingProfile": { "claudeBareMode": false } }
```

## Repository skills

`codingProfile.repoSkills` loads the repository's own agent skills into a
run. It defaults to `true`.

| Builder     | Reads skills from                   | `repoSkills: true` (default)                        | `repoSkills: false`                |
| ----------- | ----------------------------------- | --------------------------------------------------- | ---------------------------------- |
| Codex       | `.agents/skills/`, `.codex/skills/` | Repository skills load                              | Every repository skill is disabled |
| Claude Code | `.claude/skills/<name>/SKILL.md`    | Repository skills load (bare or native mode, above) | No skill context is collected      |

Codex's own four built-in skills (`imagegen`, `openai-docs`, `skill-creator`,
`skill-installer`) are always disabled, whatever `repoSkills` is set to —
wardby's coding runs never offer them. Codex's scan for repository skills
stops after 2000 directory entries across both roots, to bound the work an
adversarial skills tree could cause; it logs `codex_skill_scan_truncated` and
uses whatever names it found so far rather than failing the run.

Claude Code skills ship to the worker as their `SKILL.md` only. A skill's
other files (scripts, references, data) stay in the repository checkout and
are read or run through the command runner at
`/workspace/.claude/skills/<name>/`.

Turn repository skills off for an agent:

```json
{ "id": "<agent-id>", "codingProfile": { "repoSkills": false } }
```

**Upgrading.** `repoSkills` and `claudeBareMode` both default to `true`, so
upgrading changes behavior for existing agents: Claude Code agents start
loading `CLAUDE.md` and `.claude/skills/` (previously neither was loaded),
and Codex agents stop getting Codex's own built-in skills (previously always
offered). Set `repoSkills: false` on an agent to keep its repository's
skills out of its runs; there is no setting that keeps repository
instructions themselves out, for either builder. A `workerImageRef` image
must also be rebuilt on this release's driver base — see
[Bring-Your-Own Coding-Worker Images](coding-worker-byo-images.md).

## Budgets

A coding run's budget is reserved when it is dispatched: the agent's own
`budgetUsd`, tightened to whatever its budget group has left for each
configured period and, for a sub-agent, whatever its run tree has left. The
worker can never spend more than that reservation. When a group or run tree
has nothing left, the run is recorded as `refused` with the error
`budget_group_exhausted:<day|week|month>` or `run_tree_exhausted`, and no
container starts (`trigger_agent` returns that status and error directly).

Every live run still pending or running holds its unspent reservation
(reservation minus cost so far) against its group; a native run holds its
agent's per-run `budgetUsd`. So overlapping scheduled, webhook and manual runs
share one cap rather than each seeing the full remainder, and
`get_budget_group` reports those holds as `reservedUsd` next to `spentUsd`.
Native runs are served first come, first served: a native run only counts the
holds of runs that started before it, so members dispatched on the same tick
don't starve each other.

Sub-agents dispatched together by a lead with `parallelDelegations` share the
run tree the same way: each in-flight sibling's unspent reservation counts
against the tree, so they can never jointly reserve more than the lead's
budget. A sibling admitted after the tree is spent waits for another
still-running sibling to finish and free its reservation, then retries, up to
roughly its own normal wait bound — so the total wait can reach about twice
that bound before it gives up. With no sibling still running, it is refused
immediately with `run_tree_exhausted`. The check that triggers the wait is an
estimate, so a retry can still end in the same refusal.

A hold lapses by itself when the run stops showing signs of life, so a crashed
process or an interrupted `wardby run` cannot pin a group for the rest of the
period. A run holds while its last heartbeat (or its start, before the first
beat) is under 60 seconds old (the reconciler's heartbeat timeout plus one
reconcile interval). Managed runs, `wardby run` and native sub-agent children
all beat every 10 seconds. A coding run also holds until its
`CODING_QUEUE_TIMEOUT_SEC` + its `timeoutSec` + 60 seconds have passed since
dispatch, because it does not beat while it waits in the coding queue. Its
recorded cost always counts. `wardby run` records the run as `cancelled` on
Ctrl-C or SIGTERM. If a row is still stuck in `running` for another reason,
only its real cost counts once its hold lapses.

## Turn limit (Claude Code)

A Claude Code run stops after a fixed number of agent turns (model calls),
200 by default. Every file it reads, command it runs and edit it makes is a
turn, so raise the limit for agents that make large changes, or lower it to
stop runaway loops sooner:

```json
{ "id": "<coding agent id>", "codingProfile": { "maxTurns": 400 } }
```

`maxTurns` is 1 to 1000; `null` restores the default. It is fixed on each run
when the run is dispatched. A run that reaches it fails with failure category
`turn_limit` (worker error `coding_turn_limit`) rather than a generic stream
failure. The run's `budgetUsd` and `timeoutSec` still apply and are usually the
better limits. Codex runs have no turn limit, so `maxTurns` does not affect
them.

## Stop the setup

```sh
npm run coding:local:down
```

This stops the local database and proxy but leaves the named Postgres volume in
place. It does not alter agent records, GitHub branches, or pull requests.
