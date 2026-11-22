---
type: overview
title: Coding inputs and isolated workers
description: Shared protocols connect trusted run preparation to Codex or Claude Code workers and host finalization.
tags: [coding, workers, protocol]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-16T06:04:47.588Z }
sources:
  - id: protocol
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/coding/protocol.ts#L577-L596
  - id: codex
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/coding-worker/driver.ts#L358-L431
  - id: claude
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/claude-coding-worker/driver.ts#L425-L501
  - id: finalize
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/providers/executor/container.ts#L2977-L3001
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/coding/**", "src/coding-worker/**", "src/claude-*/**"]
  citations:
    - id: protocol
      repo: github:wardby/wardby
      path: src/coding/protocol.ts
      lines: [577, 596]
      symbol: CodingTaskInputSchema
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:b3abdb5500069b6c51bfc462be30f091a99072d2dbb3d88e17a9dc9b790d2db1
    - id: codex
      repo: github:wardby/wardby
      path: src/coding-worker/driver.ts
      lines: [358, 431]
      symbol: runCodingWorker
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:9241929c03ac62815bb0ab1e9ff6833a662c8f188627c97a4699886a0810de32
    - id: claude
      repo: github:wardby/wardby
      path: src/claude-coding-worker/driver.ts
      lines: [425, 501]
      symbol: runClaudeCodingWorker
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:c8bf538f645367b8456ce139507e5a4aa70d4c7e3b0f0503838b1bfcba117f03
    - id: finalize
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [2977, 3001]
      symbol: ContainerExecutor.finishTerminal
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:54964f267bd9ff8fdad9d4aa3b157d974868079a58d17ad6561afe4ccbf016c2
  confidence: high
---

This area defines bounded coding inputs and outputs, repository profiles and policies, and isolated execution programs. A shared protocol carries the task, model, deadline, budget and permitted run environment; both worker families return structured results for the trusted host to interpret.[^protocol]

A coding run proceeds through these steps:

1. [Core dispatch](overview-core.md) snapshots the coding profile; the [executor provider](overview-providers.md) prepares a workspace and launches the selected worker.
2. The Codex driver prepares package configuration and optional dependencies before starting its agent. Claude Code prepares dependencies and repository context before constructing its query; command execution is relayed to the separate tool runner.
3. Model traffic passes through the [coding proxy](overview-coding-proxy.md). Workers produce bounded structured output and workspace changes. Git-history inputs additionally require git and return committed work through a result bundle.
4. The host materializes the result, normalizes lockfiles, checks cost and repository access again, verifies the run remains active, then asks VCS finalization to publish the permitted outcome. A run with several repositories collects and finalizes each writable repository through the same trusted boundary.[^codex][^claude][^finalize]

The area owns wire schemas, worker preparation and output artifacts. Durable CodingRun state belongs to [Prisma](overview-prisma.md); job isolation and VCS authority belong to providers, with images and network policy supplied by [deployment modules](overview-deploy.md).

**What to do:** read [descriptor-bound artifact reads](bounded-file-descriptor.md) and [staged workspace replacement](workspace-staging-failure.md) when changing collection. Keep operator details in [coding-agent setup](../coding-agent-setup.md) and [worker isolation](../coding-worker-isolation.md).

[^protocol]: src/coding/protocol.ts, lines 577-596.

[^codex]: src/coding-worker/driver.ts, lines 358-431.

[^claude]: src/claude-coding-worker/driver.ts, lines 425-501.

[^finalize]: src/providers/executor/container.ts, lines 2977-3001.
