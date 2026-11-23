---
type: invariant
title: Budget-waiting delegations retain admission slots
description: Releasing the delegation gate during a budget wait must preserve checks for duplicate child/repository slots and delegation limits.
tags: [delegation, concurrency, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-23T06:06:02.167Z }
sources:
  - id: admission
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/core/runner.ts#L1663-L1683
  - id: wait
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/core/runner.ts#L1690-L1713
  - id: persist
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/core/runner.ts#L1773-L1780
  - id: slots
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/core/delegation-slots.ts#L1-L18
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/core/runner.ts", "src/core/serial-gate.ts", "src/core/delegation*", "src/core/dispatch.ts"]
  citations:
    - id: admission
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1663, 1683]
      symbol: createNativeRunTools
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:390483ba6a401538609a43ab1ed17aa489d5e5ae847b4be96f54a0d9ee556039
    - id: wait
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1690, 1713]
      symbol: createNativeRunTools
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:707042db0d080558112f7dbbef99eba67bff8eae1fbe0f8b40ddae5045d18e9b
    - id: persist
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1773, 1780]
      symbol: onPersisted
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:dbee201f976e3b74fffa64b5812e39c55bf86481e47abba414772f2deeb3c085
    - id: slots
      repo: github:wardby/wardby
      path: src/core/delegation-slots.ts
      lines: [1, 18]
      symbol: delegationSlot / priorDelegationSlots
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:ff82c6409ff23255fc7008f44c8ff041a38b60ed0f50f44d3f8e516b7ea12160
  confidence: high
---

Parallel delegation uses a per-attempt admission gate to keep the prior-child and delegation-limit checks together with child creation. Waiting slots participate in those checks even before they have a persisted run. A native slot identifies the child; a coding slot also includes its resolved repository, so the same coding child can serve distinct repositories without admitting the same pair twice.[^slots][^admission] A budget waiter registers its slot before releasing the gate, then reacquires the gate before removing that registration.[^wait] Coding dispatch releases the gate when the child row is persisted, allowing execution to overlap without overlapping admission.[^persist]

**What to do:** preserve the waiting-child reservation when changing retry or dispatch paths; releasing it early can admit the same child/repository slot twice or exceed the delegation count. Holding the gate through child execution instead serializes the batch. [Coding-agent setup, budgets](../coding-agent-setup.md) already describes sibling budget waits; this concept records the admission consequence rather than repeating that behavior.

[^admission]: src/core/runner.ts, lines 1663-1683.

[^wait]: src/core/runner.ts, lines 1690-1713.

[^persist]: src/core/runner.ts, lines 1773-1780.

[^slots]: src/core/delegation-slots.ts, lines 1-18.
