---
type: overview
title: Coding inputs and isolated workers
description: Shared protocols connect trusted run preparation to Codex or Claude Code workers and host finalization.
tags: [coding, workers, protocol]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-02T06:04:39.135Z }
sources:
  - id: protocol
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/coding/protocol.ts#L510-L558
  - id: codex
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/coding-worker/driver.ts#L255-L291
  - id: claude
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/claude-coding-worker/driver.ts#L267-L310
  - id: finalize
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/providers/executor/container.ts#L1811-L1857
  - id: delivery
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/providers/executor/container.ts#L1664-L1716
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/coding/**", "src/coding-worker/**", "src/claude-*/**"]
  citations:
    - id: protocol
      repo: github:wardby/wardby
      path: src/coding/protocol.ts
      lines: [510, 558]
      symbol: CodingTaskInputSchema
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:8c654392de29c752a51379363c205897a8fb864fbf0b6c765c80ad48bfa0d400
    - id: codex
      repo: github:wardby/wardby
      path: src/coding-worker/driver.ts
      lines: [255, 291]
      symbol: runCodingWorker
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:23e1dff04057f7f7a11a7b1501fc305b2d39634d2c41f429d62482026bc56e9c
    - id: claude
      repo: github:wardby/wardby
      path: src/claude-coding-worker/driver.ts
      lines: [267, 310]
      symbol: runClaudeCodingWorker
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:0b901e3ef70e64f506cb312d8e1e04a6bb4a3c9380a69cb2562e0e9ca86ddf6f
    - id: finalize
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [1811, 1857]
      symbol: ContainerExecutor.pushChanges
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:5339fcac2ea2929ce4bfad74ceef8eedb0773a5ee85fd4c9702f19728ad1e973
    - id: delivery
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [1664, 1716]
      symbol: ContainerExecutor.finishTerminal
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:8a389748f26f44f9f92b6d9fb702617e10093de5f2e806400b1a201d547070b5
  confidence: high
---

This area defines bounded coding inputs and outputs, repository profiles and policies, and isolated execution programs. A shared protocol carries the task, model, deadline, budget and permitted run environment; both worker families return structured results for the trusted host to interpret.[^protocol]

A coding run proceeds through these steps:

1. [Core dispatch](overview-core.md) snapshots the coding profile; the [executor provider](overview-providers.md) prepares a workspace and launches the selected worker.
2. The Codex driver prepares package configuration and optional dependencies before starting its agent. Claude Code prepares dependencies and repository context before constructing its query; command execution is relayed to the separate tool runner.
3. Model traffic passes through the [coding proxy](overview-coding-proxy.md). Workers produce bounded structured output and workspace changes.
4. The host materializes the result, normalizes lockfiles, checks cost and repository access again, verifies the run remains active, then asks VCS finalization to publish the permitted outcome. Structured budget-exhausted output can still deliver collected changes, and completed work can be delivered with an overrun recorded.[^delivery][^codex][^claude][^finalize]

The area owns wire schemas, worker preparation and output artifacts. Durable CodingRun state belongs to [Prisma](overview-prisma.md); job isolation and VCS authority belong to providers, with images and network policy supplied by [deployment modules](overview-deploy.md).

**What to do:** read [descriptor-bound artifact reads](bounded-file-descriptor.md) and [staged workspace replacement](workspace-staging-failure.md) when changing collection. Keep operator details in [coding-agent setup](../coding-agent-setup.md) and [worker isolation](../coding-worker-isolation.md).

[^protocol]: src/coding/protocol.ts, lines 510-558.

[^codex]: src/coding-worker/driver.ts, lines 255-291.

[^claude]: src/claude-coding-worker/driver.ts, lines 267-310.

[^finalize]: src/providers/executor/container.ts, lines 1811-1857.

[^delivery]: src/providers/executor/container.ts, lines 1664-1716.
