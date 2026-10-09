---
id: errors/native-sandbox-requires-catalog
title: Sandbox run has no model catalog entry
summary: A sandbox-mode run could not start because no model catalog entry was recorded for it.
audience: operator
tags: [error, native-agents, sandbox, model-catalog, native_sandbox_requires_catalog]
appliesTo: ">=0.5.4"
---

# Sandbox run has no model catalog entry

`native_sandbox_requires_catalog` means a sandbox-mode run reached its worker
launch without a model catalog entry. The worker prices every model call and
enforces the run's budget from that entry, so Wardby fails the run before
starting a worker or spending anything.

Every run records its model's catalog entry when it first starts. A model
that is unknown, disabled, or has no configured provider fails earlier with
its own model error, not this one. This error only appears when the process
executing the run does not use Wardby's catalog-backed model router, for
example a modified build or an embedding that supplies its own LLM provider.

1. Run sandbox-mode agents on a standard `wardby serve` (or `wardby
scheduler` / `wardby mcp`) process, which always uses the catalog.
2. If you supply your own LLM provider, route it through the model catalog,
   or keep the agent on `control-plane` with `update_agent` or
   `wardby agent mode <name> control-plane`.
3. Trigger the run again. A failed run is not retried on its own.

See [Run native agents in a sandbox](../native-sandbox.md) and
[Models and the model catalog](../models.md).
