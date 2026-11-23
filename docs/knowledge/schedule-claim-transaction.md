---
type: invariant
title: Schedule deduplication belongs to the transaction
description: A scheduler lease cannot replace the atomic schedule-window claim and run creation.
tags: [scheduling, concurrency]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:22:57.651Z }
sources:
  - id: claim
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/core/scheduler.ts#L57-L92
  - id: lock
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/core/dispatch.ts#L1356-L1374
wardby:
  schema: 1
  roles: [builder, reviewer, planner]
  affects: ["src/core/scheduler.ts", "src/core/dispatch.ts"]
  citations:
    - id: claim
      repo: github:wardby/wardby
      path: src/core/scheduler.ts
      lines: [57, 92]
      symbol: claimDueRun
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:0933bb6ff885ba839afc76019f33acf903715109da05ed11cf575e82c34829e1
    - id: lock
      repo: github:wardby/wardby
      path: src/core/dispatch.ts
      lines: [1356, 1374]
      symbol: dispatchRun
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:f0062825a9c12aa053218e8e846a3b86cff1b842fa08a942bfec340f36fbf38f
  confidence: high
---

The scheduler rechecks the due window under an agent row lock, advances `lastScheduledAt`, and creates the run in the same dispatch transaction.[^claim][^lock]

**Why:** the lease coordinates ticking processes, but cannot prevent overlapping claims within a process. Moving the schedule advance outside the transaction can consume a window without a run or admit the same window twice. Keep the claim and persistence together.

[^claim]: src/core/scheduler.ts, lines 57-92.

[^lock]: src/core/dispatch.ts, lines 1356-1374.
