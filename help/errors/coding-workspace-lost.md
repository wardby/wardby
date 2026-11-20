---
id: errors/coding-workspace-lost
title: Coding workspace lost
summary: A coding run finished on a control-plane copy that had no git checkout of it and no recorded base to rebuild one from, so its changes were not pushed.
audience: operator
tags: [error, coding-agents, workspace, availability, rollout, adoption, coding_workspace_lost]
appliesTo: ">=0.10.2"
---

# Coding workspace lost

`coding_workspace_lost` (logged as the reason; on the run record it appears as
`coding_failure_workspace:<id>`) means a control-plane copy had to push a coding
run's changes but had no git checkout for it and nothing to rebuild one from.

A run's checkout lives on the disk of the copy that launched it. When another
copy finishes the run (after a deploy or a lost pod) it rebuilds the checkout at
the base commit recorded when the run launched, then pushes, so a rollout during
a run does not normally lose anything. This error remains for a run **launched
before wardby recorded its base commit** (a run in flight across the upgrade that
added it): there is nothing to pin a re-clone to, and cloning the branch's
current tip could push onto a different base.

Nothing is pushed and the run's pull request is unchanged.

## What to do

Run the agent again. If it happens for runs launched after an upgrade, check that
the control plane's database migrations have been applied (`prisma migrate
deploy`); the recorded base lives on the run row.

Related: [Coding checkout could not be rebuilt at its recorded base](vcs-rebuild-base-unavailable.md),
[Availability and PodDisruptionBudgets](../availability.md).
