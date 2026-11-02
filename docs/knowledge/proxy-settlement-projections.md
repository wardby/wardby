---
type: invariant
title: Proxy usage projections must not govern settlement
description: Run totals are rebuilt from settled requests while per-model reporting failures are isolated by a savepoint.
tags: [proxy, budgets, transactions]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-16T18:34:00.557Z }
sources:
  - id: settle
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/providers/coding-proxy/prisma-ledger.ts#L285-L332
  - id: totals
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/providers/coding-proxy/prisma-ledger.ts#L334-L387
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/providers/coding-proxy/prisma-ledger.ts", "deploy/gke/database-grants.sql"]
  citations:
    - id: settle
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/prisma-ledger.ts
      lines: [285, 332]
      symbol: complete
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:b21773be3de0326c3ddec34463a9177d3b36cb3063bbba9406493a258a7769f3
    - id: totals
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/prisma-ledger.ts
      lines: [334, 387]
      symbol: recomputeRunTotals
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:f43cf2ec538c24cd65f4a454e6940007226750e06b3cb3ee6668f6ffe2b48a06
  confidence: high
---

Completion locks the session before changing the request. Totals are assigned from completed requests and estimated uncertain requests, rather than incremented; RunModelUsage is also rebuilt, but its write runs inside a savepoint and rolls back independently on failure.[^settle][^totals]

**Why:** settling an uncertain request can replace an estimate with actual usage. Incrementing would count both, while allowing a reporting-table failure to abort the transaction would discard the authoritative settlement. Keep ledger and Run writes authoritative and the per-model projection best effort.

[^settle]: src/providers/coding-proxy/prisma-ledger.ts, lines 285-332.

[^totals]: src/providers/coding-proxy/prisma-ledger.ts, lines 334-387.
