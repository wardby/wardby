---
id: errors/coding-provider-not-configured
title: Coding provider not configured
summary: A coding run was refused because this server has no worker images for the agent's coding provider (Codex or Claude Code).
audience: operator
tags: [error, coding-agents, configuration, coding_provider_not_configured, CODING_WORKER_IMAGE, codex, claude-code]
appliesTo: ">=0.5.0"
---

# Coding provider not configured

`coding_provider_not_configured:<provider>` means a coding agent's provider has
no worker images on this wardby server. Each provider's images are optional, so
a server can run Codex agents only, Claude Code agents only, or both. Starting
the run (a trigger, schedule, or webhook) fails at dispatch with this error,
before any worker starts and before anything is spent. A run records its worker
image at dispatch, so removing an image later doesn't affect most runs already
dispatched. The exceptions fail at launch with category
`preflight`: a Claude Code run when `CODING_CLAUDE_TOOL_RUNNER_IMAGE` has since
been unset, and a Codex run with no recorded worker image (one dispatched before
runs recorded it) when `CODING_WORKER_IMAGE` has since been unset.

- **`coding_provider_not_configured:codex`**: `CODING_WORKER_IMAGE` (the Codex
  worker) isn't set, and the agent names no worker image of its own
  (`codingProfile.workerImageRef`). An agent that sets `workerImageRef`, or uses
  a toolchain with its own image (such as `CODING_WORKER_IMAGE_NODE_PYTHON_3_12`),
  still runs without `CODING_WORKER_IMAGE`.
- **`coding_provider_not_configured:claude-code`**: `CODING_CLAUDE_WORKER_IMAGE`
  or `CODING_CLAUDE_TOOL_RUNNER_IMAGE` isn't set. Claude Code needs both, even
  for an agent with its own `workerImageRef`.

This error is about images, not API keys. A missing or invalid model API key
fails later, when the run calls the model.

## What to do

Choose one:

1. **Configure the provider.** Set its images on the wardby server and restart
   it:
   - Codex: `CODING_WORKER_IMAGE`.
   - Claude Code: `CODING_CLAUDE_WORKER_IMAGE` and
     `CODING_CLAUDE_TOOL_RUNNER_IMAGE`.

   Each image must be immutable: a local `sha256:` image ID or a
   `repo@sha256:` digest for Docker, and a registry digest for Kubernetes. With
   the quickstart, re-run it and choose the provider you want; it pulls or builds
   only that provider's images and keeps the ones already set. Then run
   `wardby coding preflight`. See
   [Local coding-agent setup](../../docs/coding-agent-setup.md).

2. **Switch the agent to a configured provider.** Use `update_agent` to change
   its `codingProfile.provider` and pick a model for that provider.

The server refuses to start with a coding launcher (`JOB_LAUNCHER=docker` or
`kubernetes`) when neither provider has images. That startup error names both
options.

Related: [Local git repositories](../local-repositories.md),
[Model not available](model-unavailable.md).
