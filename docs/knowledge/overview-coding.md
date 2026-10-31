---
type: overview
title: Coding inputs and isolated workers
description: Shared protocols connect trusted run preparation to Codex or Claude Code workers and host finalization.
tags: [coding, workers, protocol]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-26T06:05:07.739Z }
sources:
  - id: protocol
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/coding/protocol.ts#L503-L544
  - id: codex
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/coding-worker/driver.ts#L245-L288
  - id: claude
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/claude-coding-worker/driver.ts#L260-L307
  - id: finalize
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/providers/executor/container.ts#L1818-L1847
  - id: budget
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/providers/executor/container.ts#L1653-L1694
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/coding/**", "src/coding-worker/**", "src/claude-*/**"]
  citations:
    - id: protocol
      repo: github:wardby/wardby
      path: src/coding/protocol.ts
      lines: [503, 544]
      symbol: CodingTaskInputSchema
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:36844670fcf073f1e0878415464265f3451b71a9cecf461c29c26b8fe7d92070
    - id: codex
      repo: github:wardby/wardby
      path: src/coding-worker/driver.ts
      lines: [245, 288]
      symbol: runCodingWorker
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:6edaf058aa871970337e1367919c54d079520bfe54f7fa0a360f86e9164df59a
    - id: claude
      repo: github:wardby/wardby
      path: src/claude-coding-worker/driver.ts
      lines: [260, 307]
      symbol: runClaudeCodingWorker
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:51ba97bd7f39c93513960c80a5ad7d5a245b0c6a145e0d8d7603dadec5285597
    - id: finalize
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [1818, 1847]
      symbol: ContainerExecutor.pushChanges
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:333c5f121a97cfe61756b19e78c728e00dbd0f4ed60d310127a0ef0d0b383be1
    - id: budget
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [1653, 1694]
      symbol: ContainerExecutor.finishTerminal
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:a40da553fae6cea424ff7b27cfabdef05d8a38041a4f71f733b2513eee7c565f
  confidence: high
---

This area defines bounded coding inputs and outputs, repository profiles and policies, and isolated execution programs. A shared protocol carries the task, model, deadline, budget and permitted run environment; both worker families return structured results for the trusted host to interpret.[^protocol]

A coding run proceeds through these steps:

1. [Core dispatch](overview-core.md) snapshots the coding profile; the [executor provider](overview-providers.md) prepares a workspace and launches the selected worker.
2. The Codex driver prepares package configuration and optional dependencies before starting its agent. Claude Code prepares dependencies and repository context before constructing its query; command execution is relayed to the separate tool runner.
3. Model traffic passes through the [coding proxy](overview-coding-proxy.md). Workers produce bounded structured output and workspace changes.
4. The host materializes the result, normalizes lockfiles, checks repository access again, verifies the run remains active, then asks VCS finalization to publish the permitted outcome. Finished work remains deliverable after a cost overrun; clean budget-stopped workers can also hand partial changes to a separate preservation path.[^codex][^claude][^finalize][^budget]

The area owns wire schemas, worker preparation and output artifacts. Durable CodingRun state belongs to [Prisma](overview-prisma.md); job isolation and VCS authority belong to providers, with images and network policy supplied by [deployment modules](overview-deploy.md).

**What to do:** read [descriptor-bound artifact reads](bounded-file-descriptor.md) and [staged workspace replacement](workspace-staging-failure.md) when changing collection. Keep operator details in [coding-agent setup](../coding-agent-setup.md) and [worker isolation](../coding-worker-isolation.md).

[^protocol]: src/coding/protocol.ts, lines 503-544.

[^codex]: src/coding-worker/driver.ts, lines 245-288.

[^claude]: src/claude-coding-worker/driver.ts, lines 260-307.

[^finalize]: src/providers/executor/container.ts, lines 1818-1847.

[^budget]: src/providers/executor/container.ts, lines 1653-1694.
