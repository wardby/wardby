---
type: invariant
title: Schedule deduplication belongs to the transaction
description: A scheduler lease cannot replace the atomic schedule-window claim and run creation.
tags: [scheduling, concurrency]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:22:57.651Z }
sources:
  - id: claim
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/core/scheduler.ts#L50-L82
  - id: lock
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/core/dispatch.ts#L695-L712
wardby:
  schema: 1
  roles: [builder, reviewer, planner]
  affects: ["src/core/scheduler.ts", "src/core/dispatch.ts"]
  citations:
    - id: claim
      repo: github:wardby/wardby
      path: src/core/scheduler.ts
      lines: [50, 82]
      symbol: claimDueRun
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:1464539e5b1ac8acf09d9869aaab0fd7ce71ff9647384366537280c850de7b89
    - id: lock
      repo: github:wardby/wardby
      path: src/core/dispatch.ts
      lines: [695, 712]
      symbol: dispatchRun
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:9e665721a6f090632daf476a4361226e8ca5d96b8addea9880541d994a0a2506
  confidence: high
---

The scheduler rechecks the due window under an agent row lock, advances `lastScheduledAt`, and creates the run in the same dispatch transaction.[^claim][^lock]

**Why:** the lease coordinates ticking processes, but cannot prevent overlapping claims within a process. Moving the schedule advance outside the transaction can consume a window without a run or admit the same window twice. Keep the claim and persistence together.

[^claim]: src/core/scheduler.ts, lines 50-82.

[^lock]: src/core/dispatch.ts, lines 695-712.
