---
id: errors/join-not-supported
title: Run cannot be joined (join_not_supported)
summary: Joining works on Claude Code coding runs that are not workflow runs.
audience: operator
tags: [error, join, join_run, send_to_run, join_not_supported]
appliesTo: ">=0.10.2"
---

# Run cannot be joined

`join_not_supported` (HTTP 409). This run is a Codex run, a workflow run, or a native agent run. Joining those is not supported yet.

See [Join a running coding run](../join-runs.md).
