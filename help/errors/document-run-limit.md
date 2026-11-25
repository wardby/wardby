---
id: errors/document-run-limit
title: Document run limit reached (document_run_limit)
summary: A native agent's run already created as many documents as documentTools.maxNewPerRun allows.
audience: operator
tags: [error, documents, native-agents, doc_create, maxNewPerRun, document_run_limit]
appliesTo: ">=0.10.0"
---

# Document run limit reached

`document_run_limit` is returned to the agent by `doc_create` when the run has already created `documentTools.maxNewPerRun` documents (1 to 20, default 5). The count is per run and survives a resumed run.

Have the agent publish new versions of the documents it made, or raise `maxNewPerRun` with `update_agent` for later runs.

See [Documents from native agents](../native-agent-documents.md).
