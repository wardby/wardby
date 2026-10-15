---
type: invariant
title: Parallel delegations serialize admission until persistence
description: Hold the per-attempt gate through limit checks and child persistence, then release it before waiting for execution.
tags: [delegation, concurrency]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:22:57.651Z }
sources:
  - id: gate
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/core/serial-gate.ts#L1-L29
  - id: admission
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/core/runner.ts#L1033-L1055
  - id: persisted
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/core/runner.ts#L1139-L1148
  - id: inline
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/core/runner.ts#L1287-L1308
wardby:
  schema: 1
  roles: [builder, reviewer, planner]
  affects: ["src/core/runner.ts", "src/core/serial-gate.ts", "src/core/dispatch.ts"]
  citations:
    - id: gate
      repo: github:wardby/wardby
      path: src/core/serial-gate.ts
      lines: [1, 29]
      symbol: createSerialGate
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:1a300d5df50451ed5b30b00ae4b35b4ac1736f1433d892b35e9844c4e81efe99
    - id: admission
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1033, 1055]
      symbol: executeRun
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:d3eaa8da43c9a61595b611dd8b1035de8fe9f15c832518e1a5cbb2342f10ca29
    - id: persisted
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1139, 1148]
      symbol: onPersisted
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:c7e1759c97ca9265d6ae368dd2f1e0e02504f0a2eb697fa7eb806165e0e64a5d
    - id: inline
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1287, 1308]
      symbol: executeRun
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:5ca93c278fc7df108d06fab11d9370defdde6ea67cb4afbd9f491d9f6b35337c
  confidence: high
---

The runner takes a per-attempt FIFO gate before checking prior children and delegation limits. A coding child releases it in `onPersisted`; an inline native child releases it after its row is created.[^gate][^admission][^persisted][^inline]

**Why:** releasing before persistence allows simultaneous calls to pass the same admission checks; holding it throughout execution prevents the next child from starting concurrently. This is a process-local admission boundary, not a lock across run attempts or nested branches. The operator-visible nested fan-out budget limitation is already documented in [agent recipes](../agent-recipes.md#limits).

[^gate]: src/core/serial-gate.ts, lines 1-29.
[^admission]: src/core/runner.ts, lines 1033-1055.
[^persisted]: src/core/runner.ts, lines 1139-1148.
[^inline]: src/core/runner.ts, lines 1287-1308.
