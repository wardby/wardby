---
type: overview
title: Run admission and execution
description: Dispatch persists admitted work before executors drive native or coding runs and recovery settles orphans.
tags: [execution, budgets, scheduling]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:22:13.475Z }
sources:
  - id: schedule
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/core/scheduler.ts#L55-L82
  - id: dispatch
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/core/dispatch.ts#L658-L716
  - id: engine
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/core/engine-native.ts#L90-L156
  - id: finish
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/core/runner.ts#L518-L534
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
      lines: [658, 716]
      symbol: dispatchRun
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:c39e7a16680eeb8e52c7d75fd70c0f30853f70728b47972af7429ef9e78837f0
    - id: engine
      repo: github:wardby/wardby
      path: src/core/engine-native.ts
      lines: [90, 156]
      symbol: NativeEngine.run
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:c38a58677db93241b5ddb7ffd85cae0af88d69903f018d47ca6282c9bb402070
    - id: finish
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [518, 534]
      symbol: finishRunClaimed
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:3f3f1310080c30aafa7b564d9439c9d40683faee04c506be8ae831628709ac33
  confidence: high
---

Core coordinates admission, run state, native execution, budgets, delegation and event-driven work. The scheduler uses the same dispatch path as other triggers; its due-window update participates in run creation.[^schedule][^dispatch]

A run proceeds through these steps:

1. A schedule, management call or event selects an agent and calls dispatch. Dispatch reads external declarations before persistence, then re-reads the agent inside the transaction.
2. Dispatch records the run and execution snapshot. Coding admission resolves its reservation and profile; the native runner loads its effective execution context.
3. The executor routes work to a native engine, isolated native worker or coding job. The native engine estimates input with tool definitions, checks budget before a model call, streams usage and invokes attached tools.
4. Completion conditionally changes an active run and reads back the persisted result. Reconciliation handles abandoned managed executions and downstream status cleanup.[^dispatch][^engine][^finish]

Core orchestrates Run, delegation edges, budget reservations and integration state in [Prisma](overview-prisma.md). It receives [provider interfaces](overview-providers.md), exposes operations through [MCP](overview-mcp.md), and hands isolated execution to [native isolation](overview-sandbox.md) or [coding workers](overview-coding.md). See [runtime architecture](../architecture-runtime.md) for the process model.

**What to do:** consult [schedule claims](schedule-claim-transaction.md), [delegation admission](delegation-admission-slots.md), [terminal-state ownership](terminal-run-first-writer.md) and [pricing races](run-pricing-first-writer.md) before changing admission or resume paths.

[^schedule]: src/core/scheduler.ts, lines 55-82.

[^dispatch]: src/core/dispatch.ts, lines 658-716.

[^engine]: src/core/engine-native.ts, lines 90-156.

[^finish]: src/core/runner.ts, lines 518-534.
