---
id: errors/service-launcher-unsupported
title: Services are not available to this run
summary: Wardby refused the coding run because the repository declares services and this deployment cannot start them.
audience: operator
tags: [error, coding-agents, services, kubernetes, docker, refusal]
appliesTo: >=0.2.1
---

# Services are not available to this run

`service_launcher_unsupported` means the repository declares services, but this
deployment cannot start them. Services need a job launcher that starts them:

- `JOB_LAUNCHER=kubernetes` and `JOB_LAUNCHER=docker` start them for Codex and
  Claude Code agents;
- a deployment with `JOB_LAUNCHER=local` cannot start them at all, and the
  experimental `JOB_LAUNCHER=substrate` does not support them yet (see
  `substrate_feature_unsupported`).

1. Run the coding agent on a deployment that uses the Kubernetes or Docker job
   launcher, or
2. remove `.wardby/services.yaml` from the base branch if the repository's
   tests do not need the services.

This error only applies to an agent that already allows at least one service
(`codingProfile.services` is non-empty): wardby reads a repository's
declaration only for such an agent, and refuses rather than silently starting
the run without the services it names. An agent that allows no services never
reads the declaration at all, so its runs are unaffected and start normally on
any launcher. See [Coding-worker troubleshooting](../troubleshooting/coding-workers.md)
and [Coding services](../coding-services.md).
