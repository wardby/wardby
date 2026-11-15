---
id: errors/document-send-failed
title: Send to agent failed (document_send_failed)
summary: The run could not be started; no thread was marked as sent.
audience: operator
tags: [error, documents, document_send_failed]
appliesTo: ">=0.10.0"
---

# Send to agent failed

`document_send_failed` (HTTP 503). Wardby could not dispatch the coding run (executor unavailable or the run was refused at start), could not read the agent's secret values to check the task, or, for a design, could not read the design in the repository at its base ref (a board file missing, too large or unreadable; a repository with no design there yet is not an error). No thread changed state, so you can retry. If it persists, check the control plane logs and [troubleshooting](../troubleshooting/coding-workers.md).

See [Documents](../documents.md).
