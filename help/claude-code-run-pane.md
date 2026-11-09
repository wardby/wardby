---
id: claude-code-run-pane
title: See your runs in Claude Code (the wardby-runs plugin)
summary: Install the wardby-runs Claude Code plugin to see your runs beside the chat, grouped by pull request, with run details and Continue locally.
audience: operator
tags: [run steps, get_run_steps, claude code, plugin, wardby-runs, pane, claude-plugin, runs, auto mode, permissions]
appliesTo: >=0.8.0
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
`mcp__wardby__list_agents`, `mcp__wardby__get_run`,
`mcp__wardby__get_run_transcript` and `mcp__wardby__get_run_steps` in
`/permissions`. Run `wardby claude-plugin install` again to add a rule a newer
pane needs.

In the terminal, the pane takes clicks and sits beside the chat only in Claude
Code's fullscreen view (`"tui": "fullscreen"`); otherwise use ctrl+x tab and the
keys it shows. The desktop app needs no setting.

`wardby quickstart` offers the pane when it connects Claude Code, and
`wardby doctor` and `wardby claude-plugin status` check the setup; `wardby claude-plugin
uninstall` removes the plugin and the rules install added. To continue a run
from the pane, see `resume-runs-locally`.

A running run's detail shows its **Recent steps** (the last 8 tool calls and
messages, one line each, wrapped in full); a finished run's shows all its
**Steps**, 200 at a time. In the list, a running or failed run shows its newest
step under its name. Against a server without `get_run_steps` the pane shows no
steps and checks again every few refreshes; with run steps off it says "Steps
are off on this server." See `run-steps`. Steps need Wardby 0.9.0 or later
on the server.

The full guide is [Claude Code plugin](../docs/claude-code-plugin.md).
