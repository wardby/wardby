---
id: errors/document-agent-unavailable
title: Document's agent unavailable (document_agent_unavailable)
summary: The document owner may no longer run the linked coding agent or give it task text.
audience: operator
tags: [error, documents, document_agent_unavailable]
appliesTo: ">=0.10.0"
---

# Document's agent unavailable

`document_agent_unavailable` (HTTP 403). Sending threads hands the coding agent task text, so the same rule as `trigger_agent` applies: only the agent's owner may, unless the owner set `codingProfile.allowWebhookTaskOverride`, and then anyone with `execute` may. For a native writer (see [Documents from native agents](../native-agent-documents.md)) it also means the agent's `documentTools` is no longer `write`, or the document's owner lost `execute` on it; `link_document` refuses a plan document with it. `create_document` refuses the link with this code, and every send checks it again against the document's owner. If the agent was unshared, its owner changed, or the owner turned the opt-in off, sending is refused.

The agent's owner can grant `execute` and set `allowWebhookTaskOverride` (`update_agent`), or the document owner can create a new document linked to an agent they own.

See [Documents](../documents.md).
