---
type: overview
title: Coding inputs and isolated workers
description: Shared protocols connect trusted run preparation to Codex or Claude Code workers and host finalization.
tags: [coding, workers, protocol]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-23T06:06:02.167Z }
sources:
  - id: protocol
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/coding/protocol.ts#L731-L770
  - id: codex
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/coding-worker/driver.ts#L425-L465
  - id: claude
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/claude-coding-worker/driver.ts#L597-L665
  - id: finalize
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/providers/executor/container.ts#L3585-L3627
  - id: collect
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/providers/executor/container.ts#L3552-L3583
  - id: repositories
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/providers/jobs/docker.ts#L811-L839
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/coding/**", "src/coding-worker/**", "src/claude-*/**"]
  citations:
    - id: protocol
      repo: github:wardby/wardby
      path: src/coding/protocol.ts
      lines: [731, 770]
      symbol: CodingTaskInputSchema
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:90367000478914ed999b3a7a051390540c70d48ce035b43d3df1727033378e81
    - id: codex
      repo: github:wardby/wardby
      path: src/coding-worker/driver.ts
      lines: [425, 465]
      symbol: runCodingWorker
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:51238d03c08816d30c159ae7319e4a2b66c8d3029f85e156c8e1884253fa1849
    - id: claude
      repo: github:wardby/wardby
      path: src/claude-coding-worker/driver.ts
      lines: [597, 665]
      symbol: runClaudeCodingWorker
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:b7c68d62db4694b2c9af9fed47424ee97906c26ff6883cd9c1c514a6890557e1
    - id: finalize
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [3585, 3627]
      symbol: ContainerExecutor.finalizeCollected
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:c35f8861bbec19adec91088422978b0ef86a9fc4839fb34b0e3c93d61f718e8a
    - id: collect
      repo: github:wardby/wardby
      path: src/providers/executor/container.ts
      lines: [3552, 3583]
      symbol: ContainerExecutor.materialize
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:835040256a216ca9b28c8f5ea388119930922618b1c4feaf31af54866da74039
    - id: repositories
      repo: github:wardby/wardby
      path: src/providers/jobs/docker.ts
      lines: [811, 839]
      symbol: DockerJobLauncher.materializeWorkspace
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:f7cc6a8ffd04719d90dbe74a290fc85d281ab181a5664c8e6b18781dcc75384a
  confidence: high
---

This area defines bounded coding inputs and outputs, repository profiles and policies, and isolated execution programs. A shared protocol carries the task, model, deadline, budget and permitted run environment; both worker families return structured results for the trusted host to interpret.[^protocol]

A coding run proceeds through these steps:

1. [Core dispatch](overview-core.md) snapshots the coding profile; the [executor provider](overview-providers.md) prepares a workspace and launches the selected worker.
2. The Codex driver prepares package configuration and optional dependencies before starting its agent. Claude Code prepares dependencies and repository context before constructing its query; command execution is relayed to the separate tool runner.
3. Model traffic passes through the [coding proxy](overview-coding-proxy.md). Workers produce bounded structured output and workspace changes.
4. The host checks the result and accounting, materializes writable workspaces, normalizes lockfiles, checks repository access again, verifies the run remains active, then asks VCS finalization to publish the permitted outcome. Optional Git history travels as a separate result bundle rather than importing worker Git metadata into the trusted workspace.[^collect][^codex][^claude][^finalize]

The area owns wire schemas, worker preparation and output artifacts. Runs may include additional read-only or writable repositories; only writable workspaces are collected.[^repositories] Durable CodingRun state belongs to [Prisma](overview-prisma.md); job isolation and VCS authority belong to providers, with images and network policy supplied by [deployment modules](overview-deploy.md).

**What to do:** read [descriptor-bound artifact reads](bounded-file-descriptor.md) and [staged workspace replacement](workspace-staging-failure.md) when changing collection. Keep operator details in [coding-agent setup](../coding-agent-setup.md) and [worker isolation](../coding-worker-isolation.md).

[^protocol]: src/coding/protocol.ts, lines 731-770.

[^codex]: src/coding-worker/driver.ts, lines 425-465.

[^claude]: src/claude-coding-worker/driver.ts, lines 597-665.

[^finalize]: src/providers/executor/container.ts, lines 3585-3627.

[^collect]: src/providers/executor/container.ts, lines 3552-3583.

[^repositories]: src/providers/jobs/docker.ts, lines 811-839.
