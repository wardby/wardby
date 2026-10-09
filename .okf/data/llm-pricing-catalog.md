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

# Rules

* Each shipped model entry (`catalog-shipped.ts`) and every `set_model`
  call must set `cachedInputPerMTok` and `cacheWritePerMTok`.[^claude-md]
* **No multipliers.** Hardcode each model's own published rate as a literal,
  even where a ratio currently holds, because ratios drift per model and tier.
* Source rates only from the provider's own pricing page. If you can't find
  one, stop and ask; AI search summaries have fabricated pricing pages.
* Bump `SHIPPED_CATALOG_VERSION` when any shipped value changes.

# Why

`computeCost` falls back to the full input rate for missing cache
rates,[^pricing-core] which overestimates and hides real prompt-cache savings
from the [budget guardrail](/architecture/budget-guardrail.md).

Catalog code: `src/providers/llm/catalog*.ts`; admin tools `list_models`,
`get_model`, `set_model`, `disable_model`, `reset_model`.

[^claude-md]: Project CLAUDE.md
[^pricing-core]: src/providers/llm/pricing-core.ts
