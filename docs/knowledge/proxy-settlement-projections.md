---
type: invariant
title: Proxy usage projections must not govern settlement
description: Run totals are rebuilt from settled requests while per-model reporting failures are isolated by a savepoint.
tags: [proxy, budgets, transactions]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-16T18:34:00.557Z }
sources:
  - id: settle
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/providers/coding-proxy/prisma-ledger.ts#L286-L331
  - id: totals
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/providers/coding-proxy/prisma-ledger.ts#L334-L387
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/providers/coding-proxy/prisma-ledger.ts", "deploy/gke/database-grants.sql"]
  citations:
    - id: settle
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/prisma-ledger.ts
      lines: [286, 331]
      symbol: complete
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:9a2daa06b239a603d9976e93ce6ace674192399177e3f3132152bebe2b189b9d
    - id: totals
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/prisma-ledger.ts
      lines: [334, 387]
      symbol: recomputeRunTotals
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:f43cf2ec538c24cd65f4a454e6940007226750e06b3cb3ee6668f6ffe2b48a06
  confidence: high
---

Completion locks the session before changing the request. Totals are assigned from completed requests and estimated uncertain requests, rather than incremented; RunModelUsage is also rebuilt, but its write runs inside a savepoint and rolls back independently on failure.[^settle][^totals]

**Why:** settling an uncertain request can replace an estimate with actual usage. Incrementing would count both, while allowing a reporting-table failure to abort the transaction would discard the authoritative settlement. Keep ledger and Run writes authoritative and the per-model projection best effort.

[^settle]: src/providers/coding-proxy/prisma-ledger.ts, lines 286-331.

[^totals]: src/providers/coding-proxy/prisma-ledger.ts, lines 334-387.
