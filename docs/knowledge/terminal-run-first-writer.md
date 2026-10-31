---
type: invariant
title: Terminal run state belongs to the first writer
description: Run completion must conditionally write pending or running rows and read back the persisted winner.
tags: [execution, recovery, concurrency]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:22:57.651Z }
sources:
  - id: states
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/core/run-status.ts#L1-L12
  - id: finish
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/core/runner.ts#L507-L524
wardby:
  schema: 1
  roles: [builder, reviewer, planner]
  affects: ["src/core/runner.ts", "src/core/run-status.ts", "src/core/reconciler.ts", "src/core/dispatch.ts"]
  citations:
    - id: states
      repo: github:wardby/wardby
      path: src/core/run-status.ts
      lines: [1, 12]
      symbol: DRIVABLE
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:0b275e54bc7a77011361283a21bea1ca1f5c19b025b7348d8273d2ae0e20a57e
    - id: finish
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [507, 524]
      symbol: finishRunClaimed
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:258b0ccb1bf328fef95a5e459858eb3f02ecc3d600f6ff4a7aae562a6416936c
  confidence: high
---

`finishRunClaimed` restricts its update to pending or running rows, then reads the stored run even when its update lost the race.[^states][^finish] The step-ownership behavior is already described in [Durable executor](../security-deployment.md#durable-executor); this contract covers the terminal database write and its return value.

**What to do:** preserve the status predicate and read-back when adding completion paths. An unconditional write can overwrite a completed or lost run; returning a locally assembled result can report an outcome that never became authoritative.

[^states]: src/core/run-status.ts, lines 1-12.

[^finish]: src/core/runner.ts, lines 507-524.
