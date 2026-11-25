---
id: errors/document-tools-invalid
title: Document tools setting invalid (document_tools_invalid)
summary: update_agent or create_agent refused documentTools because the agent is not native, a reviewer cannot read the agent, or a plan is not a planner you can run.
audience: operator
tags: [error, documents, native-agents, documentTools, document_tools_invalid]
appliesTo: ">=0.10.2"
---

# Document tools setting invalid

`document_tools_invalid` (HTTP 400). `create_agent` and `update_agent` return it as a message that starts `document_tools_invalid: ` followed by the reason, for example `document_tools_invalid: only native agents take documentTools.` The setting is refused when:

- the agent is not a native agent (a coding agent does not take it);
- a reviewer or the final approver does not exist or cannot read the agent;
- a `plans` entry is not an agent with `planDocument`, or you cannot execute it.

Use a native agent. Share the agent with each reviewer (at least `read`) before naming them, or leave `reviewers` out to use the owner. For `plans`, name planner agents you own or can execute.

An agent that everyone can write is refused with a 409 instead: `documentTools` is an owner-only setting, so revoke or lower the everyone grant first.

Schema-level violations (`maxNewPerRun` out of range, an empty `reviewers` list, unknown fields) are refused earlier, as `Invalid create_agent/update_agent arguments: …`.

See [Documents from native agents](../native-agent-documents.md).
