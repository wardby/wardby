---
type: invariant
title: Private datastore wrappers must reject shared methods
description: Prefix restrictions on private keys cannot authorize the provider shared-store methods.
tags: [datastores, capabilities, isolation]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:24:27.356Z }
sources:
  - id: deny
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/providers/datastore/scoped.ts#L33-L52
  - id: wiring
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/core/runner.ts#L1566-L1583
  - id: shared
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/core/datastores.ts#L119-L151
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/providers/datastore/scoped.ts", "src/core/datastores.ts", "src/core/runner.ts", "src/sandbox/**"]
  citations:
    - id: deny
      repo: github:wardby/wardby
      path: src/providers/datastore/scoped.ts
      lines: [33, 52]
      symbol: scopeDatastore shared methods
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:ab019d2d34268011795717728e7d3a3f37b0e9c106c6f515b935abd4e94a8760
    - id: wiring
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [1566, 1583]
      symbol: createNativeRunTools.scopedHost
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:64f24616313e56c64acc3854411117fc93c92fbc7adb1053ec669938cbe1de2f
    - id: shared
      repo: github:wardby/wardby
      path: src/core/datastores.ts
      lines: [119, 151]
      symbol: scopeSharedDatastoreAccessor
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:508ad8dbaa811b4528d626431b84eda9dd6fe5a2929ffc6005106c9b2eb23703
  confidence: high
---

Private and shared datastore operations originate from the same provider interface but pass through different authorization wrappers. The runner gives a tool a private prefix-scoped datastore and a separately scoped shared accessor; forwarding shared methods through the private wrapper would bypass the shared accessor's bound-name and prefix checks.[^wiring][^shared]

The private wrapper therefore rejects every shared method, including reads, even though those methods are unreachable through its current call sites. This prevents a future wiring change from silently inheriting the unscoped provider's shared-store authority.[^deny]

**What to do:** retain the rejecting shared methods when extending the provider interface. Construct shared access through its dedicated accessor instead of treating private key prefixes as a grant on shared stores. The [native capabilities guide](../../help/native-capabilities.md) describes attachment scope; this concept records the consequence at the provider boundary. See [native isolation](overview-sandbox.md) and [providers](overview-providers.md).

[^deny]: src/providers/datastore/scoped.ts, lines 33-52.

[^wiring]: src/core/runner.ts, lines 1566-1583.

[^shared]: src/core/datastores.ts, lines 119-151.
