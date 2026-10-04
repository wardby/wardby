---
id: agent-recipes
title: Agent recipes
summary: Two copyable agent setups, an architecture keeper and a per-language builder, with the version, GitHub App, and webhook prerequisites each needs, written as a procedure an MCP assistant can follow.
audience: operator
tags: [recipes, examples, coding-agents, architecture, builder, router, mention, push, getting-started]
appliesTo: >=0.4.0
---

# Agent recipes

Two complete setups: an **architecture keeper** (a scheduled architect coding
agent, a merge watcher with the `push` trigger, and a reviewer step that uses
`docs/knowledge/`) and a **builder** (a native router linked with `mention` that
delegates to a coding builder, for Node/TypeScript, Python, or a
bring-your-own-image toolchain).

They go beyond the quickstart, which runs native agents only. They require
Wardby 0.4.0 or later, plus the GitHub App, worker image, and job launcher from
coding-agent setup. The full recipes, with every configuration and prompt, are
in [`docs/agent-recipes.md`](../docs/agent-recipes.md).

If you are an assistant connected to Wardby over MCP, follow these steps. Do
them in order, ask the user instead of guessing, and stop at the first failed
prerequisite.

## Step 0: choose

Ask the user:

1. Which recipe: "architecture keeper" or "builder"?
2. Which repository, as `owner/name`?
3. The coding provider, `codex` or `claude-code`, for both recipes (the
   architect is a coding agent too). Never guess it.
4. For the builder only: the language or stack, which decides `toolchain`
   (`node` for Node/TypeScript, `node-python` with `toolchainVersion: "3.12"`
   for Python, or a bring-your-own worker image for anything else).

Agent names are unique across the whole instance, so the recipes use
repo-scoped names: `<repo>-architect`, `<repo>-merge-watcher`, `<repo>-builder`,
and `<repo>-router`, where `<repo>` is the repository name from `owner/name`.
Call `list_agents` first; if a name is taken, ask the user for another. Keep the
`boundName` values `architect` and `builder` unchanged, so the delegate tools
stay `delegate_to_architect` and `delegate_to_builder`.

## Step 1: check prerequisites

Check these before creating anything.

1. **Local install.** Over the local stdio connection `link_host_account` is
   not available (it needs Wardby's HTTP transport), and a quickstart-only
   install has no GitHub App or coding workers. If that is your situation,
   explain it to the user and point them to
   [`docs/coding-agent-setup.md`](../docs/coding-agent-setup.md) instead of
   trying.
2. **GitHub account link.** Call `get_host_account`. If `accounts` is empty,
   call `link_host_account` with no arguments, give the user the `authorizeUrl`,
   and when they return the one-time code, call `link_host_account` again with
   `confirmationCode`.
3. **Repository access.** No tool lists the repositories the GitHub App can
   see. The linked account needs write access to the repository, and both
   `create_agent` (with a `codingProfile`) and `link_repository` check this and
   refuse with a clear error if it is missing. Ask the user to confirm the GitHub
   App is installed on the repository. Do not use `adminOverride` or
   `repositoryAdminOverride` unless the user is an admin and asks for it.
4. **Models.** Call `list_models` and pick ids whose `routable` is true: a
   capable coding model that the chosen provider supports, and a small fast model
   for the native agent.
5. **Coding-agent setup.** If coding agents are not set up yet, tell the user to
   run `wardby coding preflight` (CLI) and finish coding-agent setup first. See
   [`docs/coding-agent-setup.md`](../docs/coding-agent-setup.md).
6. **Webhooks.** Event triggers need GitHub to reach the instance at a public
   HTTPS URL, with the App's events ticked: **Push** for the merge watcher;
   **Issue comment**, **Pull request review comment**, and **Issues** for
   mentions. Scheduled and manual runs need no webhook.

If a prerequisite fails, stop and tell the user what to do. Do not create agents.

## Step 2A: architecture keeper

1. Call `get_help_article` with `id: "architecture-agent"`. It holds the
   architect system prompt ("System prompt"), the watcher prompt, and the
   reviewer step. Use them unchanged.
2. Call `create_agent` for the architect: `name: "<repo>-architect"`, `kind: "coding"`,
   `model` a capable coding model, `budgetUsd: 3`, `systemPrompt` the architect
   prompt, and `codingProfile` with `provider`, `repository`, `baseRef` (the
   default branch), and `defaultTask`: `Weekly knowledge review. Run the full
cycle described in your instructions for this repository. Your file changes
are collected into a pull request for review; don't try to commit or open one
yourself.`
3. Tell the user the run is billed up to the agent's budget ($3) and get their
   confirmation. Then call `trigger_agent` once with the architect's `agentId`
   and show them the run (`get_run`). If the run failed or produced no pull
   request, stop and show the error or summary; never call `set_schedule` after a
   failed run. Otherwise **stop** and ask them to review and merge the first
   draft pull request before continuing.
4. When they say to continue, call `set_schedule` with the architect's
   `agentId`, `schedule: "0 6 * * 1"`, and the user's `timezone`.
5. Call `create_agent` for the watcher: `name: "<repo>-merge-watcher"`,
   `kind: "native"`, a small fast `model`, the watcher prompt as `systemPrompt`,
   and a `budgetUsd` of at least 3 plus a little (the run tree shares one
   budget).
6. Call `attach_subagent` with `parentAgentId` the watcher, `childAgentId` the
   architect, and `boundName: "architect"`.
7. Ask the user to tick **Push** in the GitHub App's event settings (and keep
   Contents: read). Wait for their confirmation.
