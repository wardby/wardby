---
id: getting-started
title: Get started with Wardby
summary: Set up a local Wardby control plane, verify it, and choose the next guide.
audience: operator
tags: [setup, quickstart, operator]
appliesTo: >=0.2.1
---

# Get started with Wardby

From the project you want Wardby to manage, run:

```sh
npx --yes @wardby/cli@latest quickstart
```

The quickstart creates local state under `.wardby/`, starts the local services,
applies the required database migrations, and can register Wardby with Codex or
Claude Code. Run `wardby doctor` afterwards to verify the local installation.

## Coding and review agents: pick a path

- **A. Try them locally, no GitHub App.** Run
  `npx --yes @wardby/cli@latest quickstart --coding --trust <repo-or-folder>`
  (or answer yes to the coding step). It creates `local-builder` and
  `local-reviewer` for a git repository on your machine. Run the builder with
  `trigger_agent {"agentId": "<id>", "task": "..."}`. It pushes a branch
  `wardby/run-<run id>` into your repository and leaves your checkout alone.
  Review that branch with
  `trigger_agent {"agentId": "<reviewer id>", "review": {"branch": "wardby/run-<run id>"}}`.
  You need Docker and an OpenAI key (Codex) or an Anthropic key (Claude Code).
  For a Python project (a root `pyproject.toml`, `setup.py`, `setup.cfg`,
  `Pipfile` or `requirements*.txt`), the builder gets a Node + Python 3.12
  workspace and can run `pytest`. Quickstart also offers the packages the
  repository declares as the builder's package allowlist, so it can install
  them (`--allow-repo-packages` in a non-interactive run).
  See [Use local git repositories](local-repositories.md).
- **B. A coding agent that opens GitHub pull requests.** Do A first. Then
  install a GitHub App on the repository (Contents and Pull requests: read and
  write), add `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` to `.wardby/.env`,
  and create a coding agent for `owner/name`. You trigger it yourself, so
  GitHub doesn't need to reach your machine. See
  [GitHub integration](github.md).
- **C. A review agent on GitHub pull requests.** Reviews start from GitHub
  webhooks, so Wardby must be reachable over public HTTPS. Register the App
  with webhooks, link a native agent to the repository with the `pull_request`
  trigger, and open a pull request. See [Code review agents](code-review-agents.md).

- **D. Another language (Go, Java, Rust…).** Do A, then build an image with
  that toolchain and set the builder's `codingProfile.workerImageRef`. Ask your
  assistant "Help me build a Wardby worker image for Go"; it follows
  [Build a custom worker image](build-worker-image.md), for Codex and Claude
  Code builders.

The quickstart ends with a menu of next steps to ask your assistant: run the
builder and reviewer, allow more packages, build a worker image, schedule an
agent, set up an architecture reviewer and keeper (see
[Set up an architecture agent](architecture-agent.md), which has a
local-repository variant), or plan a GKE deployment
([Deploy on GKE](deploy-gke.md)). Each names the help article the assistant
follows.

The full step-by-step guide is "Choose what to set up next" in
[`docs/getting-started.md`](../docs/getting-started.md).

## Next

Use [Operate agents](operating-agents.md) to create and supervise managed work.
Read [Choose a native or coding agent](creating-agents.md) before creating your
first agent.
Use [MCP access](mcp.md) when connecting an MCP client. Before enabling coding
agents against a repository, complete [GitHub integration](github.md).
For two complete example setups, see [Agent recipes](agent-recipes.md).
For a self-hosted installation, start with [Choose a deployment target](deployment-targets.md)
and [Configure identity and privileged access](identity-and-access.md).

For complete local setup and deployment prerequisites, read
[`docs/getting-started.md`](../docs/getting-started.md).
