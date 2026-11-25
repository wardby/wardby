---
id: errors/document-not-agent-linked
title: Document not linked to a coding agent (document_not_agent_linked)
summary: Send to agent needs a repository, a file path and a coding agent.
audience: operator
tags: [error, documents, document_not_agent_linked]
appliesTo: ">=0.10.0"
---

# Document not linked to a coding agent

`document_not_agent_linked` (HTTP 400). Sending comment threads to an agent works only on a document linked to a file in a repository and to a coding agent: `create_document` with `agentId`, `repository` and `path` together. A document without those returns this. A document whose writer is a native agent needs no repository: it returns this when that agent has no `documentTools` setting any more, and for a plan document. The same code is returned by `create_document` when you pass `repository` but not an agent, or the other way round.

A document of a plan set stored in Wardby (`store: "wardby"`) needs no repository or path of its own: it is linked to its plan's planner, and sending it to any other agent returns this.

Link it with `link_document` (the document's owner), or edit the document yourself. A repository the agent cannot choose for this run (not linked, no longer authorized for the agent, or refused by its policy) also returns this, and so does a design linked without a `baseRef`.

See [Documents](../documents.md).
