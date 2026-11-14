---
id: errors/substrate-feature-unsupported
title: The Substrate launcher does not support this run (substrate_feature_unsupported)
summary: A coding run needs Codex, coding services, MCP tools, the dependency cache or extra repositories, which the experimental Substrate launcher does not support; use the Docker or Kubernetes launcher.
audience: operator
tags: [error, substrate, substrate_feature_unsupported, job launcher, coding-agents, services, mcp, codex]
appliesTo: ">=0.9.15"
---

# The Substrate launcher does not support this run

`substrate_feature_unsupported` (and `substrate_provider_unsupported` for the
provider) means the run asked for something the experimental Substrate launcher
cannot do. The run fails at launch, before any actor is created. The control
plane log names the feature (`services`, `mcpTools`, `dependencyCache` or
`repositories`).

| Trigger                                                                     | Feature           |
| --------------------------------------------------------------------------- | ----------------- |
| An agent whose `codingProfile.provider` is `codex`                          | provider          |
| A repository with `.wardby/services.yaml` and an agent that allows services | `services`        |
| MCP servers attached to the coding agent                                    | `mcpTools`        |
| The run dependency cache                                                    | `dependencyCache` |
| Extra repositories (a default set, or a `repositories` list)                | `repositories`    |

What to do:

1. Run these agents on a deployment that uses `JOB_LAUNCHER=kubernetes` or
   `docker`, which support all of them; or
2. remove the trigger: use a Claude Code agent, an agent that allows no
   services, no attached MCP servers, and only the default repository.

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md#what-is-not-supported).
