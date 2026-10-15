---
type: invariant
title: Task cancellation takes precedence over run status
description: A cancelled task remains cancelled even if its underlying run finishes with a different terminal outcome.
tags: [mcp, execution, cancellation]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T11:18:44.473Z }
sources:
  - id: read
    url: https://github.com/wardby/wardby/blob/0cd83fece6e5dafbb229aee4c293953e354cb42d/src/mcp/tasks/manager.ts#L108-L144
  - id: cancel
    url: https://github.com/wardby/wardby/blob/0cd83fece6e5dafbb229aee4c293953e354cb42d/src/mcp/tasks/manager.ts#L155-L171
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/tasks/**", "src/mcp/tools/trigger.ts"]
  citations:
    - id: read
      repo: github:wardby/wardby
      path: src/mcp/tasks/manager.ts
      lines: [108, 144]
      symbol: getTask
      sha: 0cd83fece6e5dafbb229aee4c293953e354cb42d
      spanHash: sha256:57fcf902067b811f63548e01e7008a5dfadd4504156904dc96ad26c68c323ea8
    - id: cancel
      repo: github:wardby/wardby
      path: src/mcp/tasks/manager.ts
      lines: [155, 171]
      symbol: cancelTask
      sha: 0cd83fece6e5dafbb229aee4c293953e354cb42d
      spanHash: sha256:68e640003a1eb74a96bab385cde0c8a658df6a2902ca10cb76a39d35ad5f60b7
  confidence: high
---

Ordinary task reads derive status from the run, but first return a persisted task cancellation without reading that run. Cancellation checks that the run is active, invokes the stop hook, then stamps the task cancelled; it does not stamp tasks whose runs were already terminal.[^read][^cancel]

**Why:** the run can finish between the active-state check and cancellation. Preserve the task-level precedence rather than synchronizing its status back from the run: cancellation of the task and the authoritative run outcome are separate facts. [Native sandbox](../native-sandbox.md) describes stopping execution; this concept records the task projection consequence.

[^read]: src/mcp/tasks/manager.ts, lines 108-144.

[^cancel]: src/mcp/tasks/manager.ts, lines 155-171.
