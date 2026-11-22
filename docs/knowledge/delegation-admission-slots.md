---
type: invariant
title: Budget-waiting delegations retain admission slots
description: Releasing the delegation gate during a budget wait must preserve duplicate-child and delegation-limit accounting.
tags: [delegation, concurrency, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-16T06:04:47.584Z }
sources:
  - id: admission
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/core/runner.ts#L1572-L1592
  - id: wait
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/core/runner.ts#L1594-L1626
  - id: persist
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/core/runner.ts#L1680-L1687
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/core/runner.ts", "src/core/serial-gate.ts", "src/core/delegation*", "src/core/dispatch.ts"]
  citations:
    - id: admission
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1572, 1592]
      symbol: createNativeRunTools
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:fbd45b23465551110de8dbea31eccec7dd92bd21092ab7fb581e6e9c4b6f968a
    - id: wait
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1594, 1626]
      symbol: createNativeRunTools
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:d7b7f08bab8b7302597200cd4d6ba4f9a2202b3be4d1c71ac8020955a69ca9ea
    - id: persist
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1680, 1687]
      symbol: onPersisted
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:dbee201f976e3b74fffa64b5812e39c55bf86481e47abba414772f2deeb3c085
  confidence: high
---

Parallel delegation uses a per-attempt admission gate to keep the prior-child and delegation-limit checks together with child creation. Waiting child-and-repository slots participate in those checks even before they have a persisted run.[^admission] A budget waiter registers its target slot before releasing the gate, then reacquires the gate before removing that registration.[^wait] Coding dispatch releases the gate when the child row is persisted, allowing execution to overlap without overlapping admission.[^persist]

**What to do:** preserve the waiting-child reservation when changing retry or dispatch paths; releasing it early can admit the same target twice or exceed the delegation count. Holding the gate through child execution instead serializes the batch. [Coding-agent setup, budgets](../coding-agent-setup.md) already describes sibling budget waits; this concept records the admission consequence rather than repeating that behavior.

[^admission]: src/core/runner.ts, lines 1572-1592.

[^wait]: src/core/runner.ts, lines 1594-1626.

[^persist]: src/core/runner.ts, lines 1680-1687.
