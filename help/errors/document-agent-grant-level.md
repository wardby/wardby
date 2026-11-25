---
id: errors/document-agent-grant-level
title: Agent grant level too high (document_agent_grant_level)
summary: An agent can be granted read or comment on a document, not write.
audience: operator
tags: [error, documents, native-agents, grant_access, document_agent_grant_level]
appliesTo: ">=0.10.0"
---

# Agent grant level too high

`document_agent_grant_level` (HTTP 400). `grant_access` with an agent grantee (`{"agentId": "<id>"}`) on a document accepts `read` or `comment` only.

To make an agent the document's writer, link it with `link_document` and `agentId` alone (the agent must be native, have `documentTools` with `access: "write"`, and you need `execute` on it). Agent grantees apply to documents only, and you must be able to read the agent.

See [Documents from native agents](../native-agent-documents.md).
