---
id: errors/document-agent-unavailable
title: Document's agent unavailable (document_agent_unavailable)
summary: The owner no longer has execute access to the linked coding agent.
audience: operator
tags: [error, documents, document_agent_unavailable]
appliesTo: ">=0.10.0"
---

# Document's agent unavailable

`document_agent_unavailable` (HTTP 403). The link between a document and a coding agent is good only while the document's owner still has `execute` on that agent. If the agent was unshared or its owner changed, sending threads is refused.

The agent's owner can grant the document owner `execute` again (`grant_access`), or the document owner can create a new document linked to an agent they can run.

See [Documents](../documents.md).
