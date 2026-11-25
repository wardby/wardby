---
id: errors/document-tools-invalid
title: Document tools setting invalid (document_tools_invalid)
summary: update_agent or create_agent refused documentTools because the agent is not native, a reviewer cannot read the agent, or a plan is not a planner you can run.
audience: operator
tags: [error, documents, native-agents, documentTools, document_tools_invalid]
appliesTo: ">=0.10.0"
---

# Document tools setting invalid

`document_tools_invalid` (HTTP 400). The `documentTools` setting is checked when it is saved, and refused when:

- the agent is not a native agent (a coding agent does not take it);
- a reviewer or the final approver does not exist or cannot read the agent;
- a `plans` entry is not an agent with `planDocument`, or you cannot execute it.

Use a native agent. Share the agent with each reviewer (at least `read`) before naming them, or leave `reviewers` out to use the owner. For `plans`, name planner agents you own or can execute.

An agent that everyone can write is refused with a 409 instead: `documentTools` is an owner-only setting, so revoke or lower the everyone grant first.

See [Documents from native agents](../native-agent-documents.md).
