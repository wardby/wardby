---
type: invariant
title: Proxy usage projections must not govern settlement
description: Run totals are rebuilt from settled requests while per-model reporting failures are isolated by a savepoint.
tags: [proxy, budgets, transactions]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-16T18:34:00.557Z }
sources:
  - id: settle
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/providers/coding-proxy/prisma-ledger.ts#L274-L309
  - id: totals
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/providers/coding-proxy/prisma-ledger.ts#L316-L369
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/providers/coding-proxy/prisma-ledger.ts", "deploy/gke/database-grants.sql"]
  citations:
    - id: settle
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/prisma-ledger.ts
      lines: [274, 309]
      symbol: complete
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:1e1afa8d2b3ac5786e85308f314d76d5cb955b81a05320bad70d37ab398026d1
    - id: totals
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/prisma-ledger.ts
      lines: [316, 369]
      symbol: recomputeRunTotals
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:f43cf2ec538c24cd65f4a454e6940007226750e06b3cb3ee6668f6ffe2b48a06
  confidence: high
---

Completion locks the session before changing the request. Totals are assigned from completed requests and estimated uncertain requests, rather than incremented; RunModelUsage is also rebuilt, but its write runs inside a savepoint and rolls back independently on failure.[^settle][^totals]

**Why:** settling an uncertain request can replace an estimate with actual usage. Incrementing would count both, while allowing a reporting-table failure to abort the transaction would discard the authoritative settlement. Keep ledger and Run writes authoritative and the per-model projection best effort.

[^settle]: src/providers/coding-proxy/prisma-ledger.ts, lines 274-309.

[^totals]: src/providers/coding-proxy/prisma-ledger.ts, lines 316-369.
