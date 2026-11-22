---
id: errors/service-launcher-unsupported
title: Services are not available to this run
summary: Wardby refused the coding run because the repository declares services and this deployment cannot start them, on Substrate one entry has no startCommand, a reserved data path, or a start script that is too large, or it declares a toolchain on a launcher or for an agent that can't use one.
audience: operator
tags: [error, coding-agents, services, kubernetes, docker, substrate, startCommand, toolchain, refusal]
appliesTo: >=0.2.1
---

# Services are not available to this run

`service_launcher_unsupported` means the repository declares services, but this
deployment cannot start them. The refusal's sentence says which case applies.

## The launcher cannot start services

"This repository asks for services, which this wardby deployment can't start:
services need the Kubernetes, Docker or Substrate job launcher."

- `JOB_LAUNCHER=kubernetes`, `JOB_LAUNCHER=docker` and the experimental
  `JOB_LAUNCHER=substrate` (from release 0.10.1) start them for Codex and
  Claude Code agents;
- a deployment with `JOB_LAUNCHER=local` cannot start them at all.

1. Run the coding agent on a deployment that uses the Kubernetes, Docker or
   Substrate job launcher, or
2. remove `.wardby/services.yaml` from the base branch if the repository's
   tests do not need the services.

## The Substrate launcher cannot start one service

"This repository asks for `<name>`, which this wardby deployment can't start:
`<reason>`." Substrate runs each service from its catalog entry's
`startCommand`, so it checks each entry the run uses at dispatch:

| Reason                                                                                  | What to do                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| its service catalog entry has no start command                                          | Add a `startCommand` (the image's ENTRYPOINT + CMD) with `update_service`. If that entrypoint runs `chown` or switches user, also set a `substrateImage`; see [Coding services](../coding-services.md#substrate-launcher). |
| its service catalog entry's data path overlaps a directory the job launcher reserves    | The `dataPath` is `/run/wardby-svc`, inside it, or a parent of it (such as `/run`). Use another data path.                                                                                                                 |
| its service catalog entry's environment and commands are too large for the job launcher | The start script, with the entry's `serviceEnv`, is over 16 KiB for the service or 64 KiB for the run's services together (JSON-escaped). Trim the entry's `serviceEnv` or `startCommand`.                                 |

Built-in entries have a start command and pass these checks.

## A toolchain this launcher or agent can't use

"This repository asks for the toolchain `<name>`, which this wardby deployment
can't start: toolchains are not supported on this launcher yet." or "...which
this agent can't use: toolchains are not supported for Codex agents yet."

A [toolchain](../coding-toolchain.md) runs only for Claude Code agents on the
Kubernetes job launcher. Run the repository with a Claude Code agent on a
Kubernetes deployment, or remove the `toolchain:` key from
`.wardby/services.yaml` on the base branch.

This error only applies to an agent that already allows at least one service
(`codingProfile.services` is non-empty): wardby reads a repository's
declaration only for such an agent, and refuses rather than silently starting
the run without the services it names. An agent that allows no services never
reads the declaration at all, so its runs are unaffected and start normally on
any launcher. See [Coding-worker troubleshooting](../troubleshooting/coding-workers.md)
and [Coding services](../coding-services.md).
