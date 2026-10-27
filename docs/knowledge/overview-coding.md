---
type: overview
title: Coding inputs and isolated workers
description: Shared protocols connect trusted run preparation to Codex or Claude Code workers and host finalization.
tags: [coding, workers, protocol]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-19T06:04:43.490Z }
sources:
  - id: protocol
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/coding/protocol.ts#L503-L550
  - id: codex
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/coding-worker/driver.ts#L255-L294
  - id: claude
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/claude-coding-worker/driver.ts#L260-L309
  - id: finalize
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/providers/executor/container.ts#L1780-L1806
  - id: outcomes
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/providers/executor/container.ts#L1621-L1669
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/coding/**", "src/coding-worker/**", "src/claude-*/**"]
  citations:
    - id: protocol
      repo: github:wardby/wardby
      path: src/coding/protocol.ts
      lines: [503, 550]
      symbol: CodingTaskInputSchema
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:646da9ac0e0988a53d38894719e731b2c8eba497b0969e02d0ae43d12052baad
    - id: codex
      repo: github:wardby/wardby
      path: src/coding-worker/driver.ts
      lines: [255, 294]
      symbol: runCodingWorker
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:40cc067eb902f8cbd6a31d385523169e0714a606c523eee98c3186f290b25f42
    - id: claude
      repo: github:wardby/wardby
      path: src/claude-coding-worker/driver.ts
      lines: [260, 309]
      symbol: runClaudeCodingWorker
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:93267800ee123c5c50fcabccbb4c2de36729e8e105160f192ef14d74a86b0121
    - id: finalize
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [1780, 1806]
      symbol: ContainerExecutor.pushChanges
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:62698c3161eb819ed1172e8437d25b9751423b877211b89f82b6f165f69351a1
    - id: outcomes
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [1621, 1669]
      symbol: ContainerExecutor.finishTerminal
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:b500b4100a63ccf5947f66694b11555896b017e4ceaac3a1f1453e8c14a99504
  confidence: high
---

This area defines bounded coding inputs and outputs, repository profiles and policies, and isolated execution programs. A shared protocol carries the task, model, deadline, budget and permitted run environment; both worker families return structured results for the trusted host to interpret.[^protocol]

A coding run proceeds through these steps:

1. [Core dispatch](overview-core.md) snapshots the coding profile; the [executor provider](overview-providers.md) prepares a workspace and launches the selected worker.
2. The Codex driver prepares package configuration and optional dependencies before starting its agent. Claude Code prepares dependencies and repository context before constructing its query; command execution is relayed to the separate tool runner.
3. Model traffic passes through the [coding proxy](overview-coding-proxy.md). Workers produce bounded structured output and workspace changes.
4. The host parses and checks the result against the active run. Changed work is materialized and lockfiles normalized; repository access and run activity are checked again before VCS publication. A clean worker exit at its budget limit can preserve partial changes, while a no-change result can refresh an existing description.[^codex][^claude][^finalize][^outcomes]

The area owns wire schemas, worker preparation and output artifacts. Durable CodingRun state belongs to [Prisma](overview-prisma.md); job isolation and VCS authority belong to providers, with images and network policy supplied by [deployment modules](overview-deploy.md).

**What to do:** read [descriptor-bound artifact reads](bounded-file-descriptor.md) and [staged workspace replacement](workspace-staging-failure.md) when changing collection. Keep operator details in [coding-agent setup](../coding-agent-setup.md) and [worker isolation](../coding-worker-isolation.md).

[^protocol]: src/coding/protocol.ts, lines 503-550.

[^codex]: src/coding-worker/driver.ts, lines 255-294.

[^claude]: src/claude-coding-worker/driver.ts, lines 260-309.

[^finalize]: src/providers/executor/container.ts, lines 1780-1806.

[^outcomes]: src/providers/executor/container.ts, lines 1621-1669.
