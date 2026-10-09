---
type: Architecture Pattern
title: Runner and engine
description: createRun persists a pending Run, executeRun drives it to a terminal state via the configured Engine.
tags: [runner, engine, runs]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: runner-ts
    resource: /src/core/runner.ts
---

# Split

* `createRun` persists a pending Run for an agent.
* `executeRun` drives an existing Run to a terminal state.
* `runAgent` does both and is what the CLI's `wardby run` uses (attended,
  foreground, no executor durability needed).[^runner-ts]

The scheduler can create the Run inside its claim transaction and hand the id
to an `Executor`, which calls `executeRun`. Only unattended scheduled runs
need the executor's heartbeat and reconciler durability.

# executeRun

A thin wrapper: load the agent and its tools, build the `EngineRunContext`
(wiring `runSandboxTool` to Zod-in-sandbox validation and the
[tool sandbox](/architecture/tool-sandbox.md)), call the configured `Engine`,
and persist the `EngineResult`. Every budget decision lives in the engine -
see [budget guardrail](/architecture/budget-guardrail.md).

# Related

Delegation to sub-agents, memory tools and serial gating are in
`src/core/`. Run state lives in the `Run` model
([database](/data/database-and-migrations.md)).

[^runner-ts]: src/core/runner.ts
