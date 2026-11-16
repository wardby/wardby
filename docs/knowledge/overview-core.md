---
type: overview
title: Run admission and execution
description: Dispatch persists admitted work before executors drive native or coding runs and recovery settles orphans.
tags: [execution, budgets, scheduling]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-16T06:04:47.589Z }
sources:
  - id: schedule
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/core/scheduler.ts#L55-L82
  - id: dispatch
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/core/dispatch.ts#L1018-L1056
  - id: engine
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/core/engine-native.ts#L97-L163
  - id: finish
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/core/runner.ts#L596-L613
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/core/**"]
  citations:
    - id: schedule
      repo: github:wardby/wardby
      path: src/core/scheduler.ts
      lines: [55, 82]
      symbol: claimDueRun
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:73b642e5042e6553e4585eed6577d243f772826f7cf84a63a3b57a85d28318f5
    - id: dispatch
      repo: github:wardby/wardby
      path: src/core/dispatch.ts
      lines: [1018, 1056]
      symbol: dispatchRun
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:9f3b60e10b763628a2b2bc6a2d259d0e8a451d401aa153ffc82065e99dd2acda
    - id: engine
      repo: github:wardby/wardby
      path: src/core/engine-native.ts
      lines: [97, 163]
      symbol: NativeEngine.run
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:c38a58677db93241b5ddb7ffd85cae0af88d69903f018d47ca6282c9bb402070
    - id: finish
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [596, 613]
      symbol: finishRunClaimed
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:258b0ccb1bf328fef95a5e459858eb3f02ecc3d600f6ff4a7aae562a6416936c
  confidence: high
---

Core coordinates admission, run state, native execution, budgets, delegation, documents and event-driven work. The scheduler uses the same dispatch path as other triggers; its due-window update participates in run creation.[^schedule][^dispatch]

A run proceeds through these steps:

1. A schedule, management call or event selects an agent and calls dispatch. Dispatch resolves repository sets and external declarations before persistence, then re-reads the agent inside the transaction.
2. Dispatch records the run and execution snapshot. Coding admission resolves its reservation, profile and repository snapshots; the native runner loads its effective execution context.
3. The executor routes work to a native engine, isolated native worker or coding job. The native engine estimates input with tool definitions, checks budget before a model call, streams usage and invokes attached tools.
4. Completion conditionally changes an active run and reads back the persisted result. Reconciliation handles abandoned managed executions and downstream status cleanup.[^dispatch][^engine][^finish]

Core orchestrates Run, delegation edges, budget reservations and integration state in [Prisma](overview-prisma.md). It receives [provider interfaces](overview-providers.md), exposes operations through [MCP](overview-mcp.md), and hands isolated execution to [native isolation](overview-sandbox.md) or [coding workers](overview-coding.md). See [runtime architecture](../architecture-runtime.md) for the process model.

**What to do:** consult [schedule claims](schedule-claim-transaction.md), [delegation admission](delegation-admission-slots.md), [terminal-state ownership](terminal-run-first-writer.md) and [pricing races](run-pricing-first-writer.md) before changing admission or resume paths.

[^schedule]: src/core/scheduler.ts, lines 55-82.

[^dispatch]: src/core/dispatch.ts, lines 1018-1056.

[^engine]: src/core/engine-native.ts, lines 97-163.

[^finish]: src/core/runner.ts, lines 596-613.
