---
type: overview
title: Coding inputs and isolated workers
description: Shared protocols connect trusted run preparation to Codex or Claude Code workers and host finalization.
tags: [coding, workers, protocol]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:22:32.722Z }
sources:
  - id: protocol
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/coding/protocol.ts#L455-L496
  - id: codex
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/coding-worker/driver.ts#L254-L294
  - id: claude
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/claude-coding-worker/driver.ts#L190-L230
  - id: finalize
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/providers/executor/container.ts#L1418-L1456
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/coding/**", "src/coding-worker/**", "src/claude-*/**"]
  citations:
    - id: protocol
      repo: github:wardby/wardby
      path: src/coding/protocol.ts
      lines: [455, 496]
      symbol: CodingTaskInputSchema
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:36844670fcf073f1e0878415464265f3451b71a9cecf461c29c26b8fe7d92070
    - id: codex
      repo: github:wardby/wardby
      path: src/coding-worker/driver.ts
      lines: [254, 294]
      symbol: runCodingWorker
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:78250a51b5f468adbc3e4ce1ff44ce90b392b2f888076e509c4b702371378549
    - id: claude
      repo: github:wardby/wardby
      path: src/claude-coding-worker/driver.ts
      lines: [190, 230]
      symbol: runClaudeCodingWorker
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:9b1a14069b42a6e00381e6f2ace9cdd8db4b750ab5c0487740dd05e2c1b92a45
    - id: finalize
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [1418, 1456]
      symbol: ContainerExecutor.finishTerminal
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:b3cdeb7fcdff43795af9bd3d0c18c02fa29d59c787adc3504a2c60be126d9fbc
  confidence: high
---

This area defines bounded coding inputs and outputs, repository profiles and policies, and isolated execution programs. A shared protocol carries the task, model, deadline, budget and permitted run environment; both worker families return structured results for the trusted host to interpret.[^protocol]

A coding run proceeds through these steps:

1. [Core dispatch](overview-core.md) snapshots the coding profile; the [executor provider](overview-providers.md) prepares a workspace and launches the selected worker.
2. The Codex driver prepares package configuration and optional dependencies before starting its agent. Claude Code prepares dependencies and repository context before constructing its query; command execution is relayed to the separate tool runner.
3. Model traffic passes through the [coding proxy](overview-coding-proxy.md). Workers produce bounded structured output and workspace changes.
4. The host materializes the result, normalizes lockfiles, checks cost and repository access again, verifies the run remains active, then asks VCS finalization to publish the permitted outcome.[^codex][^claude][^finalize]

The area owns wire schemas, worker preparation and output artifacts. Durable CodingRun state belongs to [Prisma](overview-prisma.md); job isolation and VCS authority belong to providers, with images and network policy supplied by [deployment modules](overview-deploy.md).

**What to do:** read [descriptor-bound artifact reads](bounded-file-descriptor.md) and [staged workspace replacement](workspace-staging-failure.md) when changing collection. Keep operator details in [coding-agent setup](../coding-agent-setup.md) and [worker isolation](../coding-worker-isolation.md).

[^protocol]: src/coding/protocol.ts, lines 455-496.

[^codex]: src/coding-worker/driver.ts, lines 254-294.

[^claude]: src/claude-coding-worker/driver.ts, lines 190-230.

[^finalize]: src/providers/executor/container.ts, lines 1418-1456.
