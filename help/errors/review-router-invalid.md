---
id: errors/review-router-invalid
title: Review router setting invalid (review_router_invalid)
summary: A router or reviewRouter setting was refused, or a router could not be started because it is no longer a router.
audience: operator
tags: [error, review router, router, review_router_invalid, reviewRouter, request_work]
appliesTo: ">=0.11.0"
---

# Review router setting invalid

`review_router_invalid` means a router setting cannot be used. The message names the cause:

- "a router needs a description of the work it takes": set `description` on the agent.
- "a router needs documentTools to read documents": set `documentTools` on the agent.
- "only native agents can be routers": `router: true` is for native agents, not coding agents.
- "reviewRouter must name a router agent you can run": `reviewRouter` must be another agent with `router: true` that you can run.
- "router must name a router agent you can run" (from `request_work`): pick one of the routers it listed.
- "this document is in a set; its set's router applies" (from `link_document` `routerAgentId`): a document in a plan or option set routes through its set, so it takes no router of its own.

In a document's **Routing** section, "Not routed: the router is no longer a router" means the agent stopped being a router before the action was routed. Set `router: true` again or change the router with `link_document` and `routerAgentId`.

See [Route work from reviews](../route-work-from-reviews.md).
