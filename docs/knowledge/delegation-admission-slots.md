---
type: invariant
title: Budget-waiting delegations retain admission slots
description: Releasing the delegation gate during a budget wait must preserve duplicate-child and delegation-limit accounting.
tags: [delegation, concurrency, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:20:14.397Z }
sources:
  - id: admission
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/core/runner.ts#L1284-L1300
  - id: wait
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/core/runner.ts#L1326-L1341
  - id: persist
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/core/runner.ts#L1395-L1403
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/core/runner.ts", "src/core/serial-gate.ts", "src/core/delegation*", "src/core/dispatch.ts"]
  citations:
    - id: admission
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1284, 1300]
      symbol: createNativeRunTools
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:6cfcce09c6ce0eff7a9d1577ef71997a3a9263cfb9b0db1eca859d64174b3c7e
    - id: wait
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1326, 1341]
      symbol: createNativeRunTools
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:3dfb5e2be6371d62962693d80c9f767eb77f93a44cbb5c04ee54b53ed21b266a
    - id: persist
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1395, 1403]
      symbol: onPersisted
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:2db26870eb87882356e49746dd355ccdec6670ca60d51edf5d9234314a741523
  confidence: high
---

Parallel delegation uses a per-attempt admission gate to keep the prior-child and delegation-limit checks together with child creation. Waiting child IDs participate in those checks even before they have a persisted run.[^admission] A budget waiter registers its child ID before releasing the gate, then reacquires the gate before removing that registration.[^wait] Coding dispatch releases the gate when the child row is persisted, allowing execution to overlap without overlapping admission.[^persist]

**What to do:** preserve the waiting-child reservation when changing retry or dispatch paths; releasing it early can admit the same child twice or exceed the delegation count. Holding the gate through child execution instead serializes the batch. [Coding-agent setup, budgets](../coding-agent-setup.md) already describes sibling budget waits; this concept records the admission consequence rather than repeating that behavior.

[^admission]: src/core/runner.ts, lines 1284-1300.

[^wait]: src/core/runner.ts, lines 1326-1341.

[^persist]: src/core/runner.ts, lines 1395-1403.
