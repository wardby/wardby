---
type: System
title: Wardby
description: Self-hosted control plane that governs autonomous agents - whether they run, what they access, what they spend, and what outcome they produce.
resource: https://github.com/wardby/wardby
tags: [overview, control-plane]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: readme
    resource: /README.md
    title: Project README
---

# What it is

Wardby is a self-hosted control plane around LLM agents.[^readme] Each
Wardby-managed agent has one durable operational identity: owner, purpose,
access, schedule, spend limit and produced outcome. It is MCP-first: agents,
tools, schedules, budget groups, secrets, datastores, webhooks and runs are
managed through MCP tools (see [MCP server](/architecture/mcp-server.md)).

# Main parts

| Area | Concept |
|------|---------|
| Spend enforcement | [Budget guardrail](/architecture/budget-guardrail.md) |
| Run execution | [Runner and engine](/architecture/runner-and-engine.md) |
| Swappable adapters | [Provider seams](/architecture/provider-seams.md) |
| Agent-authored tools | [Tool sandbox](/architecture/tool-sandbox.md) |
| Coding agents | [Coding workers](/architecture/coding-workers.md), [Coding proxy](/architecture/coding-proxy.md) |
| Repo knowledge | [Knowledge bundles](/architecture/knowledge-bundles.md) |
| Persistence | [Database and migrations](/data/database-and-migrations.md) |
| Model prices | [LLM pricing catalog](/data/llm-pricing-catalog.md) |
| Provenance | [Clean-room charter](/decisions/clean-room.md) |

# Repository map

* `src/core/` - agents, runner, scheduler, triggers, budgets
* `src/mcp/` - MCP transports, auth, management tools
* `src/providers/` - provider seams and adapters
* `src/coding-worker/`, `src/claude-coding-worker/` - isolated Codex / Claude Code execution
* `src/sandbox/` - QuickJS tool sandbox
* `apps/viewer/` - the run viewer app
* `deploy/` - local, production, observability and cloud (GCP, AWS, GKE) deployment
* `prisma/` - schema and migrations; `docs/` and `help/` - operator docs

[^readme]: Project README
