---
id: errors/document-not-agent-linked
title: Document not linked to a coding agent (document_not_agent_linked)
summary: Send to agent needs a repository, a file path and a coding agent.
audience: operator
tags: [error, documents, document_not_agent_linked]
appliesTo: ">=0.10.0"
---

# Document not linked to a coding agent

`document_not_agent_linked` (HTTP 400). Sending comment threads to an agent works only on a document linked to a file in a repository and to a coding agent: `create_document` with `agentId`, `repository` and `path` together. A document without those, or linked to a native agent, returns this. The same code is returned by `create_document` when you pass `repository` but not an agent, or the other way round.

Create a new linked document (the link cannot be added later), or edit the document yourself. A repository the agent cannot choose for this run (not linked, or refused by its policy) also returns this.

See [Documents](../documents.md).
