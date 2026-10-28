---
type: invariant
title: Budget-waiting delegations retain admission slots
description: Releasing the delegation gate during a budget wait must preserve duplicate-child and delegation-limit accounting.
tags: [delegation, concurrency, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:20:14.397Z }
sources:
  - id: admission
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/core/runner.ts#L1318-L1336
  - id: wait
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/core/runner.ts#L1342-L1370
  - id: persist
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/core/runner.ts#L1424-L1431
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/core/runner.ts", "src/core/serial-gate.ts", "src/core/delegation*", "src/core/dispatch.ts"]
  citations:
    - id: admission
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1318, 1336]
      symbol: createNativeRunTools
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:3b01bdf1c2104b1ce1256bff22b131b94943ce8fae5ff755da9b1ecabb225734
    - id: wait
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1342, 1370]
      symbol: createNativeRunTools
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:6d7c27fe8c312017438357b77a6d545c0137830582650c8f2d3f648e1f43f367
    - id: persist
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1424, 1431]
      symbol: onPersisted
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:dbee201f976e3b74fffa64b5812e39c55bf86481e47abba414772f2deeb3c085
  confidence: high
---

Parallel delegation uses a per-attempt admission gate to keep the prior-child and delegation-limit checks together with child creation. Waiting child IDs participate in those checks even before they have a persisted run.[^admission] A budget waiter registers its child ID before releasing the gate, then reacquires the gate before removing that registration.[^wait] Coding dispatch releases the gate when the child row is persisted, allowing execution to overlap without overlapping admission.[^persist]

**What to do:** preserve the waiting-child reservation when changing retry or dispatch paths; releasing it early can admit the same child twice or exceed the delegation count. Holding the gate through child execution instead serializes the batch. [Coding-agent setup, budgets](../coding-agent-setup.md) already describes sibling budget waits; this concept records the admission consequence rather than repeating that behavior.

[^admission]: src/core/runner.ts, lines 1318-1336.

[^wait]: src/core/runner.ts, lines 1342-1370.

[^persist]: src/core/runner.ts, lines 1424-1431.
