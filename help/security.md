---
id: security-boundaries
title: Understand Wardby security boundaries
summary: Review the isolation, credential, budget, and action-authority controls that apply to managed work.
audience: operator
tags: [security, isolation, credentials, budgets]
appliesTo: >=0.2.1
---

# Understand Wardby security boundaries

Wardby is designed to make agent work bounded and reviewable. It applies hard
per-agent and shared-budget limits, grants only explicitly attached tools,
secrets, datastores, and sub-agents, and records a durable result.

Native tools run in a constrained QuickJS environment. Coding agents use
isolated workers with bounded resources and a trusted proxy. Workers do not
receive provider credentials or the GitHub App private key. Coding finalization
creates a draft pull request; it does not grant the worker merge authority.

Treat the deployment boundary as part of the security model. Restrict Docker or
Kubernetes administrator access, protect secrets, constrain network egress,
and read the deployment guide before enabling a production repository.

See [`docs/security-deployment.md`](../docs/security-deployment.md) and
[`docs/coding-worker-isolation.md`](../docs/coding-worker-isolation.md) for
the detailed operational model.
