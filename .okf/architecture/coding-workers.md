---
type: Architecture Pattern
title: Coding workers
description: Codex and Claude Code run in hardened, credential-less containers or pods and only ever produce draft PRs.
tags: [coding, isolation, security]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: arch-runtime
    resource: /docs/architecture-runtime.md
  - id: readme
    resource: /README.md
---

# Isolation model

The worker holds no provider credentials and no GitHub App key. It reaches
only the [coding proxy](/architecture/coding-proxy.md). Resource limits,
protected paths, bounded output and no network egress beyond the proxy
apply.[^readme] The worker does not gain authority to apply its own outcome:
finalization is done by a trusted component, which opens a **draft** PR and
never auto-merges.

# JOB_LAUNCHER backends (the `WorkspaceJobLauncher` seam)

| Value | Runs in | Isolation |
|-------|---------|-----------|
| `local` | child process | development only, none |
| `docker` | container on a per-run network | per-run network |
| `kubernetes` | pod | per-run NetworkPolicy, field-by-field attested pod, optional gVisor |

On Kubernetes the pod read back from the API server is compared with the pod
wardby built, any difference fails the run, and the launcher proves the
NetworkPolicy is actually enforced before releasing the worker, because a
cluster accepts a policy whether or not anything enforces it.[^arch-runtime]

# Code

`src/coding-worker/` (Codex), `src/claude-coding-worker/` (Claude Code),
`src/providers/jobs/` (launchers), `src/coding/` (profiles, protocol,
protected paths), `src/coding/services` (per-run Postgres, Redis, MySQL).

[^readme]: Project README
[^arch-runtime]: Runtime architecture guide
