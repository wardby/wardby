---
id: errors/substrate-seed-too-large
title: The workspace is too large to seed a Substrate run (substrate_seed_too_large)
summary: A coding run on the experimental Substrate launcher failed at launch because its prepared workspace and its extra repositories, as tars together, are larger than the run's disk limit (the agent's codingProfile.workspaceDiskMb, else CODING_DISK_MB).
audience: operator
tags: [error, substrate, substrate_seed_too_large, coding-agents, workspace, workspaceDiskMb, CODING_DISK_MB]
appliesTo: ">=0.9.15"
---

# The workspace is too large to seed a Substrate run

`substrate_seed_too_large` means the run's prepared workspace (the checked-out
repository, with its `.git` for a `gitHistory` run) and its extra repositories
are larger, as tars together, than the run's disk limit. Each extra repository
counts toward the same limit. The tool actor would have no room for it, so the run fails
at launch and nothing is left behind.

The limit is the agent's `codingProfile.workspaceDiskMb` when it has one, else
`CODING_DISK_MB` (2048 MiB by default); `CODING_MAX_DISK_MB` caps what an agent
may ask for. Raise the agent's `workspaceDiskMb` with `update_agent`, or trim
the repository the run starts from. See
[Workspace disk over the limit](coding-workspace-disk-exceeds-limit.md) and
[Run coding agents on Substrate](../job-launcher-substrate.md).
