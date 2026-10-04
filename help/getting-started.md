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
