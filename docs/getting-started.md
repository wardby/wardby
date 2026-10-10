# Getting started

This guide gets a local Wardby control plane running without installing
PostgreSQL or cloning the Wardby repository. Wardby keeps its database and
configuration isolated from the application in which you run it.

For a shared deployment with isolated Kubernetes coding workers, use the
[GKE getting-started guide](getting-started-gke.md).

## Requirements

- Node.js 24 or newer.
- Docker with Docker Compose v2.
- An OpenAI or Anthropic API key.
- Optional: Codex or Claude Code, if you want `quickstart` to register Wardby
  as an MCP server.

## Run quickstart

From the repository where you want to use Wardby:

```sh
npx --yes @wardby/cli@latest quickstart
```

The guided command:

1. checks Node, Docker, Docker Compose, and the Docker daemon;
2. creates a private `.wardby/.env` and project state;
3. adds `.wardby/` to the repository's `.gitignore`;
4. starts PostgreSQL 16 in Docker on the first available local port beginning
   at `55432`;
5. applies Wardby's packaged Prisma migrations;
6. creates the `hello-wardby` sample agent with a `$1` maximum run budget;
7. asks before making the billed model request;
8. optionally sets up coding and review agents against a local git repository
   (see [Coding agents on a local repository](#coding-agents-on-a-local-repository));
   and
9. optionally registers the local stdio MCP server with Codex, Claude Code, or
   both.

Provider credentials and `SECRET_APP_KEY` are written with owner-only file
permissions. They are not printed, passed as command-line arguments, or added
to the application's own `.env` files.

## Choose what to set up next

The quickstart's sample agent is a native agent: it calls a model and nothing
else. To have agents write code or review it, pick the path that matches what
you have:

| You want                                                | You need                                                           | Path                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| A coding agent and a review agent, tried locally        | Docker, an OpenAI **or** Anthropic key, a git repository on disk   | [A](#path-a-local-repository-no-github-app)        |
| A coding agent that opens pull requests on GitHub       | Path A's setup, plus a GitHub App installed on the repository      | [B](#path-b-coding-agent-on-a-github-repository)   |
| A review agent that reviews GitHub pull requests        | A GitHub App with webhooks, and Wardby reachable over public HTTPS | [C](#path-c-review-agent-on-github-pull-requests)  |
| A coding agent for a language other than Node or Python | Path A's setup with Codex, and Docker to build an image            | [D](#path-d-another-language-build-your-own-image) |

Codex agents need only an OpenAI key and Claude Code agents only an Anthropic
key; you don't need both.

### Path A: local repository, no GitHub App

1. Run the quickstart with its coding step, pointing it at your repository (or
   at a folder of repositories):

   ```sh
   npx --yes @wardby/cli@latest quickstart --coding --trust ~/code/my-repo
   ```

   Or run plain `quickstart` and answer **yes** to "Set up coding + review
   agents against a local git repo?". It asks for Codex or Claude Code, pulls
   only that provider's images, starts the coding proxy, and creates two agents:
   `local-builder` (writes code) and `local-reviewer` (reviews it). If the
   repository is a Python project, the builder gets a Node + Python 3.12
   workspace so it can run the project's tests (see
   [Python projects](#python-projects)).

2. Ask your MCP client (the quickstart can register Wardby with Codex or Claude
   Code) to run the builder. The quickstart prints the exact call, for example:

   ```json
   trigger_agent {"agentId": "<local-builder id>", "task": "Add a short CONTRIBUTING.md"}
   ```

3. Check the run with `get_run`. When it succeeds, its `resultBranch` is a new
   branch `wardby/run-<run id>` **in your repository**. Inspect it with
   `git diff main...wardby/run-<run id>`. Your working tree and checked-out
   branch are not touched.
4. Review that branch:

   ```json
   trigger_agent {"agentId": "<local-reviewer id>", "review": {"branch": "wardby/run-<run id>"}}
   ```

   `get_run` on the review run shows its verdict, summary, and line comments.

5. Merge the branch if you like it, or delete it with
   `git branch -D wardby/run-<run id>`.

Details, options, and the trust model are in
[Coding agents on a local repository](#coding-agents-on-a-local-repository)
below.

### Path B: coding agent on a GitHub repository

A coding agent you trigger yourself can work on a GitHub repository from the
same local setup. It pushes a branch and opens a **draft pull request**. GitHub
doesn't need to reach your machine for this.

1. Complete path A first, so that Docker, the coding proxy, and the worker
   image are set up.
2. Create a GitHub App and install it on **only** the repository the agent may
   change, with `Contents: Read and write` and `Pull requests: Read and write`
   ([details](coding-agent-setup.md#prerequisites)).
3. Add `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` to the project's
   `.wardby/.env`, then re-run `doctor`.
4. Create a coding agent whose `codingProfile.repository` is `owner/name`. The
   repository must be authorized for the agent's owner. Either link your GitHub
   account with `link_host_account`, or, on a local installation (where you
   hold the `admin` role), pass `repositoryAdminOverride: true`. See
   [Repository authorization](coding-agent-setup.md#repository-authorization).
5. Trigger it with `trigger_agent` and a `task`. `get_run` shows the draft
   pull request it opened.

### Path C: review agent on GitHub pull requests

Automatic reviews start from GitHub webhooks, so GitHub must be able to reach
your Wardby server over public HTTPS. A laptop-only installation can't receive
them; use a deployment such as [Getting started on GKE](getting-started-gke.md),
or another host with a public URL.

1. Run Wardby where GitHub can reach it, with `MCP_CANONICAL_URI` set to its
   public URL.
2. Register the GitHub App with the webhook URL, secret, events, and
   permissions in
   [Registering the GitHub App](code-review-agents.md#registering-the-github-app).
3. Link your GitHub account with `link_host_account`.
4. Create a native review agent. The reviewer prompt in
   [Agent recipes](agent-recipes.md) is a good start.
5. Link it to the repository with the `pull_request` trigger (see
   [Linking an agent to a repository](code-review-agents.md#linking-an-agent-to-a-repository)):

   ```json
   {
     "agentId": "<agent-id>",
     "repository": "owner/name",
     "access": "write",
     "triggers": ["pull_request"],
     "checkName": "wardby review"
   }
   ```

6. Open or update a pull request. A **wardby review** check starts, and the
   agent posts inline comments and a summary.

To try reviews before you have a public URL, use path A's `local-reviewer` on
any local branch.

### Path D: another language: build your own image

Wardby's worker images have Node, or Node and Python 3.12. For a Go, Java, Rust
or other project, build a worker image with that toolchain on Wardby's driver
base image, and point the builder at it with `codingProfile.workerImageRef`.
These steps are for a **Codex** builder. For a Claude Code builder, the image
starts from Wardby's tool runner image instead; see
[Codex and Claude Code](coding-worker-byo-images.md#codex-and-claude-code).

1. Complete path A with Codex (`--coding-provider codex`).
2. Run `npx @wardby/cli@latest doctor`. It prints the base image to build on:
   "Base image for your own worker images: …@sha256:…".
3. Write and build the Dockerfile as described in
   [Bring-your-own worker images](coding-worker-byo-images.md), then set the
   builder's `codingProfile.workerImageRef` with `update_agent` to the image's
   local ID (`docker image inspect --format '{{.Id}}' <image>`).

Your MCP assistant can do these steps for you: ask it "Help me build a Wardby
worker image for Go" (or your language). It follows the `build-worker-image`
help article, checks the image, and runs a test task with it.

## Unattended setup

Automation must explicitly accept the billed demo with `--yes`:

```sh
OPENAI_API_KEY="..." npx --yes @wardby/cli@latest quickstart \
  --provider openai \
  --model gpt-5.6-luna \
  --budget 1 \
  --client codex \
  --non-interactive \
  --yes
```

Use `--skip-demo` to prepare the database without making a provider request.
This is useful for CI and package verification:

```sh
npx --yes @wardby/cli@latest quickstart \
  --provider openai \
  --non-interactive \
  --skip-demo
```

## Operate the local installation

Run these from the same project directory. Set `WARDBY_PROJECT_DIR` to that
directory when invoking Wardby from somewhere else.

```sh
npx --yes @wardby/cli@latest doctor
npx --yes @wardby/cli@latest status
npx --yes @wardby/cli@latest logs --tail 100
npx --yes @wardby/cli@latest down
```

`down` stops PostgreSQL but preserves its named volume. Removing the database
is intentionally explicit:

```sh
npx --yes @wardby/cli@latest down --volumes
```

`quickstart` is safe to rerun. It reuses the project identity, port, secrets,
and database volume, reapplies idempotent migrations, and updates the sample
agent instead of creating duplicates.

## MCP configuration

Passing `--client codex`, `--client claude`, or `--client both` lets quickstart
register Wardby after showing the choice interactively. The generated stdio
entry launches the same package version and sets `WARDBY_PROJECT_DIR`, so the
MCP process finds this project's private Wardby configuration regardless of the
client's current working directory.

After connecting, try:

> List my Wardby agents, show the latest run and its actual cost, then create a
> new agent with a maximum budget of $0.50. Do not run it yet.

### Reasoning effort

A native agent can set `effort` (`low`, `medium`, `high`, `xhigh`, or `max`)
through `create_agent`, `update_agent`, or `wardby agent create --effort`. It is
sent on every model call and trades depth of reasoning against latency and
output-token cost; lower levels are faster and cheaper per turn. Leave it unset
to use the provider's default. Wardby rejects a level the agent's model does not
accept, including when you later change the model (clear it with
`effort: null`). Effort applies to direct Anthropic API models that support
it and to the OpenAI reasoning models (`gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, `gpt-6-astra`), which accept `low` through `max`; the older
OpenAI models (`gpt-4o`, `gpt-4o-mini`, and the `gpt-4.1` family) and Bedrock
models accept no effort setting. Coding agents do not use it.

## Coding agents

The first-run demo proves native model routing, budget admission, persistence,
and accounting. It does not install a GitHub App or start any worker. For the
step-by-step paths, see [Choose what to set up next](#choose-what-to-set-up-next).

Coding agents require the stronger boundary described in
[Coding-agent setup](coding-agent-setup.md): an immutable worker image, a
trusted coding proxy, and either Docker or Kubernetes as the job launcher. For
GitHub repositories they also need a dedicated GitHub App. Run
`wardby coding preflight` before enabling a production repository.

### Coding agents on a local repository

To try a coding agent and a review agent without a GitHub App, quickstart can
point them at a git repository on your machine. After the sample agent it asks
"Set up coding + review agents against a local git repo?"; the default is no.
This step needs Docker, and an `OPENAI_API_KEY` (Codex) or `ANTHROPIC_API_KEY`
(Claude Code) for the coding agent. It:

1. asks which folders to trust (it offers the git root of the current
   directory) and writes them to `.wardby/.env` as `LOCAL_REPO_ROOTS`, together
   with `JOB_LAUNCHER=docker`;
2. gets the images for the provider you chose, pulled by digest from a
   published release or built from a wardby source checkout: the runtime image
   plus the Codex worker for Codex, or the runtime image plus the Claude worker
   and tool-runner images for Claude Code. Each setup pulls only its own
   provider's images, so a Claude-only setup never needs the Codex worker (and
   does not set `CODING_WORKER_IMAGE`); images another provider set up on an
   earlier run are kept. Set `WARDBY_RUNTIME_IMAGE` together with
   `CODING_WORKER_IMAGE`, or `CODING_CLAUDE_WORKER_IMAGE` plus
   `CODING_CLAUDE_TOOL_RUNNER_IMAGE`, to use images of your own;
3. starts the coding proxy and runs the coding preflight;
4. creates `local-builder` (a coding agent, $2 budget) and `local-reviewer` (a
   review agent, $1.50 budget, on Claude Sonnet 5 or `gpt-5.6-terra` by default:
   a step above the builder's model, so a review costs more per call but stays
   within its budget; `--model` does not change it: change it with
   `update_agent` — a quickstart re-run resets it) for a repository in the trusted folders (a trusted
   folder that is a git repository, or one directly inside it; with several,
   quickstart asks, or non-interactively uses the first in sorted order and
   prints it. Re-run with `--trust <repo>` to choose another: folders passed on
   a run take precedence over saved ones); and
5. prints two `trigger_agent` calls: one asks `local-builder` for a change, the
   other asks `local-reviewer` to review the branch `wardby/run-<run id>` the
   run pushed into your repository.

`local-reviewer` uses a thorough, repository-agnostic review prompt: it checks
correctness, security against the OWASP Top 10, performance, duplication,
modularity, AI-generated slop, code quality, test coverage and process, cites
your `docs/knowledge/` concepts when you have them, and ends with APPROVE or
CHANGES_REQUESTED. The prompt is quoted in the `architecture-agent` help
article. A re-run of quickstart moves a reviewer created by an earlier version
onto it; a `local-reviewer` you changed yourself is left alone.

**Trust model.** Wardby only touches repositories inside the folders you trust.
Agents see committed history only: untracked files such as `.env.local` never
leave your machine. A run never changes your working tree or the branch you have
checked out; its result is a new branch `wardby/run-<run id>` in the repository,
and the repository's own receive hooks run when wardby pushes it.

If the repository has no `.wardby/services.yaml`, quickstart offers a starter
one (PostgreSQL and/or Redis) and commits it to the branch
`wardby/quickstart-services` without touching your working tree or checked-out
branch. Merge that branch, or set the agent's `baseRef` to it. "The default
branch" for these agents is the branch checked out when quickstart runs. If the
repository already has a services file, quickstart prints what it declares, or
why it is invalid.

#### Python projects

Quickstart reads the committed root of the repository (never your working tree)
and treats it as a Python project when it holds `pyproject.toml`, `setup.py`,
`setup.cfg`, `Pipfile` or a `requirements*.txt` file. For a Python project it
prepares the Node + Python 3.12 workspace image for the provider you chose
(`toolchain: node-python`, version `3.12`) and creates `local-builder` on it, for
both Codex and Claude Code. The builder can then run the project's tests:
`pytest` and `ruff` are installed. Quickstart prints
"Python project detected: local-builder uses a Node + Python 3.12 workspace".

The image is recorded in `.wardby/.env`. To use your own build of it, set the
variable for your provider to an immutable digest (`repo@sha256:...`) or a local
image id before running quickstart:

| Provider    | Variable                                           |
| ----------- | -------------------------------------------------- |
| Codex       | `CODING_WORKER_IMAGE_NODE_PYTHON_3_12`             |
| Claude Code | `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12` |

If your wardby version ships no Python workspace image, quickstart prints
"Python project detected, but this version has no Python workspace image" and
creates the builder on the default Node workspace: it can edit code but not run
Python tests. Upgrade, or set the variable above.

Other languages (Go, Rust, Java and so on) are not detected. Use a
bring-your-own image through `workerImageRef`; see
[Path D](#path-d-another-language-build-your-own-image) and
[Bring-your-own worker images](coding-worker-byo-images.md), for Codex or
Claude Code.

#### Packages the repository declares

Coding agents can install only the packages on their allowlist (see
[Installing packages in coding runs](coding-packages.md)), and a new agent's
allowlist is empty. So that `local-builder` can install the project's
dependencies, quickstart reads the ones the repository declares at the root of
the same commit (never your working tree):

- `package.json`: `dependencies`, `devDependencies` and `optionalDependencies`
  (not peer dependencies) for npm;
- `pyproject.toml`: `[project] dependencies`, every
  `[project.optional-dependencies]` group, `[tool.poetry.dependencies]`,
  Poetry's dependency groups and the legacy `[tool.poetry.dev-dependencies]`
  for PyPI, plus the packages pip needs to build the project:
  `[build-system] requires` (such as `setuptools`, `hatchling` or
  `poetry-core`), or `setuptools` and `wheel` when the file has no
  `[build-system]` table (pip then uses the legacy setuptools backend);
- every `requirements*.txt` for PyPI. Options such as `-r`, `-c` and `-e`,
  URLs and local paths are skipped; an included file (`-r other.txt`) is not
  followed.

It keeps package names without versions (a Python requirement keeps the extras
it names, such as `psycopg[binary]`, so the packages those extras add can be
installed too), drops names that are not valid in their ecosystem, and skips non-registry sources (`file:`, `git`, URL and
path dependencies). It prints the counts and up to a dozen names, then asks
"Allow local-builder to install these packages through Wardby's registry?
[Y/n]". The allowed names go on the builder's `codingProfile.packageAllowlist`.
Versions still come from your lockfile or the package manager's resolver, and
every registry safeguard (release age, advisories, the record of what was
fetched) still applies.

- More than 200 names in one ecosystem: quickstart adds none from it and says
  why.
- A manifest it cannot read (an unusual `pyproject.toml` layout, for example):
  it prints a one-line note and skips that file.
- Answering no, or a `--non-interactive` run without `--allow-repo-packages`,
  leaves the allowlist empty. Add packages later with `update_agent` and
  `codingProfile.packageAllowlist`.
- A re-run sets an existing quickstart `local-builder`'s allowlist to what the
  repository declares now (or empty if you decline), replacing entries you
  added by hand.

Options for unattended use:

```sh
OPENAI_API_KEY="..." npx --yes @wardby/cli@latest quickstart \
  --non-interactive --yes \
  --coding --trust ~/projects/my-repo \
  --coding-provider codex \
  --starter-services postgres \
  --allow-repo-packages
```

- `--coding` runs the step without asking and `--no-coding` skips it. With
  `--non-interactive` the step runs only with `--coding`.
- `--trust <dir>` names a trusted folder; repeat it for several. Folders trusted
  by an earlier run are kept. Non-interactive runs need at least one.
- `--coding-provider codex|claude-code` picks the coding agent; by default it
  uses the provider whose key is available.
- `--starter-services postgres,redis|none` answers the starter-file question.
- `--allow-repo-packages` allows the repository's declared packages without
  asking; `--no-allow-repo-packages` allows none. Non-interactive runs allow
  none unless the flag is given.

`doctor` and `status` then also report the trusted folders, the worker image,
the coding proxy, and each local agent's repository, and `down` stops the proxy
along with the database. See
[Local repositories](coding-agent-setup.md#local-repositories) for what a local
run does, its requirements (the server must run on the same machine as the
folders) and its limits (no submodules or Git LFS).

## Your first agents

[Agent recipes](agent-recipes.md) gives two complete, copyable setups: an
architecture keeper and a builder per language. They go beyond the quickstart,
whose optional coding step works on a local git repository without a GitHub
App. The recipes react to GitHub events, so they require Wardby 0.4.0 or later
and need the GitHub App, worker image, and job launcher from
[Coding-agent setup](coding-agent-setup.md). Their event triggers need GitHub to
reach your instance at a public HTTPS URL.

The quickstart ends with a short menu of things to ask the assistant it
connected, each with the help article the assistant follows:

1. "Run local-builder with a task, then have local-reviewer review the branch"
   (`local-repositories`; shown only when the coding step ran).
2. "Let local-builder install more packages" (`coding-packages`).
3. "Help me build a Wardby worker image for Go (or Java, Rust…)"
   (`build-worker-image`).
4. "Set up a scheduled Wardby agent" (`creating-agents`).
5. "Set up a Wardby architecture reviewer and keeper for this repo"
   (`architecture-agent`, which has a local-repository variant).
6. "Help me plan out a GKE deployment" (`deploy-gke` and
   `deployment-targets`).

Without an MCP client, read an article with
`npx @wardby/cli@latest help open <article>`. The GitHub setups above are not
in the menu; ask for one directly, for example "Set up the Wardby architecture
keeper for this repository", and the assistant follows the `agent-recipes`
help article.

## Next steps

- [Agent recipes](agent-recipes.md)
- [Runtime architecture](architecture-runtime.md)
- [Coding-agent setup](coding-agent-setup.md) and its
  [local repositories](coding-agent-setup.md#local-repositories) section
- [Bring your own identity provider](getting-started-identity-provider.md)
- [Observability](observability.md)
- [GKE deployment](getting-started-gke.md)
- [Security deployment guide](security-deployment.md)
