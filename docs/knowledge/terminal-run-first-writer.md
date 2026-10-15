---
type: invariant
title: Terminal run state belongs to the first writer
description: Run completion must conditionally write pending or running rows and read back the persisted winner.
tags: [execution, recovery, concurrency]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:22:57.651Z }
sources:
  - id: states
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/core/runner.ts#L457-L469
  - id: finish
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/core/runner.ts#L496-L513
wardby:
  schema: 1
  roles: [builder, reviewer, planner]
  affects: ["src/core/runner.ts", "src/core/reconciler.ts", "src/core/dispatch.ts"]
  citations:
    - id: states
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [457, 469]
      symbol: DRIVABLE
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:77bd85d5b8025e9319afba8477923d068afa0e9bfaea46be28d68b2c41996e7b
    - id: finish
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [496, 513]
      symbol: finishRunClaimed
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:258b0ccb1bf328fef95a5e459858eb3f02ecc3d600f6ff4a7aae562a6416936c
  confidence: high
---

`finishRunClaimed` restricts its update to pending or running rows, then reads the stored run even when its update lost the race.[^states][^finish] The step-ownership behavior is already described in [durable execution](../security-deployment.md); this contract covers the terminal database write and its return value.

**What to do:** preserve the status predicate and read-back when adding completion paths. An unconditional write can overwrite a completed or lost run; returning a locally assembled result can report an outcome that never became authoritative.

[^states]: src/core/runner.ts, lines 457-469.
[^finish]: src/core/runner.ts, lines 496-513.
