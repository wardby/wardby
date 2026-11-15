---
id: errors/substrate-template-missing
title: A Substrate run's actor template is gone (substrate_template_missing)
summary: A coding run on the experimental Substrate launcher could not create or start an actor because its actor template no longer exists in Substrate, and creating it again did not help.
audience: operator
tags: [error, substrate, substrate_template_missing, actor template, warm rounds, job launcher]
appliesTo: ">=0.9.15"
---

# A Substrate run's actor template is gone

`substrate_template_missing` is the error code of a Substrate call (in the
control plane's `substrate_call_failed` log line, or a launch's failure reason)
when Substrate answers that the actor's template does not exist: creating an
actor from a deleted or unknown template, or starting a kept actor whose
template was deleted.

Wardby recovers from it on its own in the usual cases:

- **A launch whose template was removed** just before it creates its actors
  creates the template again and retries once. Only a second refusal fails the
  run (as [substrate_provisioning_failed](substrate-provisioning-failed.md)).
- **A warm round whose kept actors' template was removed** cannot resume them.
  Wardby removes the kept actors and starts the round fresh, with the step line
  "the previous round's sandbox was no longer available". The run does not
  fail.

If runs keep failing with it, something outside Wardby is deleting the
templates in the atespace (another tool, or a cleanup job). Wardby removes only
templates no run has used for `SUBSTRATE_TEMPLATE_TTL_SEC`, never less than 27
hours. See
[Templates and snapshots](../../docs/substrate-backend.md#templates-and-snapshots)
and [Run coding agents on Substrate](../job-launcher-substrate.md).
