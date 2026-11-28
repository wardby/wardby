---
id: errors/join-not-supported
title: Run cannot be joined (join_not_supported)
summary: Joining works on native agent runs and on Claude Code coding runs that are not workflow runs.
audience: operator
tags: [error, join, join_run, send_to_run, join_not_supported]
appliesTo: ">=0.11.0"
---

# Run cannot be joined

`join_not_supported` (HTTP 409). This run is a Codex or Gemini CLI coding run, or a workflow run. Joining those is not supported yet. Native agent runs (from 0.11.3) and Claude Code coding runs can be joined.

See [Join a running run](../join-runs.md).
