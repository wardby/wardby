---
id: errors/substrate-provisioning-failed
title: Launching a Substrate run failed (substrate_provisioning_failed)
summary: A coding run on the experimental Substrate launcher failed while its actors, egress policies, run Secret or staged files were being created; the first launch error in the control plane log says why.
audience: operator
tags: [error, substrate, substrate_provisioning_failed, job launcher, coding-agents]
appliesTo: ">=0.9.15"
---

# Launching a Substrate run failed

`substrate_provisioning_failed` (logged as `job_substrate_provisioning_failed`)
means a launch of this run started but did not finish: creating a template or
an actor, applying an egress policy, starting an actor, creating the per-run
Secret, or staging the run's input, tool setup or workspace seed failed. The
launcher removed what it had created and recorded the run as failed, so it is
never launched twice. A run that is picked up again after such a launch (for
example after the control plane restarted) reports this code.

The reason is in the control plane log, at the run's first launch attempt:

- `substrate_call_failed` names the Substrate call that failed
  (`createActor`, `putEgressPolicy`, `resumeActor`, ...) and its error code; see
  [substrate_unavailable](substrate-unavailable.md);
- the launch error itself, such as
  [substrate_seed_too_large](substrate-seed-too-large.md), names the cause.

A run refused only because no worker had room is not this error: it waits and
retries ([substrate_capacity](substrate-capacity.md)). Run it again once the
cause is fixed. See [Run coding agents on Substrate](../job-launcher-substrate.md).
