---
id: errors/plan-too-large
title: The plan is too large (plan_too_large)
summary: A planner's plan folder, or the instructions given to a planner, went over a plan limit; nothing was published.
audience: operator
tags: [error, coding-agents, plans, plan_too_large, planDocument]
appliesTo: ">=0.10.0"
---

# The plan is too large

`plan_too_large` means a plan went over a limit. Nothing was published and no
document was changed. It is raised for a planner's output and also before a run,
when the input to a planner (such as an approved plan or a planner note) does not
fit the coding task.

The limits:

- 200 files, 1 MiB per file and 8 MiB in all in the plan folder;
- 20 documents per plan;
- 60,000 characters per Markdown document;
- 1 MiB for one design's files in all;
- when building from an approved plan, 32 KiB for the ticket being built (its
  `### Ticket <t>:` section of `plan.md`). A larger plan is still built: the
  builder reads it from `/tmp/wardby-plan`.

A scheduled planner commits a refused run; any other caller is refused with no
run.

## What to do

- Split a long document into several (up to 20), and drop generated or binary
  files from the plan folder.
- Shorten the planner note or the issue text, and send the request again.
- Keep large designs to fewer or smaller boards.
- For a build refused on a ticket, split that ticket into smaller tickets.

See [Plan documents](../plan-documents.md).
