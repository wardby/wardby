---
id: errors/review-route-limit
title: Review route limit reached (review_route_limit)
summary: One person decision already started the most agents its router allows (maxStartsPerDecision), so a further start was refused.
audience: operator
tags: [error, review router, review_route_limit, maxStartsPerDecision, delegation]
appliesTo: ">=0.11.0"
---

# Review route limit reached

`review_route_limit` means one decision has already started the most agents its router allows. The count covers start attempts across every router run that agents' own actions set off from that person's action, so agents that set each other off cannot run forever. A start refused for another reason, such as budget, still counts.

The next review action by a person starts a new count. To allow more starts, raise the router's `maxStartsPerDecision` (1 to 100, default 20) with `update_agent`; it is separate from `maxDelegationsPerRun`, which still limits each run.

In the document's **Routing** section it reads "Stopped: this decision started the most agents its router allows."

See [Route work from reviews](../route-work-from-reviews.md).
