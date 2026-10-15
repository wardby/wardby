---
type: invariant
title: Budget-waiting delegations retain admission slots
description: Releasing the delegation gate during a budget wait must preserve duplicate-child and delegation-limit accounting.
tags: [delegation, concurrency, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:20:14.397Z }
sources:
  - id: admission
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/core/runner.ts#L1033-L1051
  - id: wait
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/core/runner.ts#L1064-L1087
  - id: persist
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/core/runner.ts#L1140-L1147
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/core/runner.ts", "src/core/serial-gate.ts", "src/core/delegation*", "src/core/dispatch.ts"]
  citations:
    - id: admission
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1033, 1051]
      symbol: createNativeRunTools
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:24aa5858bb84f9930463cef67a2eebc9b1a331c55f2a38a31182bc874aa787dd
    - id: wait
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1064, 1087]
      symbol: createNativeRunTools
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:0d807898cdcc3348b5509500c2beb2179fb6e755d2a58b12adfaf08ea28d7ee8
    - id: persist
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1140, 1147]
      symbol: onPersisted
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:dbee201f976e3b74fffa64b5812e39c55bf86481e47abba414772f2deeb3c085
  confidence: high
---

Parallel delegation uses a per-attempt admission gate to keep the prior-child and delegation-limit checks together with child creation. Waiting child IDs participate in those checks even before they have a persisted run.[^admission] A budget waiter registers its child ID before releasing the gate, then reacquires the gate before removing that registration.[^wait] Coding dispatch releases the gate when the child row is persisted, allowing execution to overlap without overlapping admission.[^persist]

**What to do:** preserve the waiting-child reservation when changing retry or dispatch paths; releasing it early can admit the same child twice or exceed the delegation count. Holding the gate through child execution instead serializes the batch. [Coding-agent setup, budgets](../coding-agent-setup.md) already describes sibling budget waits; this concept records the admission consequence rather than repeating that behavior.

[^admission]: src/core/runner.ts, lines 1033-1051.
[^wait]: src/core/runner.ts, lines 1064-1087.
[^persist]: src/core/runner.ts, lines 1140-1147.
