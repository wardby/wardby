---
type: invariant
title: Terminal run state belongs to the first writer
description: Run completion must conditionally write pending or running rows and read back the persisted winner.
tags: [execution, recovery, concurrency]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:22:57.651Z }
sources:
  - id: states
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/core/runner.ts#L460-L472
  - id: finish
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/core/runner.ts#L499-L516
wardby:
  schema: 1
  roles: [builder, reviewer, planner]
  affects: ["src/core/runner.ts", "src/core/reconciler.ts", "src/core/dispatch.ts"]
  citations:
    - id: states
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [460, 472]
      symbol: DRIVABLE
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:77bd85d5b8025e9319afba8477923d068afa0e9bfaea46be28d68b2c41996e7b
    - id: finish
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [499, 516]
      symbol: finishRunClaimed
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:258b0ccb1bf328fef95a5e459858eb3f02ecc3d600f6ff4a7aae562a6416936c
  confidence: high
---

`finishRunClaimed` restricts its update to pending or running rows, then reads the stored run even when its update lost the race.[^states][^finish] The step-ownership behavior is already described in [Durable executor](../security-deployment.md#durable-executor); this contract covers the terminal database write and its return value.

**What to do:** preserve the status predicate and read-back when adding completion paths. An unconditional write can overwrite a completed or lost run; returning a locally assembled result can report an outcome that never became authoritative.

[^states]: src/core/runner.ts, lines 460-472.

[^finish]: src/core/runner.ts, lines 499-516.
