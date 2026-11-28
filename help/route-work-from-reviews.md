---
id: route-work-from-reviews
title: Route work from reviews (review routers)
summary: A router agent decides who works next whenever someone acts on a document or plan in review (submit, approve, choose an option, request changes, reject, reopen, archive, change reviewers), and request_work sends work described in plain words to a router. Set router on an agent, link work to it, and set limits with maxStartsPerDecision.
audience: operator
tags:
  [
    review router,
    router,
    route work,
    request_work,
    review actions,
    revised,
    onApproved,
    choose option agent,
    which agent,
    maxStartsPerDecision,
  ]
appliesTo: ">=0.11.0"
---

# Route work from reviews (review routers)

A **router** is a native agent that decides who works next. When someone acts on a document, a design or a plan set in review, Wardby starts the router with a short description of what happened. The router reads the documents and starts the agents that should do the next piece of work, each with its own task. Nothing about the route is wired in advance: no list per event and no table of options. Wardby keeps the limits (which agents, budgets, how many starts) and shows every decision on the document's **Review** tab.

With no router in play, review actions start nothing, as before.

## Make an agent a router

Set these with `create_agent` or `update_agent` (all owner-only):

| Setting                        | Meaning                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router: true`                 | The agent routes work. Native agents only. It needs a `description` (people and `request_work` find it by that text) and `documentTools` (it reads documents). |
| `description`                  | What work this router takes. Anyone who can edit the agent may change it.                                                                                      |
| `reviewRouter`                 | On a writer or planner: the router that gets reviews of its documents when no router started the work. It must be a router you can run.                        |
| `maxStartsPerDecision` (1-100) | The most agents one person decision may start across all the runs it sets off. Default 20.                                                                     |

Attach the agents the router may start with `attach_subagent`; it starts them with its `delegate_to_*` tools, waits for their results and can start more when a result shows the work needs someone else. It can start only its attached agents. `maxDelegationsPerRun` and `parallelDelegations` apply to it as to any lead.

An invalid setting is refused with [`review_router_invalid`](errors/review-router-invalid.md).

## Which router gets a review action

1. The router whose work produced the document. Wardby finds it when the document is created, by looking up the run tree from the run that created it (router, then lead, then writer, at any depth).
2. Otherwise the writer's (or planner's) `reviewRouter`, read when the action happens.
3. Otherwise nothing starts.

The router is checked again when each action happens: it must still be `router: true`, a router the document's owner set must still be one the owner can run, and a writer's `reviewRouter` one the writer's owner can run (a router recorded from the run tree needs nothing more). A router that fails the check is skipped. The document's owner can change or clear the router with `link_document` and `routerAgentId` (a router the owner can run, or `null`); a document in a set is refused, since its set's router applies. `trigger_agent` on a writer with a `reviewRouter` answers `reviewsGoTo` while it is `router: true` and you can run it, and `list_agent_links` shows a `routes_reviews` link from the writer to its router.

## Which actions route

Every review action: submitted, revised (the first version published after changes were requested, by a writer, a person or a republished plan), approved (and force approved), option chosen, changes requested, rejected, reopened, archived, unarchived and reviewers changed. The router decides when nothing is needed.

Documents in a set (a plan set, or an option set made with `doc_create` `set` and `option`) route as one piece of work: the set entering review once per round (its first submit or revision; a later member's in the same round routes nothing, and a published plan's documents enter review together; a round ends when a member gets changes requested, is rejected, reopened, archived or unarchived, not on an approval), the approval that completes the set, a choice (once, not once per document), and each other action once. A plan approval routes only for the action that completed it. Each action routes once: a repeated click or a retried hook starts nothing more.

A person can add a `note` to `submit_for_review`, an approval, a choice or a request for changes. It reaches the router labelled as that person's.

## What the router is told

A fixed text: the action, the documents by id (and option labels), who acted, the note, and "The builder for this plan was already started." when a plan's `onApproved` is `build` (the builder starts exactly as before; the router does not start it again). The router and the agents it starts can read those documents by id with `doc_get`; they do not appear in `doc_list`.

A native agent started this way needs `documentTools` when the router was given documents, otherwise the start is refused with [`review_route_target_no_documents`](errors/review-route-target-no-documents.md) (work from `request_work` carries no documents, so any attached agent may take it). A coding agent gets the documents as files in `/tmp/wardby-plan` (a planner gets none; documents too large for a coding run refuse with [`plan_too_large`](errors/plan-too-large.md)). An agent owned by someone else runs its own instructions; the router's task text is dropped.

## Limits

- `maxStartsPerDecision` counts start attempts for one person decision, across every router run that agents' own actions set off. Each such router run is itself one start, and so is one set off by a plan that a planner in the work publishes. A start refused later (for example for budget) still counts. Past it, a start is refused with [`review_route_limit`](errors/review-route-limit.md); the person's next action starts a new count.
- `maxDelegationsPerRun` still limits each run.
- The router run's budget covers the agents it starts.
- A router starts only its attached agents, and only those its owner can run.

## Ask for work in plain words

`request_work` takes a `request`. Without `router`, it ranks up to 5 routers you can run by their descriptions and starts nothing (no match: it lists your routers, at most 20). With `router`, it starts that router with your request as its task. `router: true` means people who can run the agent may send it requests. Assistants are told to start the router when one clearly fits and to ask you when several do. Documents the work produces route back to that router.

## Link other work to a router

How work reaches an agent already names an agent, so a router needs no new feature: link a Jira project (`link_issue_project`), a repository (`link_repository`), a schedule or a webhook to the router, or start it with `trigger_agent` or `request_work`.

## See what happened

The document's **Review** tab has a **Routing** section: the router (or "No router: review actions start nothing."), each action's outcome, the agents started (the 10 newest per action) and the first line of their task with secret values removed, and a plain sentence when a start was refused. On the tab, the task text is shown only to the document's owner and people who can run that router; the person who started an action can still open its runs with `get_run`.

## A starting system prompt for a router

```text
You route work for the <team> team. When you are started, you are told what a person (or an agent) just did on a
document or set, and you can read those documents. Decide who should do the next piece of work and what exactly
they should do, then start them with your delegate_to_* tools, one task each. Wait for their results; if a result
shows the work needs someone else, start them. When an agent only submitted work for review, wait for the person's
decision: start nothing. When the last step's work is approved, the work is done: start nothing. If nothing is
needed, say so and stop. Never start more agents than the work needs.
```

## Related

[Plan documents](plan-documents.md) · [Review and approve documents](document-review.md) · [Documents](documents.md) · [See how your agents work together](agent-flows.md) · [Connect a client to Wardby](mcp.md)
