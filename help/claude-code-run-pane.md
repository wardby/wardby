---
id: claude-code-run-pane
title: See your runs in Claude Code (the wardby-runs plugin)
summary: Install the wardby-runs Claude Code plugin to see your runs beside the chat, grouped by pull request, with run details and Continue locally.
audience: operator
tags: [claude code, plugin, wardby-runs, pane, claude-plugin, runs, desktop, auto mode, permissions]
appliesTo: ">=0.8.0"
---

# See your runs in Claude Code

The `wardby-runs` plugin opens a pane in Claude Code that lists your wardby
runs, grouped by pull request, and shows each run's details. It uses the
`wardby` MCP server your session already has and only reads.

Install it, and allow its read-only tools for auto mode, with:

```sh
npx @wardby/cli@latest claude-plugin install
```

Add `--server-url https://<your wardby host>/mcp` if Claude Code has no MCP
server named `wardby` yet. Or install it yourself with
`/plugin install wardby-runs --marketplace wardby/wardby`. Then run
`/wardby-runs`.

If the pane says auto mode refused a call, allow `mcp__wardby__list_runs`,
`mcp__wardby__list_agents`, `mcp__wardby__get_run` and
`mcp__wardby__get_run_transcript` in `/permissions`.

In the terminal, the pane takes clicks and sits beside the chat only in Claude
Code's fullscreen view (`"tui": "fullscreen"`); otherwise use ctrl+x tab and the
keys it shows. The desktop app needs no setting.

`wardby quickstart` offers the pane when it connects Claude Code, and
`wardby doctor` and `wardby claude-plugin status` check the setup; `wardby claude-plugin
uninstall` removes the plugin and the rules install added. To continue a run
from the pane, see `resume-runs-locally`.

To read a run's steps (each tool call and what the model said, one line each),
use `get_run_steps`; see `run-steps`.

The full guide is [Claude Code plugin](../docs/claude-code-plugin.md).
