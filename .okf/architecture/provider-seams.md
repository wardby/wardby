---
type: Architecture Pattern
title: Provider seams
description: The core depends only on interfaces in src/providers/index.ts; concrete adapters are wired from configuration.
tags: [architecture, providers]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: providers-index
    resource: /src/providers/index.ts
---

# Rule

The core imports only from `src/providers/index.ts` and never references a
concrete adapter or a cloud SDK.[^providers-index] That keeps the core
cloud-agnostic.

# The registry

`ProviderRegistry` is the full set handed to the core at startup:

| Seam | Interface | Purpose |
|------|-----------|---------|
| `jobs` | `JobLauncher` | Where coding workers run (`local`, `docker`, `kubernetes`) |
| `llm` | `LlmProvider` | Token counting, pricing, model calls (OpenAI, Anthropic, Bedrock) |
| `secrets` | `SecretCipher` | Secret encryption |
| `auth` | `AuthProvider` | Self-hosted or delegated OAuth |
| `storage` | `BlobStore` | Blob storage |
| `executor` | `Executor` | Run dispatch, in-process or DBOS durable |
| `datastore` | `Datastore` | Per-agent datastores |
| `memory` | `AgentMemoryStore` | Agent memory |
| `engine` | `Engine` | The agent loop - see [runner and engine](/architecture/runner-and-engine.md) |
| `vcs` | `VcsProvider` | GitHub and similar |
| `email` | `EmailProvider` | Email delivery |

Interfaces were designed from the behavioral spec, not from another codebase
(see [clean-room charter](/decisions/clean-room.md)). Adapters for coding workers
are described in [coding workers](/architecture/coding-workers.md).

[^providers-index]: src/providers/index.ts
