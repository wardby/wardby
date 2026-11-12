---
id: claude-code-run-pane
title: See your runs in Claude Code (the wardby-runs plugin)
summary: Install the wardby-runs Claude Code plugin to see your runs beside the chat, grouped by pull request, with run details and Continue locally.
audience: operator
tags: [claude code version, claude update, pane opens nothing, run steps, search, filter, query, get_run_steps, get_run_text, claude code, plugin, wardby-runs, pane, auto mode]
appliesTo: >=0.8.0
---

# See your runs in Claude Code

The `wardby-runs` plugin opens a pane in Claude Code that lists your wardby
runs, grouped by pull request, and shows each run's details. It uses the
`wardby` MCP server your session already has and only reads.

The pane needs Claude Code 2.1.299 or later. On an older release
`/wardby-runs` opens nothing and says "The wardby runs pane needs Claude Code
2.1.299 or later; this is <version>", and `wardby claude-plugin install` and
`wardby doctor` warn the same way. Run `claude update`, restart Claude Code,
and run `/wardby-runs` again.

Install it, allow its read-only tools for auto mode, and switch the terminal
to the fullscreen view the side pane needs, with:

```sh
npx @wardby/cli@latest claude-plugin install --allow-tools --fullscreen
```

Fullscreen applies to every Claude Code session; leave it out if you use only
the desktop app. Without the flags, install asks about each.

Add `--server-url https://<your wardby host>/mcp` if Claude Code has no MCP
server named `wardby` yet. Or install it yourself with
`/plugin install wardby-runs --marketplace wardby/wardby`. Then run
`/wardby-runs`.

If the pane says auto mode refused a call, allow `mcp__wardby__list_runs`,
`mcp__wardby__list_agents`, `mcp__wardby__get_run`,
`mcp__wardby__get_run_transcript`, `mcp__wardby__get_run_steps` and
`mcp__wardby__get_run_text` in `/permissions`. Run `wardby claude-plugin install` again to add a rule a newer
pane needs.

The filter box first narrows the runs the pane holds: those still running and
those from the last 24 hours, matched by agent, status, trigger or task. With
Wardby 0.9.7 or later it also asks the server, and lists older runs whose id,
agent name, status, trigger, repository (any of the run's) or branch matches under **Older runs**,
with **Load more** for the next page. The server never searches task text,
since it can hold secret values.

In the terminal, the pane takes clicks and sits beside the chat only in Claude
Code's fullscreen view (`"tui": "fullscreen"`); otherwise use ctrl+x tab and the
keys it shows. The desktop app needs no setting.

`wardby quickstart` offers the pane when it connects Claude Code, and
`wardby doctor` and `wardby claude-plugin status` check the setup; `wardby claude-plugin
uninstall` removes the plugin and the rules install added. To continue a run
from the pane, see `resume-runs-locally`.

A coding run over several repositories shows one pull request line for each
repository it changed. **Continue locally** continues in your clone of the
default repository and lists each other repository with its branch (or, for a
read-only one, its commit) and a `git clone` line to copy.

A running run's detail shows its **Recent steps** (the last 8 tool calls and
messages: a ✓ or the exit code of a failed command, then the tool and its
command; what the model said wraps to about two lines); a finished run's shows all its
**Steps**, 200 at a time. In the list, a running or failed run shows its newest
step under its name. Against a server without `get_run_steps` the pane shows no
steps and checks again every few refreshes; with run steps off it says "Steps
are off on this server." See `run-steps`. Steps need Wardby 0.9.0 or later
on the server. From 0.9.0, a step with detail, or a longer message, has a ▸ at
its right that opens it; in the terminal, `j`/`k` also move between such steps
and `e` shows or hides one. An open command shows "$ command", its exit status
and its output, without Codex's framing lines. Detail appears only for the
agent's owner and the run's starter (and the stdio operator), on a server at
the detail level. An open detail shows its last 40 lines, with a count of the
lines above them.

Each section of a run's detail is a card, coloured by its kind (a bar on the
desktop, the border in the terminal). On the desktop each card, an error and an
open step's detail have a **Copy** button that copies the full text as the
server sent it, an open step's detail included in full; in the terminal, **Copy section** (`y`) copies the open
step's detail. `get_run` sends a request, task, final answer or error longer
than 8,000 characters as its first 8,000; **Show full text** and **Copy** read
the rest with `get_run_text`. A server without `get_run_text` sends every field
whole. If auto mode refuses `get_run_text`, the pane keeps the first 8,000
characters and a toast names the rule to allow.

If the pane shows `list_runs: ... exceeds maximum allowed tokens`, the day's run
list is larger than Claude Code's MCP output limit, usually because runs started
from GitHub or Jira carry long issue text. Update the server to Wardby 0.9.2 or
later: it shortens each run's task in that list and pages it, and the pane reads
the day 25 runs at a time, so the error can't come back. Only for an older
server, set `"env": { "MAX_MCP_OUTPUT_TOKENS": "100000" }` in Claude Code's
`settings.json` and restart Claude Code.

Against a server older than 0.8.0, the pane shows a notice at the top of the
list: "This wardby server is older than 0.8.0, so the pane runs in a limited
mode: no pull-request grouping, outcomes or run steps." It still lists each
agent's latest runs. Upgrade the server to 0.8.0 or later; the notice goes away
at the pane's next check.

The full guide is [Claude Code plugin](../docs/claude-code-plugin.md).