8. Call `link_repository` with `agentId` the watcher, `repository`,
   `access: "write"`, and `triggers: ["push"]`. Send no `checkName`.
9. Offer the reviewer step: if the user has a code-review agent, offer to append
   the "Reviewer step" from the same article to its prompt with `update_agent`
   (read it first with `get_agent`, and keep its existing prompt).

## Step 2B: builder

1. **Check for a mention conflict first**, before creating anything. Call
   `list_agents`, then `list_repositories` for each native agent you can see, to
   find one linked to the repository with the `mention` trigger (only one agent
   per repository may handle mentions). If one exists, reuse it as the router
   only if the user owns it and agrees; then attach the builder to it and skip
   creating a router. Never unlink or relink another agent.
2. Ask the user to confirm the GitHub App subscribes to **Issue comment**,
   **Pull request review comment**, and **Issues** events.
3. Call `create_agent` for the builder: `name: "<repo>-builder"`,
   `kind: "coding"`, a `model` the chosen provider supports, `budgetUsd` such as
   `5`, `systemPrompt` the prompt from `get_help_article` with
   `id: "builder-agent"` (section "Builder prompt"), and a `codingProfile` with
   `provider`, `repository`, `baseRef`, and `timeoutSec` (for example `1800`),
   plus the stack settings:
   - Node/TypeScript: `toolchain: "node"`, with `packageAllowlist` such as
     `{ "npm": ["react@^19", "vitest"] }`.
   - Python: `toolchain: "node-python"`, `toolchainVersion: "3.12"`, with
     `packageAllowlist` such as `{ "pypi": ["flask>=3"] }` (wheels only; list a
     wheel package's own name, not an extra). Add `services: ["postgres"]` if
     tests need a database: the repository must commit `.wardby/services.yaml`
     declaring it, and the name must be in the catalog (`list_services`), or
     `create_agent` returns 400.
   - Other: `toolchain: "node"` plus a digest-pinned `workerImageRef`. Ask the
     user for the image reference; never invent one. It needs the `agents:admin`
     scope; if the user lacks it, stop and say so.

   A `packageAllowlist` needs `packages:approve` or `agents:admin`.

4. If you are not reusing a router, call `create_agent` with
   `name: "<repo>-router"`, `kind: "native"`, a small fast `model`, a `budgetUsd`
   of the builder's budget plus a little, and the router prompt from
   `get_help_article` with `id: "builder-agent"` (section "Router prompt").
5. Call `attach_subagent` with `parentAgentId` the router, `childAgentId` the
   builder, and `boundName: "builder"`.
6. Call `link_repository` with `agentId` the router, `repository`,
   `access: "write"`, and `triggers: ["mention"]`. If it returns the 409
   "Another agent already handles @-mentions", **stop** and tell the user, and
   list the agents you created. Never unlink or relink another agent. If linking
   fails for any reason after you created agents, tell the user what was created.
7. Ask the user to try one `@<app-slug>` request on an issue, where
   `<app-slug>` is the GitHub App's name. A test run is billed up to the
   builder's budget; say so first.

## Step 3: confirm

Summarize what you created: each agent's name and id, the sub-agent bindings,
the repository links and their triggers, and the schedule. Then state the next
manual step for the user: merge the first knowledge pull request, tick any App
events still missing, or try the first `@` mention. Remind them that Wardby never
merges pull requests for them.

Related: [Builder and router prompts](help://builder-agent),
[Set up an architecture agent](help://architecture-agent),
[Architecture knowledge bundles](help://knowledge),
[Choose a native or coding agent](help://creating-agents),
[Connect GitHub repositories](help://github-integration),
[Run GitHub code-review agents](help://code-review-agents),
[Approve packages for coding agents](help://coding-packages), and
[Services for coding runs](help://coding-services).
