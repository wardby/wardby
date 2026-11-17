---
id: errors/plan-files-unsupported
title: This deployment cannot return plan files (plan_files_unsupported)
summary: The deployment's job launcher does not return a planner's plan files, so nothing was stored or published.
audience: operator
tags: [error, coding-agents, plans, plan_files_unsupported, job-launcher]
appliesTo: ">=0.10.0"
---

# This deployment cannot return plan files

`plan_files_unsupported` means the job launcher your deployment uses does not
return a planner run's plan files, so nothing was stored or published. The
launchers Wardby ships all return them; this points to a custom or older job
launcher.

## What to do

- Run a launcher from the current release, or add plan file support to your
  custom launcher.
- Or turn the setting off with `planDocument: null`.

See [Plan documents](../plan-documents.md).
