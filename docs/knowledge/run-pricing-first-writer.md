---
type: invariant
title: Pricing races must use the persisted winner
description: Concurrent native attempts must reuse the catalog terms that won the conditional pricing write.
tags: [pricing, concurrency, models]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:24:27.356Z }
sources:
  - id: pin
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/core/run-pricing.ts#L45-L69
  - id: adapter
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/providers/llm/routing.ts#L82-L87
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/core/run-pricing.ts", "src/providers/llm/routing.ts", "src/core/runner.ts"]
  citations:
    - id: pin
      repo: github:wardby/wardby
      path: src/core/run-pricing.ts
      lines: [45, 69]
      symbol: pinNativeRunPricing
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:ceb81fd7d2aa2c29b19b333e93f3838a002aa45498f2b90f6d1aca1f6aed0385
    - id: adapter
      repo: github:wardby/wardby
      path: src/providers/llm/routing.ts
      lines: [82, 87]
      symbol: RoutingLlmProvider.forRun
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:5511b7ed50630042519c07b0ef699eaa44cf10951933aeb1db69434f5160f278
  confidence: high
---

[Model guidance](../models.md) already describes retaining a run's original catalog terms. The additional concurrency consequence is that two attempts can resolve different live entries before either pins the run. Pricing is written only while pricingVersion is null; an attempt that loses that write reads the stored terms back rather than using its local resolution.[^pin]

The router can bind an adapter to the stored entry, so request shaping and prices stay coupled to the same terms.[^adapter]

**What to do:** preserve both the conditional write and read-back when refactoring load or resume paths. An unconditional update can reprice an active run; ignoring the winning row can make an attempt's provider behavior disagree with durable accounting. See [core execution](overview-core.md).

[^pin]: src/core/run-pricing.ts, lines 45-69.

[^adapter]: src/providers/llm/routing.ts, lines 82-87.
