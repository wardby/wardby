---
type: Rulebook
title: Database and Prisma migrations
description: PostgreSQL + Prisma 7; migrations are the source of truth and schema.prisma must never drift from them.
tags: [database, prisma, migrations, strict]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: claude-md
    resource: /CLAUDE.md
  - id: schema
    resource: /prisma/schema.prisma
---

# Hard rules

* Never `prisma db push`.
* Never edit an already-applied migration; fix it with a new additive one.
* Migrations are hand-written from the spec (see
  [clean-room charter](/decisions/clean-room.md)) under
  `prisma/migrations/<YYYYMMDD######>_<name>/migration.sql`.
* A schema change ships with its migration in the same change, including
  indexes and constraints (`CREATE INDEX` needs a matching `@@index`).
* Prefer additive changes.[^claude-md]

# Drift check (after any schema or migration change)

Replay the migrations onto an empty shadow database and diff against
`schema.prisma` with `prisma migrate diff --from-migrations ... --to-schema
... --exit-code`, using `SHADOW_DATABASE_URL` (Prisma 7 has no shadow flag).
Clean output is `-- This is an empty migration.`. Also run
`npx prisma validate`. Production uses `prisma migrate deploy`, never
`migrate dev`.

# Model families

The schema[^schema] covers agents and sub-agents, tools, budget groups, runs,
coding runs and proxy ledgers, package-registry allowances, principals and
grants, secrets, webhooks, OAuth and auth sessions, issue-tracker and
review-host state, and the model catalog (see
[LLM pricing catalog](/data/llm-pricing-catalog.md)).

[^claude-md]: Project CLAUDE.md
[^schema]: prisma/schema.prisma
