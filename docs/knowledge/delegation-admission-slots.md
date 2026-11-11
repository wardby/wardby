---
type: invariant
title: Budget-waiting delegations retain admission slots
description: Releasing the delegation gate during a budget wait must preserve duplicate-child and delegation-limit accounting.
tags: [delegation, concurrency, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-09T06:04:39.000Z }
sources:
  - id: admission
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/core/runner.ts#L1471-L1494
  - id: wait
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/core/runner.ts#L1496-L1521
  - id: persist
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/core/runner.ts#L1577-L1584
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/core/runner.ts", "src/core/serial-gate.ts", "src/core/delegation*", "src/core/dispatch.ts"]
  citations:
    - id: admission
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1471, 1494]
      symbol: createNativeRunTools
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:b72f974300dadd008b50d9630fa8288525a0aa0ea7e8fbdac0c61d65c77aea13
    - id: wait
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1496, 1521]
      symbol: createNativeRunTools
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:6975dbed58955273f74cc5b1fe78ed08e27243529823d26c5b83d2f986d33b14
    - id: persist
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1577, 1584]
      symbol: onPersisted
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:dbee201f976e3b74fffa64b5812e39c55bf86481e47abba414772f2deeb3c085
  confidence: high
---

Parallel delegation uses a per-attempt admission gate to keep the prior-child and delegation-limit checks together with child creation. Waiting delegation slots participate in those checks even before they have a persisted run; coding slots distinguish the child and repository.[^admission] A budget waiter registers its slot before releasing the gate, then reacquires the gate before removing that registration.[^wait] Coding dispatch releases the gate when the child row is persisted, allowing execution to overlap without overlapping admission.[^persist]

**What to do:** preserve the waiting-child reservation when changing retry or dispatch paths; releasing it early can admit the same slot twice or exceed the delegation count. Holding the gate through child execution instead serializes the batch. [Coding-agent setup, budgets](../coding-agent-setup.md) already describes sibling budget waits; this concept records the admission consequence rather than repeating that behavior.

[^admission]: src/core/runner.ts, lines 1471-1494.

[^wait]: src/core/runner.ts, lines 1496-1521.

[^persist]: src/core/runner.ts, lines 1577-1584.
