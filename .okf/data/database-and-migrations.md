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

# Rules

The migration rules and the drift check live in `CLAUDE.md` § "Database /
Prisma — STRICT"; read them there before any schema or migration change.
Migrations are hand-written (see [clean-room charter](/decisions/clean-room.md)).

# Model families

The schema[^schema] covers agents and sub-agents, tools, budget groups, runs,
coding runs and proxy ledgers, native sandbox gateway sessions and warm
workers, package-registry allowances, principals and grants, secrets,
webhooks, OAuth and auth sessions, issue-tracker and review-host state, and
the model catalog (see [LLM pricing catalog](/data/llm-pricing-catalog.md)).

[^schema]: prisma/schema.prisma
