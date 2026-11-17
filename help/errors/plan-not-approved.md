---
id: errors/plan-not-approved
title: The plan is not approved yet (plan_not_approved)
summary: A coding agent with buildFromPlan was asked to build from a plan set in which some documents are not approved; no run was started.
audience: operator
tags: [error, coding-agents, plans, plan_not_approved, buildFromPlan]
appliesTo: ">=0.10.0"
---

# The plan is not approved yet

`plan_not_approved` means a coding agent with `buildFromPlan` was asked to build
for an issue whose plan set still has documents that are not approved. No run
was started, and the refusal lists the documents still waiting.

Each document is approved on its own page (see
[Document review](../document-review.md)). A document removed from the plan does
not count. Once all are approved, ask again: the builder starts with the approved
versions.

See [Plan documents](../plan-documents.md).
