---
type: overview
title: Run admission and execution
description: Dispatch persists admitted work before executors drive native or coding runs and recovery settles orphans.
tags: [execution, budgets, scheduling]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:22:13.475Z }
sources:
  - id: schedule
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/core/scheduler.ts#L57-L92
  - id: dispatch
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/core/dispatch.ts#L1356-L1384
  - id: engine
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/core/engine-native.ts#L97-L163
  - id: finish
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/core/runner.ts#L640-L657
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/core/**"]
  citations:
    - id: schedule
      repo: github:wardby/wardby
      path: src/core/scheduler.ts
      lines: [57, 92]
      symbol: claimDueRun
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:0933bb6ff885ba839afc76019f33acf903715109da05ed11cf575e82c34829e1
    - id: dispatch
      repo: github:wardby/wardby
      path: src/core/dispatch.ts
      lines: [1356, 1384]
      symbol: dispatchRun
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:25f897ce9b0821e73d2ad952cc71ea0ae183a6054f26419c522ea6149624971f
    - id: engine
      repo: github:wardby/wardby
      path: src/core/engine-native.ts
      lines: [97, 163]
      symbol: NativeEngine.run
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:c38a58677db93241b5ddb7ffd85cae0af88d69903f018d47ca6282c9bb402070
    - id: finish
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [640, 657]
      symbol: finishRunClaimed
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:258b0ccb1bf328fef95a5e459858eb3f02ecc3d600f6ff4a7aae562a6416936c
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

[^schedule]: src/core/scheduler.ts, lines 57-92.

[^dispatch]: src/core/dispatch.ts, lines 1356-1384.

[^engine]: src/core/engine-native.ts, lines 97-163.

[^finish]: src/core/runner.ts, lines 640-657.
