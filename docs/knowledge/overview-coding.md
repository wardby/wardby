---
type: overview
title: Coding inputs and isolated workers
description: Shared protocols connect trusted run preparation to Codex or Claude Code workers and host finalization.
tags: [coding, workers, protocol]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-09T06:04:39.000Z }
sources:
  - id: protocol
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/coding/protocol.ts#L510-L550
  - id: codex
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/coding-worker/driver.ts#L246-L294
  - id: claude
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/claude-coding-worker/driver.ts#L292-L344
  - id: finalize
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/providers/executor/container.ts#L1883-L1929
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/coding/**", "src/coding-worker/**", "src/claude-*/**"]
  citations:
    - id: protocol
      repo: github:wardby/wardby
      path: src/coding/protocol.ts
      lines: [510, 550]
      symbol: CodingTaskInputSchema
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:cf15b3f07252aab787b1554b8503baf05a2b213adcd2afd1e59c4e21a9bfec8c
    - id: codex
      repo: github:wardby/wardby
      path: src/coding-worker/driver.ts
      lines: [246, 294]
      symbol: runCodingWorker
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:d921ed6948a74cc83286c9516574e807ae8878bda93b8cdc9741a974c9de74b3
    - id: claude
      repo: github:wardby/wardby
      path: src/claude-coding-worker/driver.ts
      lines: [292, 344]
      symbol: runClaudeCodingWorker
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:9aca865990a40f72e77682db4d1a363b9d0043ddbbae44ca9b3107ba7d1d12d1
    - id: finalize
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [1883, 1929]
      symbol: ContainerExecutor.pushChanges
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:5339fcac2ea2929ce4bfad74ceef8eedb0773a5ee85fd4c9702f19728ad1e973
  confidence: high
---

This area defines bounded coding inputs and outputs, repository profiles and policies, and isolated execution programs. A shared protocol carries the task, model, deadline, budget and permitted run environment; both worker families return structured results for the trusted host to interpret.[^protocol]

A coding run proceeds through these steps:

1. [Core dispatch](overview-core.md) snapshots the coding profile; the [executor provider](overview-providers.md) prepares a workspace and launches the selected worker.
2. The Codex driver prepares package configuration and optional dependencies before starting its agent. Claude Code prepares dependencies and repository context before constructing its query; command execution is relayed to the separate tool runner.
3. Model traffic passes through the [coding proxy](overview-coding-proxy.md). Workers produce bounded structured output and workspace changes.
4. The host interprets the worker outcome and budget state. Its shared push path materializes the result, normalizes lockfiles, rechecks repository access and run activity, then asks VCS finalization to publish the permitted outcome.[^codex][^claude][^finalize]

The area owns wire schemas, worker preparation and output artifacts. Durable CodingRun state belongs to [Prisma](overview-prisma.md); job isolation and VCS authority belong to providers, with images and network policy supplied by [deployment modules](overview-deploy.md).

**What to do:** read [descriptor-bound artifact reads](bounded-file-descriptor.md) and [staged workspace replacement](workspace-staging-failure.md) when changing collection. Keep operator details in [coding-agent setup](../coding-agent-setup.md) and [worker isolation](../coding-worker-isolation.md).

[^protocol]: src/coding/protocol.ts, lines 510-550.

[^codex]: src/coding-worker/driver.ts, lines 246-294.

[^claude]: src/claude-coding-worker/driver.ts, lines 292-344.

[^finalize]: src/providers/executor/container.ts, lines 1883-1929.
