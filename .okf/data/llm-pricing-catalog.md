---
type: Rulebook
title: LLM pricing catalog
description: Every catalog model must carry exact published cache read and write rates; never derive them with multipliers.
tags: [pricing, models, strict]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: claude-md
    resource: /CLAUDE.md
  - id: catalog
    resource: /src/providers/llm/catalog-shipped.ts
  - id: pricing-core
    resource: /src/providers/llm/pricing-core.ts
---

# Rule

The pricing rules live in `CLAUDE.md` § "LLM pricing tables — STRICT"; read
them there. In short: every catalog model carries its own published cache
read and write rates as literals, never a multiplier, sourced from the
provider's pricing page.

# Where

Catalog code: `src/providers/llm/catalog*.ts`, with `computeCost` in
`src/providers/llm/pricing-core.ts`; admin tools `list_models`, `get_model`,
`set_model`, `disable_model`, `reset_model`. Cache rates matter to the
[budget guardrail](/architecture/budget-guardrail.md).
