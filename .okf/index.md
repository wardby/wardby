---
okf_version: '0.2'
---

# Wardby

* [Wardby](overview.md) - self-hosted control plane that governs autonomous agents

# Architecture

* [Provider seams](architecture/provider-seams.md) - core depends only on provider interfaces
* [Budget guardrail](architecture/budget-guardrail.md) - hard per-run spend limit enforced before provider calls
* [Runner and engine](architecture/runner-and-engine.md) - how runs are created and executed
* [Tool sandbox](architecture/tool-sandbox.md) - QuickJS isolation for agent tools
* [Coding workers](architecture/coding-workers.md) - isolated Codex / Claude Code execution
* [Coding proxy](architecture/coding-proxy.md) - credential injection and metering
* [MCP server](architecture/mcp-server.md) - management surface and auth
* [Repository knowledge bundles](architecture/knowledge-bundles.md) - the product's per-repo knowledge feature

# Data

* [Database and Prisma migrations](data/database-and-migrations.md) - migration and drift rules
* [LLM pricing catalog](data/llm-pricing-catalog.md) - exact cache-rate rules

# Decisions

* [Clean-room reimplementation](decisions/clean-room.md) - allowed and prohibited inputs

# Playbooks

* [Docs and help check for features](playbooks/docs-and-help-check.md) - docs, help and deploy hygiene
