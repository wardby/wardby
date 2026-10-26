---
type: overview
title: Durable data and migration boundaries
description: Relational definitions and migrations persist identity, run lifecycle, accounting and integration state.
tags: [database, schema, migrations]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:22:57.805Z }
sources:
  - id: run
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/prisma/schema.prisma#L329-L381
  - id: proxy
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/prisma/schema.prisma#L832-L870
  - id: notify
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/prisma/migrations/20261003030000_viewer_notify_fixes/migration.sql#L1-L47
  - id: package
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/prisma/migrate.config.mjs#L1-L20
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["prisma/**"]
  citations:
    - id: run
      repo: github:wardby/wardby
      path: prisma/schema.prisma
      lines: [329, 381]
      symbol: Run
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:2a0f126a2562191be8c7280801d0ad67b379d3b6b36541f3bdfd212e38b9a619
    - id: proxy
      repo: github:wardby/wardby
      path: prisma/schema.prisma
      lines: [832, 870]
      symbol: CodingProxySession
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:992812db47e0a461bab6f9527a8e0d8bb9708b0452bbeba1d23169293532d338
    - id: notify
      repo: github:wardby/wardby
      path: prisma/migrations/20261003030000_viewer_notify_fixes/migration.sql
      lines: [1, 47]
      symbol: wardby_viewer_notify
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:8c16b83ca66d420cd0ccc5824e496625baa8ebc6b1010a0721e4ac36d6419b93
    - id: package
      repo: github:wardby/wardby
      path: prisma/migrate.config.mjs
      lines: [1, 20]
      symbol: default migration configuration
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:836356e707ee9b510637dbf067182af05fbb54f548dcdb84f9cbcb8eeeaffb48
  confidence: high
---

Prisma defines the durable relational boundary shared by the control plane, executors, gateways and coding proxy. The schema contains agents and attachments, principals and grants, schedules, budgets, runs, accounting ledgers, repository and issue workflow state, authentication state and notification delivery records. Run carries execution ownership, heartbeat and pinned model terms; CodingRun and proxy tables specialize coding execution.[^run][^proxy]

Persistence and consumption proceed through these steps:

1. A deployment or [CLI bootstrap](overview-cli.md) applies migrations using its migration configuration. The packaged configuration resolves the shipped schema and migration directory without importing development-only configuration dependencies.
2. [Core](overview-core.md) and [MCP](overview-mcp.md) write definitions, ownership and run transitions through transactions.
3. [Executors and providers](overview-providers.md), the [native gateway](overview-sandbox.md) and [coding proxy](overview-coding-proxy.md) persist their own lifecycle and accounting records linked to runs.
4. Database triggers publish selected changes to the [viewer](overview-surfaces.md). Notification failures are contained so observation cannot roll back an authoritative write.[^package][^run][^proxy][^notify]

The database owns durable identity, accounting and recovery state; blob contents and worker workspaces live outside it. Runtime database privileges are supplied by [deployment modules](overview-deploy.md).

**What to do:** follow [CLAUDE.md, Database / Prisma](../../CLAUDE.md#database--prisma--strict) for schema work. Review [nullable tool uniqueness](nullable-tool-uniqueness.md) and [viewer notification isolation](viewer-notify-write-isolation.md) for database behavior that the declarative schema alone does not convey.

[^run]: prisma/schema.prisma, lines 329-381.

[^proxy]: prisma/schema.prisma, lines 832-870.

[^notify]: prisma/migrations/20261003030000_viewer_notify_fixes/migration.sql, lines 1-47.

[^package]: prisma/migrate.config.mjs, lines 1-20.
