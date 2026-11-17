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
was started, and the refusal lists the documents still waiting by their path in
the plan. When the build was asked for from an issue, wardby replies on that
issue with the same list.

Each document is approved on its own page (see
[Document review](../document-review.md)). A document removed from the plan does
not count. Once all are approved, ask again: the builder starts with the approved
versions.

The same code is used when the builder cannot be checked safely, and then the
refusal says why instead of listing documents:

- `secret values unavailable`: wardby could not read the builder's attached
  secrets, so it cannot remove their values from the plan before the builder
  sees it. The plan is never sent unchecked. Make sure the server has its secret
  key (`SECRET_APP_KEY`) and that the builder's secrets can be read, then ask
  again.
- `the builder has no owner`: the builder has no owner whose access to the
  planner can be checked. Give the agent an owner.

A follow-up on a build that already started (a fix round, or a mention on its
pull request) uses the versions that build was given, so reopening a document
does not stop it.

See [Plan documents](../plan-documents.md).
