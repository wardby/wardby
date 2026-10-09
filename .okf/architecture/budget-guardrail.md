---
type: Architecture Pattern
title: Budget guardrail
description: Every model request must fit a hard per-run USD limit before it reaches the provider; the math is pure functions.
tags: [budget, cost, differentiator]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: budget-ts
    resource: /src/core/budget.ts
  - id: pricing-core
    resource: /src/providers/llm/pricing-core.ts
---

# Behavior

Budgets are enforced **before** spend. The runner and engine combine pure
functions in `src/core/budget.ts` with a live `LlmProvider`[^budget-ts] to do:

1. a pre-flight refuse (does the estimated input cost fit the budget?),
2. a cumulative pre-turn gate,
3. a mid-stream cutoff,
4. a wind-down.

All of these live inside the engine; there is exactly one place that reasons
about cost (see [runner and engine](/architecture/runner-and-engine.md)).

# Pitfalls

* Input estimates must include the serialized tool schemas whenever the real
  call sends them, since providers bill them as input tokens. Omitting them
  once let a run through whose real input cost already exceeded budget.
* `cacheRatio` defaults to 0, i.e. every input token priced fresh.
* Shared limits come from budget groups (`src/core/budget-groups.ts`).
* Opaque coding runs are capped at the boundary by the
  [coding proxy](/architecture/coding-proxy.md) and reconciled afterward.

# Pricing

Cost comes from `computeCost`.[^pricing-core] Missing cache rates fall back to
the full input rate, which overestimates; see
[LLM pricing catalog](/data/llm-pricing-catalog.md).

[^budget-ts]: src/core/budget.ts
[^pricing-core]: src/providers/llm/pricing-core.ts
