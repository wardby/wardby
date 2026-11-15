---
id: errors/substrate-feature-unsupported
title: The Substrate launcher does not support this run (substrate_feature_unsupported)
summary: A coding run needs coding services, the dependency cache, extra repositories or a custom worker image, which the experimental Substrate launcher does not support; use the Docker or Kubernetes launcher.
audience: operator
tags: [error, substrate, substrate_feature_unsupported, job launcher, coding-agents, workerImageRef]
appliesTo: ">=0.9.15"
---

# The Substrate launcher does not support this run

`substrate_feature_unsupported` means the run asked for something the
experimental Substrate launcher cannot do. The run fails at launch, before any
actor is created. The control plane log names the feature (`services`, `dependencyCache`, `repositories`
or `workerImage`).

| Trigger                                                                     | Feature           |
| --------------------------------------------------------------------------- | ----------------- |
| A repository with `.wardby/services.yaml` and an agent that allows services | `services`        |
| The run dependency cache                                                    | `dependencyCache` |
| Extra repositories (a default set, or a `repositories` list)                | `repositories`    |
| A custom worker image (`codingProfile.workerImageRef`)                      | `workerImage`     |

What to do:

1. Run these agents on a deployment that uses `JOB_LAUNCHER=kubernetes` or
   `docker`, which support all of them; or
2. remove the trigger: use an agent that allows no services, only the default repository, and no custom worker image.

A custom image (`codingProfile.workerImageRef`, for Claude Code and Codex
agents alike) is refused because it has no Substrate bridge: only the
deployment's configured worker and tool-runner images
(`CODING_CLAUDE_TOOL_RUNNER_IMAGE` and its per-toolchain variants, and the
Substrate Codex images) run on this launcher. A run also keeps the
tool-runner image it was dispatched with, so a run dispatched before you changed
those images, and launched after, is refused the same way; run it again.

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md#what-is-not-supported).
