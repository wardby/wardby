---
id: errors/review-route-target-no-documents
title: Agent cannot read documents (review_route_target_no_documents)
summary: A router tried to start a native agent that has no documentTools for work routed from a review, so the start was refused.
audience: operator
tags: [error, review router, review_route_target_no_documents, documentTools, delegation]
appliesTo: ">=0.11.0"
---

# Agent cannot read documents

`review_route_target_no_documents` means a router tried to start a native agent for work routed from a review, but that agent has no `documentTools`, so it could not read the documents the work is about. Nothing was started. Work from `request_work` carries no documents, so it is not refused this way.

Set `documentTools` on the agent with `update_agent`, or have the router start another agent. Coding agents are not affected: they get the documents as files.

See [Route work from reviews](../route-work-from-reviews.md).
